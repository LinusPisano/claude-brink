#!/usr/bin/env node
// Brink — watchdog tests. Three layers, all in isolated temp BRINK_DIRs:
//   A. core/watchdog.js pure config/paths (in-process)
//   B. brink.js busy/idle/end marker lifecycle (real child processes; the ancestry
//      walk is stubbed via BRINK_BUSY_OVERRIDE — same seam pattern as
//      BRINK_DETECT_OVERRIDE — so the marker write is deterministic)
//   C. watchdog.ps1 -Once / -Revive against fabricated markers and a stub
//      claude.cmd that records its argv (win32 only; the daemon is win32-only in v1)
// Zero deps. Run: node tests/watchdog.test.js

const { execFileSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const { watchdogCfg, busyMarkerPath, DEFAULT_REVIVE_PROMPT } = require(path.join(SRC, 'core', 'watchdog'));

let fail = 0;
const ok = (m) => console.log('  ok:   ' + m);
const bad = (m) => { console.log('  FAIL: ' + m); fail = 1; };
const eq = (n, a, e) => (a === e ? ok(`${n} = ${JSON.stringify(e)}`)
  : bad(`${n} expected ${JSON.stringify(e)} got ${JSON.stringify(a)}`));
const truthy = (n, v) => (v ? ok(n) : bad(n));

// ---------- A. pure config ----------
console.log('A. watchdogCfg / busyMarkerPath:');
{
  const d = watchdogCfg({});
  eq('default mode', d.mode, 'off');
  eq('default poll', d.poll_seconds, 60);
  eq('default cancel window', d.cancel_window_seconds, 60);
  eq('default rate cap', d.max_revives_per_hour, 3);
  eq('default prompt', d.revive_prompt, DEFAULT_REVIVE_PROMPT);

  eq('mode ask passes', watchdogCfg({ watchdog: { mode: 'ask' } }).mode, 'ask');
  eq('mode auto passes', watchdogCfg({ watchdog: { mode: 'auto' } }).mode, 'auto');
  eq('mode AUTO (wrong case) fails closed', watchdogCfg({ watchdog: { mode: 'AUTO' } }).mode, 'off');
  eq('mode true (boolean garbage) fails closed', watchdogCfg({ watchdog: { mode: true } }).mode, 'off');

  eq('poll below floor -> default', watchdogCfg({ watchdog: { poll_seconds: 5 } }).poll_seconds, 60);
  eq('poll above ceiling -> default', watchdogCfg({ watchdog: { poll_seconds: 7200 } }).poll_seconds, 60);
  eq('poll valid passes', watchdogCfg({ watchdog: { poll_seconds: 30 } }).poll_seconds, 30);
  eq('cancel window 0 allowed', watchdogCfg({ watchdog: { cancel_window_seconds: 0 } }).cancel_window_seconds, 0);
  eq('rate cap 0 (unlimited) allowed', watchdogCfg({ watchdog: { max_revives_per_hour: 0 } }).max_revives_per_hour, 0);

  eq('prompt with leading slash -> default', watchdogCfg({ watchdog: { revive_prompt: '/compact' } }).revive_prompt, DEFAULT_REVIVE_PROMPT);
  eq('prompt with newline -> default', watchdogCfg({ watchdog: { revive_prompt: 'a\nb' } }).revive_prompt, DEFAULT_REVIVE_PROMPT);
  eq('prompt trimmed', watchdogCfg({ watchdog: { revive_prompt: '  keep going  ' } }).revive_prompt, 'keep going');

  truthy('marker path sanitizes sid', busyMarkerPath('X', 'a/b:c').endsWith('busy_a_b_c.json'));
}

// ---------- B. brink.js busy/idle/end ----------
console.log('B. busy/idle/end marker lifecycle:');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-wd-b-'));
  const brink = path.join(SRC, 'brink.js');
  const sid = 'wd-sess-1';
  const marker = busyMarkerPath(tmp, sid);
  const baseEnv = {
    ...process.env, BRINK_DIR: tmp, BRINK_SILENT: '1',
    BRINK_BUSY_OVERRIDE: JSON.stringify({ SessionPid: 4242, SessionStartTime: '2026-01-01T00:00:00.0000000+01:00' }),
    CLAUDE_PROJECT_DIR: tmp,
  };
  const run = (mode, input, env) => execFileSync('node', [brink, 'claude', mode],
    { input: JSON.stringify(input), env: env || baseEnv, encoding: 'utf8', timeout: 30000 });
  const readMarker = () => {
    const raw = fs.readFileSync(marker, 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  };

  // feature dark: no config -> busy writes nothing
  run('busy', { session_id: sid, cwd: tmp });
  eq('mode off: no marker written', fs.existsSync(marker), false);

  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ watchdog: { mode: 'ask' } }));

  // no session id -> never guess
  run('busy', { cwd: tmp });
  eq('no session_id: no marker written', fs.existsSync(marker), false);

  // first busy: full record via the override seam
  run('busy', { session_id: sid, cwd: tmp });
  truthy('busy writes the marker', fs.existsSync(marker));
  const raw = fs.readFileSync(marker, 'utf8');
  eq('marker is BOM-prefixed (PS 5.1 contract)', raw.charCodeAt(0), 0xFEFF);
  let m = readMarker();
  eq('marker sid', m.sid, sid);
  eq('marker pid', m.pid, 4242);
  eq('marker start_time', m.start_time, '2026-01-01T00:00:00.0000000+01:00');
  eq('marker proj', m.proj, tmp);
  truthy('marker session_dir under BRINK_DIR', String(m.session_dir).startsWith(tmp));
  truthy('marker records created/updated', m.created > 0 && m.updated >= m.created);

  // second busy with a DIFFERENT override pid must take the cheap refresh path
  run('busy', { session_id: sid, cwd: tmp },
    { ...baseEnv, BRINK_BUSY_OVERRIDE: JSON.stringify({ SessionPid: 9999, SessionStartTime: 'x' }) });
  m = readMarker();
  eq('refresh keeps the detected pid (no re-detect)', m.pid, 4242);

  // Stop clears unconditionally
  run('idle', { session_id: sid });
  eq('idle deletes the marker', fs.existsSync(marker), false);

  // SessionEnd: clean reasons clear, 'other' (abnormal teardown) keeps
  run('busy', { session_id: sid, cwd: tmp });
  run('end', { session_id: sid, reason: 'other' });
  eq("end reason 'other' KEEPS the marker", fs.existsSync(marker), true);
  run('end', { session_id: sid, reason: 'prompt_input_exit' });
  eq('end clean reason deletes the marker', fs.existsSync(marker), false);

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------- C. watchdog.ps1 scan/revive (win32 only) ----------
if (os.platform() !== 'win32') {
  console.log('C. watchdog.ps1: skipped (win32-only daemon, non-win32 host)');
} else {
  console.log('C. watchdog.ps1 -Once / -Revive:');
  const ps1 = path.join(SRC, 'watchdog.ps1');
  const runPs = (args, env) => spawnSync('powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...args],
    { env, encoding: 'utf8', timeout: 120000 });

  // a pid that is REALLY dead: a cmd that already exited (plus a start_time that
  // could never match a reused pid anyway)
  const deadProbe = spawnSync('cmd', ['/c', 'exit', '0']);
  const deadPid = deadProbe.pid;

  const mkSandbox = (cfg) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-wd-c-'));
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(cfg));
    const stub = path.join(tmp, 'claude.cmd');
    const argsFile = path.join(tmp, 'claude-args.txt');
    fs.writeFileSync(stub, '@echo off\r\necho %* > "' + argsFile + '"\r\nexit /b 0\r\n');
    const env = { ...process.env, BRINK_DIR: tmp, BRINK_SILENT: '1' };
    const writeMarker = (sid, pid, startTime) => {
      const sdir = path.join(tmp, 'slug', sid);
      fs.writeFileSync(busyMarkerPath(tmp, sid), '﻿' + JSON.stringify({
        sid, pid, start_time: startTime, proj: tmp, session_dir: sdir,
        claude_exe: stub, created: Math.floor(Date.now() / 1000), updated: Math.floor(Date.now() / 1000),
      }));
    };
    return { tmp, stub, argsFile, env, writeMarker };
  };

  // C1: auto mode, cancel window 0 -> dead session revives through the stub
  {
    const sb = mkSandbox({ watchdog: { mode: 'auto', cancel_window_seconds: 0 }, resume: { max_chain: 5 } });
    const sid = 'wd-dead-1';
    sb.writeMarker(sid, deadPid, '2020-01-01T00:00:00.0000000+01:00');
    const r = runPs(['-Once'], sb.env);
    eq('C1 -Once exits 0', r.status, 0);
    truthy('C1 stub claude was launched', fs.existsSync(sb.argsFile));
    if (fs.existsSync(sb.argsFile)) {
      const args = fs.readFileSync(sb.argsFile, 'utf8');
      truthy('C1 launched with --resume <sid>', args.includes('--resume') && args.includes(sid));
      truthy('C1 launched with -p', args.includes('-p'));
      truthy('C1 no skip-permissions by default', !args.includes('--dangerously-skip-permissions'));
    }
    eq('C1 marker consumed', fs.existsSync(busyMarkerPath(sb.tmp, sid)), false);
    eq('C1 chain incremented', fs.readFileSync(path.join(sb.tmp, 'chain_' + sid), 'utf8').trim(), '1');
    truthy('C1 revive_history appended', fs.existsSync(path.join(sb.tmp, 'revive_history')));
    truthy('C1 revive log written', fs.existsSync(path.join(sb.tmp, 'slug', sid, '.claude-watchdog.log')));
    fs.rmSync(sb.tmp, { recursive: true, force: true });
  }

  // C2: a LIVE pid (this very node process) is never revived
  {
    const sb = mkSandbox({ watchdog: { mode: 'auto', cancel_window_seconds: 0 } });
    const sid = 'wd-alive-1';
    sb.writeMarker(sid, process.pid, null); // no start_time -> degrades to pid-exists = alive
    const r = runPs(['-Once'], sb.env);
    eq('C2 -Once exits 0', r.status, 0);
    eq('C2 live marker survives', fs.existsSync(busyMarkerPath(sb.tmp, sid)), true);
    eq('C2 stub claude NOT launched', fs.existsSync(sb.argsFile), false);
    fs.rmSync(sb.tmp, { recursive: true, force: true });
  }

  // C3: chain cap reached -> marker dropped, no launch
  {
    const sb = mkSandbox({ watchdog: { mode: 'auto', cancel_window_seconds: 0 }, resume: { max_chain: 5 } });
    const sid = 'wd-capped-1';
    fs.writeFileSync(path.join(sb.tmp, 'chain_' + sid), '5');
    sb.writeMarker(sid, deadPid, '2020-01-01T00:00:00.0000000+01:00');
    runPs(['-Once'], sb.env);
    eq('C3 stub claude NOT launched', fs.existsSync(sb.argsFile), false);
    eq('C3 marker dropped (terminal state)', fs.existsSync(busyMarkerPath(sb.tmp, sid)), false);
    fs.rmSync(sb.tmp, { recursive: true, force: true });
  }

  // C4: ask mode -> notify-once flag, marker kept; then manual -Revive consumes it
  {
    const sb = mkSandbox({ watchdog: { mode: 'ask' }, resume: { max_chain: 5 } });
    const sid = 'wd-ask-1';
    sb.writeMarker(sid, deadPid, '2020-01-01T00:00:00.0000000+01:00');
    runPs(['-Once'], sb.env);
    eq('C4 ask keeps the marker', fs.existsSync(busyMarkerPath(sb.tmp, sid)), true);
    eq('C4 ask does NOT launch', fs.existsSync(sb.argsFile), false);
    truthy('C4 ask notify-once flag written',
      fs.readdirSync(sb.tmp).some((f) => f.startsWith('notified_watchdog_ask_')));
    const r = runPs(['-Revive', 'newest'], sb.env);
    eq('C4 manual revive exits 0', r.status, 0);
    truthy('C4 manual revive launched the stub', fs.existsSync(sb.argsFile));
    eq('C4 marker consumed by manual revive', fs.existsSync(busyMarkerPath(sb.tmp, sid)), false);
    fs.rmSync(sb.tmp, { recursive: true, force: true });
  }

  // C5: hourly rate cap -> hold (marker kept, no launch)
  {
    const sb = mkSandbox({ watchdog: { mode: 'auto', cancel_window_seconds: 0, max_revives_per_hour: 1 } });
    const sid = 'wd-rate-1';
    fs.writeFileSync(path.join(sb.tmp, 'revive_history'), String(Math.floor(Date.now() / 1000)) + '\n');
    sb.writeMarker(sid, deadPid, '2020-01-01T00:00:00.0000000+01:00');
    runPs(['-Once'], sb.env);
    eq('C5 rate-capped: no launch', fs.existsSync(sb.argsFile), false);
    eq('C5 rate-capped: marker held for later', fs.existsSync(busyMarkerPath(sb.tmp, sid)), true);
    fs.rmSync(sb.tmp, { recursive: true, force: true });
  }

  // C6: usage window at pause threshold and unreset -> hold
  {
    const sb = mkSandbox({ watchdog: { mode: 'auto', cancel_window_seconds: 0 } });
    const sid = 'wd-defer-1';
    const future = Math.floor(Date.now() / 1000) + 3600;
    fs.writeFileSync(path.join(sb.tmp, 'state.json'),
      JSON.stringify({ five_pct: 99, five_reset: future, week_pct: 10, week_reset: future + 500000 }));
    sb.writeMarker(sid, deadPid, '2020-01-01T00:00:00.0000000+01:00');
    runPs(['-Once'], sb.env);
    eq('C6 capped window: no launch', fs.existsSync(sb.argsFile), false);
    eq('C6 capped window: marker held for after reset', fs.existsSync(busyMarkerPath(sb.tmp, sid)), true);
    fs.rmSync(sb.tmp, { recursive: true, force: true });
  }

  // C7: `brink release <sid>` stops the DAEMON from reviving that session — but must not
  // consume the busy marker, or the release becomes irreversible (--undo would have
  // nothing left to restore) and the session becomes invisible to any later revive.
  // Code review 2026-08-05 finding 3 (the gate) + post-fix review 2026-08-06 (the marker).
  {
    const sb = mkSandbox({ watchdog: { mode: 'auto', cancel_window_seconds: 0 }, resume: { max_chain: 5 } });
    const sid = 'wd-released-1';
    sb.writeMarker(sid, deadPid, '2020-01-01T00:00:00.0000000+01:00');
    fs.writeFileSync(path.join(sb.tmp, 'released_' + sid), '');
    const r = runPs(['-Once'], sb.env);
    eq('C7 -Once exits 0', r.status, 0);
    eq('C7 released session NOT revived by the daemon', fs.existsSync(sb.argsFile), false);
    eq('C7 busy marker PRESERVED (release must stay undoable)', fs.existsSync(busyMarkerPath(sb.tmp, sid)), true);
    eq('C7 no chain link burned', fs.existsSync(path.join(sb.tmp, 'chain_' + sid)), false);

    // ...and an EXPLICIT `brink revive <sid>` still works on that same released session.
    // Release shields you from the daemon acting on its own; it was never meant to refuse
    // a direct instruction. Before the post-fix review this printed "Revive FAILED" and
    // deleted the marker.
    const r2 = runPs(['-Revive', sid], sb.env);
    eq('C7 explicit revive of a released session exits 0', r2.status, 0);
    truthy('C7 explicit revive DID launch claude', fs.existsSync(sb.argsFile));
    truthy('C7 explicit revive explains the release', /released/i.test((r2.stdout || '')));
    fs.rmSync(sb.tmp, { recursive: true, force: true });
  }

  // C8: the revive log must be readable DURING the revive, not locked until it ends, and
  // must survive a killed run. A single piped Add-Content held an exclusive lock for the
  // whole revive and flushed only at exit (post-fix review 2026-08-06); per-line appends
  // keep the handle closed between writes. Asserted via a slow stub: the log already has
  // the launch record and the first line while claude is still running.
  {
    const sb = mkSandbox({ watchdog: { mode: 'auto', cancel_window_seconds: 0 }, resume: { max_chain: 5 } });
    const sid = 'wd-liveLog-1';
    // Stub that prints, waits, then prints again — so there is a window to read mid-run.
    fs.writeFileSync(sb.stub, '@echo off\r\necho FIRST-LINE\r\nping -n 4 127.0.0.1 >nul\r\necho SECOND-LINE\r\nexit /b 0\r\n');
    sb.writeMarker(sid, deadPid, '2020-01-01T00:00:00.0000000+01:00');
    const rlog = path.join(sb.tmp, 'slug', sid, '.claude-watchdog.log');
    const child = spawn('powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Once'],
      { env: sb.env, stdio: 'ignore' });
    // Poll for up to ~8s for the log to become READABLE while the revive is in flight.
    const deadline = Date.now() + 8000;
    let liveRead = null;
    while (Date.now() < deadline && liveRead === null) {
      if (fs.existsSync(rlog)) {
        try { liveRead = fs.readFileSync(rlog, 'utf8'); } catch { /* locked - keep trying */ }
      }
      spawnSync('cmd', ['/c', 'ping', '-n', '2', '127.0.0.1'], { stdio: 'ignore' });
    }
    truthy('C8 revive log is readable while the revive is still running (not locked)', liveRead !== null);
    if (liveRead !== null) truthy('C8 launch record already flushed mid-run', /reviving/i.test(liveRead));
    try { child.kill(); } catch {}
    // Cleanup is best-effort here, unlike the other cases: this one deliberately leaves a
    // revive in flight, and the killed daemon's own grandchildren can still hold the temp
    // dir for a moment (EPERM). A cleanup race must not fail the assertions above.
    try { fs.rmSync(sb.tmp, { recursive: true, force: true }); } catch { /* OS will reap %TEMP% */ }
  }
}

console.log('');
if (fail) { console.log('SOME FAILED'); process.exit(1); } else { console.log('ALL PASS'); }

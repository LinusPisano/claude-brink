#!/usr/bin/env node
// Brink CLI — the one command a stranger needs. Zero deps, Node >=18.
//   brink init        wire hooks + statusline into Claude Code (wraps install.js)
//   brink off | on    kill switch (create/remove the DISABLED file)
//   brink uninstall   surgically remove Brink from settings.json (restore statusline)
//   brink doctor      self-check the whole chain: sensor -> state -> hook -> notify
//   brink watchdog    on|off|status - the revive-after-kill daemon (win32)
//   brink revive      manually revive the newest dead mid-work session
//   brink cancel      abort a pending watchdog auto-revive (inside its cancel window)
//   brink version
// Born from the 2026-07-04 launch review: the kill switch, the doctor, and a TRUE
// npm install story collapse into this file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const paths = require('./core/paths');
const { resumeCfg } = require('./core/resume');
const { resolveClaudeExe } = require('./core/claude-exe');
const { watchdogCfg } = require('./core/watchdog');

const SRC = __dirname;
const DIR = process.env.BRINK_DIR || path.join(os.homedir(), '.claude', 'brink');
const HATCH = path.join(DIR, 'DISABLED');

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const getOpt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? (argv[i + 1] || true) : d; };
const settingsPath = getOpt('--settings', path.join(os.homedir(), '.claude', 'settings.json'));

const readJson = (p) => {
  try { const r = fs.readFileSync(p, 'utf8'); return JSON.parse(r.charCodeAt(0) === 0xFEFF ? r.slice(1) : r); }
  catch { return null; }
};
const ok = (m) => console.log('  ok    ' + m);
const bad = (m) => console.log('  FAIL  ' + m);
const warn = (m) => console.log('  warn  ' + m);

// ---- init: delegate to install.js (it owns idempotency, backup, abort-on-bad-JSON) ----
function init() {
  const args = [path.join(SRC, 'install.js'), '--settings', settingsPath];
  if (!argv.includes('--no-statusline')) args.push('--statusline');
  const r = spawnSync('node', args, { encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  if (r.status !== 0) process.exit(r.status || 1);
  // Scaffold a starter config.json (never overwrites an existing one) so thresholds/
  // resume/notify are discoverable + editable without digging config.example.json out
  // of the npm install dir — the only manual step in the stranger journey (burn-in
  // finding 2026-07-06). Convenience only: init must not fail on it.
  try {
    const cfgPath = path.join(DIR, 'config.json');
    if (!fs.existsSync(cfgPath)) {
      fs.mkdirSync(DIR, { recursive: true });
      fs.copyFileSync(path.join(SRC, '..', 'config.example.json'), cfgPath);
      console.log(`Starter config written to ${cfgPath} (edit thresholds/resume/notify there).`);
    }
  } catch {}
  console.log('Brink installed. Takes effect on your next Claude Code session.');
  console.log('Verify anytime:  brink doctor    Kill switch:  brink off');
}

// ---- per-session release hatch (report 2026-07-31 defect 2) ----
// `brink off` disarms EVERY session on the machine — for a weekly pause with a
// multi-day horizon that's the difference between a surgical override and dropping
// the whole safety net for the weekend. `brink release <sid>` lifts enforcement for
// ONE session (brink.js checks released_<sid> on the pause path); the flag dies with
// the normal 14-day flag GC, or immediately via --undo.
function release() {
  const sid = argv[1];
  if (!sid || typeof sid !== 'string' || sid.startsWith('--')) {
    console.error('usage: brink release <session-id> [--undo]');
    console.error('The session id is shown in the pause message ("brink release <sid>").');
    process.exit(1);
  }
  const flag = path.join(DIR, 'released_' + paths.sanitizeSid(sid));
  if (argv.includes('--undo')) {
    try { fs.unlinkSync(flag); console.log(`Session ${sid} is protected by Brink again.`); }
    catch { console.log(`Session ${sid} was not released (no release flag found).`); }
    return;
  }
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(flag, 'created by `brink release` ' + new Date().toISOString() + '\n');
  console.log(`Session ${sid} RELEASED - Brink will not pause it (all other sessions stay protected).`);
  console.log(`Undo:  brink release ${sid} --undo`);
}

// ---- kill switch ----
function off() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(HATCH, 'created by `brink off` ' + new Date().toISOString() + '\n');
  console.log('Brink DISABLED (kill switch on). Hooks stay installed but do nothing.');
  console.log('Re-enable:  brink on');
}
function on() {
  try { fs.unlinkSync(HATCH); console.log('Brink enabled.'); }
  catch { console.log('Brink was not disabled (no kill-switch file).'); }
}

// ---- uninstall: surgical — remove ONLY Brink's entries, keep everything else ----
function uninstall() {
  const s = readJson(settingsPath);
  if (s === null) {
    console.error(`Cannot parse ${settingsPath} - nothing changed. Fix or remove it manually.`);
    process.exit(1);
  }
  const removed = [];
  for (const event of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
    const groups = (s.hooks && s.hooks[event]) || [];
    const kept = groups.filter((g) => !(g.hooks || []).some((h) => /brink\.js/.test(h.command || '')));
    if (kept.length !== groups.length) { s.hooks[event] = kept; removed.push(event); }
    if (s.hooks && Array.isArray(s.hooks[event]) && s.hooks[event].length === 0) delete s.hooks[event];
  }
  // Matches both the direct sensor wiring AND the Task-10 auto-wrap (statusline-wrap.js
  // wrapping a pre-existing custom statusLine) - either way, restore from the backup.
  if (s.statusLine && /statusline-brink\.js|statusline-wrap\.js/.test(JSON.stringify(s.statusLine))) {
    const bak = readJson(settingsPath + '.brink-bak');
    if (bak && bak.statusLine) { s.statusLine = bak.statusLine; removed.push('statusLine(restored from backup)'); }
    else { delete s.statusLine; removed.push('statusLine(removed)'); }
  }
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
  console.log(removed.length
    ? `Brink removed from ${settingsPath}: ${removed.join(', ')}`
    : `Nothing to remove - Brink was not installed in ${settingsPath}.`);
  console.log(`State dir kept at ${DIR} (delete it yourself, or run: brink uninstall --purge)`);
  if (argv.includes('--purge')) {
    try { fs.rmSync(DIR, { recursive: true, force: true }); console.log('State dir purged.'); } catch {}
  }
}

// ---- doctor: verify the WHOLE chain on THIS machine. Exists because the detached-
// PowerShell bug passed every unit test for weeks while never working in reality —
// only end-to-end, on-machine checks catch environment-dependent silent failure. ----
function doctor() {
  let fails = 0;
  const check = (name, pass, failMsg, warnOnly) => {
    if (pass) ok(name);
    else if (warnOnly) warn(name + ' - ' + failMsg);
    else { bad(name + ' - ' + failMsg); fails++; }
    return pass;
  };
  console.log(`brink doctor (v${version()}, ${os.platform()} ${os.release()}, node ${process.version})`);

  // 1. config surface
  const s = readJson(settingsPath);
  check('settings.json parses', s !== null, `cannot read/parse ${settingsPath}`);
  const hookCmds = s ? JSON.stringify(s.hooks || {}) : '';
  check('PreToolUse pause hook installed', /brink\.js\\?" claude pause|brink\.js" claude pause/.test(hookCmds) || /brink\.js/.test(hookCmds) && /pause/.test(hookCmds), 'run: brink init');
  check('PostToolUse warn hook installed', /brink\.js/.test(hookCmds) && /warn/.test(hookCmds), 'run: brink init');

  // Read state.json ONCE, up front — both the sensor-liveness check right below and
  // the diagnostic sub-checks in section 3 need the same freshness/usage numbers.
  const statePath = path.join(DIR, 'state.json');
  const state = readJson(statePath);
  const stateAgeMin = state !== null ? (Date.now() - fs.statSync(statePath).mtimeMs) / 60000 : null;
  const stateFresh = stateAgeMin !== null && stateAgeMin < 30;
  const hasUsage = state !== null && (typeof state.five_pct === 'number' || typeof state.week_pct === 'number');
  // Task 10 wraps a pre-existing custom statusLine in statusline-wrap.js instead of
  // clobbering it — that's Brink-wired too, not just the direct statusline-brink.js case.
  const statusLineWired = !!(s && s.statusLine && /statusline-brink\.js|statusline-wrap\.js|state\.json/.test(JSON.stringify(s.statusLine)));

  // Task 11: a FRESH state.json is direct, unfakeable proof the sensor is running RIGHT
  // NOW, no matter what the statusLine command string looks like. Freshness ALONE is the
  // liveness proof — NOT freshness+usage: an API-key/Bedrock setup writes a fresh
  // state.json on schedule but structurally can't report a usage% (the documented case
  // section 3 already covers with its own soft "usage data present" warn). Gating "ok" on
  // hasUsage here would hard-fail that live sensor — a NEW false-fail, the exact thing
  // this task exists to eliminate. This also kills the false-BLIND warn for a custom/
  // merged/wrapped statusLine whose sensor is provably working (the old regex-only check
  // couldn't see that and warned anyway).
  if (stateFresh) {
    check('statusline sensor wired', true, '');
  } else if (state === null) {
    // Never written yet — could just be a brand-new install with no session run so far.
    // Not a proven failure, so it's loud only when NOTHING is wired at all (nothing will
    // ever produce a state.json); softer (a prominent warn, not ok, not a fail) when the
    // statusLine IS wired and this is just "hasn't run yet". Calling warn()/bad() directly
    // here (not check()) because check() swallows failMsg entirely on a passing check —
    // this note must be visible even though it isn't a failure.
    if (statusLineWired) warn('statusline sensor wired - state.json has not been written yet - start a Claude Code session, then re-run doctor to prove the sensor is live');
    else { bad('statusline sensor wired - no Brink-aware statusLine found and no state.json - the hooks are BLIND without it (run: brink init, or merge the sensor into your custom statusline)'); fails++; }
  } else {
    // state.json EXISTS but isn't proving liveness (stale, or usage data missing) - the
    // sensor was running at some point but is NOT demonstrably running now. This must be
    // LOUD regardless of what the statusLine looks like: a silently-stopped sensor means
    // Brink will not pause the user, and a quiet warn buried that fact for weeks.
    check('statusline sensor wired', false,
      'sensor not running - state.json is ' +
      (!stateFresh ? `stale (last write ${Math.round(stateAgeMin)} min ago)` : 'missing usage data') +
      ' - Brink will NOT pause you (start a Claude session; if it persists, run brink init or merge the sensor)');
  }

  // 2. kill switch
  check('kill switch not active', !fs.existsSync(HATCH), 'DISABLED file present - run: brink on', true);

  // 3. live state freshness detail (only meaningful during/after a real session) — kept
  // as separate, softer diagnostics alongside the loud sensor-liveness verdict above.
  if (state === null) warn('state.json not written yet - start a Claude Code session, then re-run doctor');
  else {
    ok('state.json exists and parses');
    check('state is fresh (<30 min)', stateFresh, `last write ${Math.round(stateAgeMin)} min ago - no active session, or the sensor is not running`, true);
    check('usage data present', hasUsage,
      'sensor runs but rate_limits are empty - API-key/Bedrock setups may not receive usage data; Brink cannot arm', true);
  }

  // 4. end-to-end pause simulation in a sandbox (never touches your real state)
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-doctor-'));
  try {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const sbCwd = sb.replace(/\\/g, '/');
    fs.writeFileSync(path.join(sb, 'state.json'),
      JSON.stringify({ five_pct: 99, week_pct: 10, five_reset: future, week_reset: future + 500000, session_id: 'doctor', cwd: sbCwd }));
    // Pin CLAUDE_PROJECT_DIR to the sandbox cwd so brink.js's cwd resolution (and thus
    // the per-session handoff path) is deterministic no matter where `doctor` runs from
    // (e.g. inside a real Claude session that already exports CLAUDE_PROJECT_DIR).
    const env = { ...process.env, BRINK_DIR: sb, BRINK_SILENT: '1', CLAUDE_PROJECT_DIR: sbCwd };
    const r = spawnSync('node', [path.join(SRC, 'brink.js'), 'claude', 'pause'],
      { encoding: 'utf8', env, input: JSON.stringify({ cwd: sbCwd }), timeout: 15000 });
    check('pause fires at threshold (sandbox)', (r.stdout || '').includes('"permissionDecision":"deny"'), 'deny did not fire: ' + (r.stderr || r.stdout || 'no output').slice(0, 200));
    // Pre-launch hardening: the handoff no longer lands flat in the brink dir — it
    // nests under the per-session dir (core/paths). session_id='doctor' (from state.json),
    // cwd=sbCwd (pinned above), BRINK_DIR=sb.
    check('HANDOFF.md written (sandbox)', fs.existsSync(paths.handoffPath(sb, sbCwd, 'doctor')), 'handoff writer failed');
    fs.writeFileSync(path.join(sb, 'DISABLED'), '');
    const r2 = spawnSync('node', [path.join(SRC, 'brink.js'), 'claude', 'pause'], { encoding: 'utf8', env, input: '{}', timeout: 15000 });
    check('kill switch blocks the pause (sandbox)', (r2.stdout || '').trim() === '', 'DISABLED file did not stop the hook');
  } finally { try { fs.rmSync(sb, { recursive: true, force: true }); } catch {} }

  // 4b. resume-in-place terminal detection (win32 only) — read-only classification of
  // THIS doctor process's own tree; never touches a real session. Warn-only: an
  // unclassifiable terminal just means in-place resume falls back to headless.
  if (os.platform() === 'win32') {
    const det = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SRC, 'detect-terminal.ps1'), '-HookPid', String(process.pid)], { encoding: 'utf8', timeout: 15000 });
    let t = null; try { t = JSON.parse((det.stdout || '').trim()); } catch {}
    check('resume-in-place: terminal detected', !!(t && t.Terminal && t.Terminal !== 'Unknown'),
      'could not classify this terminal - in-place resume will fall back to headless', true);
  }

  // 4c. resume: claude must resolve to an absolute path (Task 8 / Task 11). Only
  // meaningful once resume is actually opted into — mirrors the same Get-Command/
  // where.exe resolution brink.js uses at arm time (core/claude-exe.js, shared so both
  // never drift). An empty resolution here means the scheduled Task Scheduler job may
  // fall through to a bare `claude` PATH lookup that fails silently at reset time.
  const rawCfg = readJson(path.join(DIR, 'config.json'));
  const rCfg = resumeCfg(rawCfg || {});
  if (rCfg.enabled && os.platform() === 'win32') {
    const claudeExe = resolveClaudeExe();
    check('claude resolves to an absolute path (resume)', !!claudeExe,
      'Get-Command/where.exe could not resolve `claude` to a .cmd path - scheduled resume may not find claude (a Task Scheduler job only sees the persistent HKCU/HKLM PATH)', true);
  }

  // 4d. watchdog (only when opted in): the busy/idle hooks must be wired and the
  // daemon actually alive — a registered task with a dead daemon is exactly the
  // silent-failure class Brink exists to catch. Warn-only: the watchdog is an
  // optional layer, its absence never breaks pause/resume.
  const wdCfg = watchdogCfg(rawCfg || {});
  if (wdCfg.mode !== 'off' && os.platform() === 'win32') {
    check('watchdog: busy/idle hooks installed', /brink\.js/.test(hookCmds) && /busy/.test(hookCmds) && /idle/.test(hookCmds),
      'run: brink init (re-wires UserPromptSubmit/Stop/SessionEnd) - without them the watchdog sees no markers', true);
    const st = spawnSync('schtasks', ['/Query', '/TN', 'BrinkWatchdog'], { encoding: 'utf8', timeout: 10000 });
    check('watchdog: logon task registered', st.status === 0, 'run: brink watchdog on', true);
    const lock = readJson(path.join(DIR, 'watchdog.lock'));
    let daemonAlive = false;
    if (lock && lock.pid) { try { process.kill(lock.pid, 0); daemonAlive = true; } catch {} }
    check('watchdog: daemon running', daemonAlive, 'run: brink watchdog on (or brink watchdog status for detail)', true);
  }

  // 5. live notification (real toast on Windows) — the step unit tests can never prove
  if (argv.includes('--no-toast') || process.env.BRINK_SILENT) warn('notification test skipped (--no-toast/BRINK_SILENT)');
  else {
    const n = spawnSync('node', [path.join(SRC, 'notify.js'), 'Brink doctor: notifications work'], { encoding: 'utf8', timeout: 15000 });
    let res = {}; try { res = JSON.parse((n.stdout || '{}').trim()); } catch {}
    const dRes = String(res.desktop || '');
    check('desktop notification fired', res.ok === true || dRes.startsWith('desktop-unsupported'),
      'notification chain failed: ' + JSON.stringify(res), dRes.startsWith('desktop-unsupported'));
    if (res.ok === true) console.log('        (a notification should be on your screen right now)');
    // When the desktop toast did NOT fire, notify.js's never-invisible fallback wrote the
    // message to its stderr - surface it so doctor SHOWS what a real pause/warn would emit
    // on this box instead of leaving the user guessing whether anything appears at all.
    else if ((n.stderr || '').trim()) console.log('        stderr fallback (this is what a pause/warn would print here): ' + n.stderr.trim());
  }

  console.log(fails ? `\n${fails} check(s) FAILED - paste this whole output into a GitHub issue.` : '\nAll critical checks passed.');
  process.exit(fails ? 1 : 0);
}

// ---- handoff: find + print the newest paused session's HANDOFF.md. Pre-launch
// hardening moved handoffs out of the user's repo to DIR/<project-slug>/<sid>/
// (core/paths.js) — this is the only way left to browse to one without knowing
// the project slug / session id by heart. ----
function findNewestHandoff() {
  let newest = null; // { path, mtimeMs }
  let slugEntries;
  try { slugEntries = fs.readdirSync(DIR, { withFileTypes: true }); } catch { return null; }
  for (const slugEnt of slugEntries) {
    if (!slugEnt.isDirectory()) continue;
    const slugDir = path.join(DIR, slugEnt.name);
    let sidEntries;
    try { sidEntries = fs.readdirSync(slugDir, { withFileTypes: true }); } catch { continue; }
    for (const sidEnt of sidEntries) {
      if (!sidEnt.isDirectory()) continue;
      const p = path.join(slugDir, sidEnt.name, 'HANDOFF.md');
      try {
        const m = fs.statSync(p).mtimeMs; // throws if this sid dir has no handoff
        if (!newest || m > newest.mtimeMs) newest = { path: p, mtimeMs: m };
      } catch {}
    }
  }
  return newest ? newest.path : null;
}
function handoff() {
  const p = findNewestHandoff();
  if (!p) {
    console.log("No handoff found - Brink hasn't paused a session yet (or it was already resumed/cleaned).");
    return;
  }
  let content;
  try {
    content = fs.readFileSync(p, 'utf8');
  } catch {
    // findNewestHandoff() found it a moment ago, but a resume firing in the meantime
    // can delete it out from under us - degrade to the same friendly message instead
    // of an ENOENT stack trace.
    console.log("No handoff found - it was just cleaned up (a resume likely just fired). Run `brink handoff` again if another session is paused.");
    return;
  }
  console.log(p);
  console.log('');
  console.log(content);
}

// ---- watchdog: the revive-after-kill daemon (win32-only, like scheduled resume).
// `on` flips config watchdog.mode + registers/starts the daemon; `off` reverses both.
// The daemon itself is src/watchdog.ps1; task/daemon plumbing is watchdog-admin.ps1.
function psFile(file, args) {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(SRC, file), ...args], { encoding: 'utf8', timeout: 60000 });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  return r.status || 0;
}
// Read-modify-write ONLY the watchdog.mode key; abort (never clobber) on a config
// that exists but won't parse — same contract install.js has for settings.json.
function setWatchdogMode(mode) {
  const cfgPath = path.join(DIR, 'config.json');
  let cfg = {};
  if (fs.existsSync(cfgPath)) {
    cfg = readJson(cfgPath);
    if (cfg === null) {
      console.error(`Cannot parse ${cfgPath} - fix it, then re-run. Nothing changed.`);
      process.exit(1);
    }
  }
  cfg.watchdog = { ...(typeof cfg.watchdog === 'object' && cfg.watchdog), mode };
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`config: watchdog.mode = "${mode}" (${cfgPath})`);
}
function watchdog() {
  const sub = argv[1] || 'status';
  if (os.platform() !== 'win32' && sub !== 'status') {
    console.error('The watchdog is Windows-only for now (Task Scheduler daemon) - like scheduled resume, other platforms are on the roadmap.');
    process.exit(1);
  }
  if (sub === 'on') {
    // --mode ask = notify-only (no auto relaunch); default auto = the full feature.
    const mode = getOpt('--mode', 'auto');
    if (mode !== 'auto' && mode !== 'ask') { console.error('--mode must be auto or ask'); process.exit(1); }
    setWatchdogMode(mode);
    process.exit(psFile('watchdog-admin.ps1', ['-Action', 'install']));
  }
  if (sub === 'off') {
    setWatchdogMode('off');
    process.exit(psFile('watchdog-admin.ps1', ['-Action', 'uninstall']));
  }
  if (sub === 'status') {
    const wd = watchdogCfg(readJson(path.join(DIR, 'config.json')) || {});
    console.log(`config: watchdog.mode = "${wd.mode}"`);
    if (os.platform() === 'win32') process.exit(psFile('watchdog-admin.ps1', ['-Action', 'status']));
    process.exit(0);
  }
  console.error(`unknown watchdog subcommand: ${sub} (use on|off|status)`);
  process.exit(1);
}
function revive() {
  // sid optional: `brink revive` = newest dead mid-work session
  const sid = argv[1] || 'newest';
  process.exit(psFile('watchdog.ps1', ['-Revive', sid]));
}
function cancel() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'watchdog_cancel'), String(Math.floor(Date.now() / 1000)) + '\n');
  console.log('Cancel requested - a pending auto-revive inside its cancel window will be aborted (single-use).');
}

function version() { return (readJson(path.join(SRC, '..', 'package.json')) || {}).version || '?'; }

function help() {
  console.log(`brink v${version()} - graceful auto-pause + handoff for Claude Code
  brink init [--no-statusline] [--settings <path>]   install hooks + sensor
  brink doctor [--no-toast]                          verify the whole chain end-to-end
  brink off | on                                     kill switch (instant disable/enable)
  brink release <session-id> [--undo]                lift the pause for ONE session only
  brink uninstall [--purge]                          remove cleanly (restores your statusline)
  brink handoff                                      print the newest paused session's HANDOFF.md
  brink watchdog on [--mode auto|ask] | off | status revive-after-kill daemon (win32)
  brink revive [<session-id>]                        revive the newest dead mid-work session now
  brink cancel                                       abort a pending auto-revive (cancel window)
  brink version`);
}

({ init, off, on, release, uninstall, doctor, handoff, watchdog, revive, cancel, version: () => console.log(version()), '--version': () => console.log(version()), help }[cmd] || (() => { console.error(`unknown command: ${cmd}`); help(); process.exit(1); }))();

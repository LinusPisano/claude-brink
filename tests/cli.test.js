#!/usr/bin/env node
// Brink — CLI tests. Hermetic: sandbox settings.json + BRINK_DIR, never the live config.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let fail = 0;
const ok = (m) => console.log('  ok:   ' + m);
const bad = (m) => { console.log('  FAIL: ' + m); fail = 1; };
const eq = (n, a, e) => (JSON.stringify(a) === JSON.stringify(e) ? ok(`${n} = ${JSON.stringify(e)}`) : bad(`${n} expected ${JSON.stringify(e)} got ${JSON.stringify(a)}`));
const truthy = (n, v) => (v ? ok(n) : bad(n + ' (was falsey)'));

const cli = path.join(__dirname, '..', 'src', 'cli.js');
const corePaths = require('../src/core/paths');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-cli-'));
const bd = path.join(dir, 'brink');
const sp = path.join(dir, 'settings.json');
const env = { ...process.env, BRINK_DIR: bd, BRINK_SILENT: '1' };
const run = (args, opts = {}) => execFileSync('node', [cli, ...args], { encoding: 'utf8', env, ...opts });
// Non-throwing variant: captures stdout + exit code even on a non-zero exit, so a
// command that legitimately exits 1 (e.g. `doctor` on a broken/failed check) produces
// a normal FAIL assertion here instead of an uncaught throw that aborts the whole
// `npm test` chain.
const runSafe = (args, opts = {}) => {
  const r = spawnSync('node', [cli, ...args], { encoding: 'utf8', env, ...opts });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
};

// seed pre-existing settings with foreign content that must survive everything
fs.writeFileSync(sp, JSON.stringify({
  model: 'opus',
  statusLine: { type: 'command', command: 'node my-custom-statusline.js' },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] },
}, null, 2));

console.log('init:');
const out = run(['init', '--settings', sp]);
truthy('init reports install', /installed/i.test(out));
let s = JSON.parse(fs.readFileSync(sp, 'utf8'));
truthy('pause hook wired', /brink\.js/.test(JSON.stringify(s.hooks.PreToolUse || [])));
truthy('warn hook wired', /brink\.js/.test(JSON.stringify(s.hooks.PostToolUse || [])));
// Task 10: a pre-existing custom statusLine is auto-WRAPPED, not clobbered - the
// wrapper (statusline-wrap.js) runs both the original command and the sensor.
truthy('statusline auto-wrapped (not clobbered)', /statusline-wrap\.js/.test(JSON.stringify(s.statusLine)));
const origB64Match = /--orig-b64\s+(\S+)/.exec(s.statusLine.command || '');
const decodedOrig = origB64Match ? Buffer.from(origB64Match[1], 'base64').toString('utf8') : null;
truthy('wrapper recorded the original custom statusline command', /my-custom-statusline\.js/.test(decodedOrig || ''));
truthy('foreign Stop hook survived', /echo stop/.test(JSON.stringify(s.hooks.Stop)));
truthy('backup of original created', fs.existsSync(sp + '.brink-bak'));

// Scaffold: init drops a starter config.json so thresholds/resume/notify are
// discoverable without digging config.example.json out of the npm dir
// (burn-in finding 2026-07-06). Re-init must never clobber user edits.
console.log('config scaffold:');
const cfgPath = path.join(bd, 'config.json');
truthy('init dropped a starter config.json', fs.existsSync(cfgPath));
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^﻿/, ''));
truthy('scaffold has thresholds + resume(off) + desktop notify',
  !!cfg.thresholds && cfg.resume && cfg.resume.enabled === false && cfg.notify && cfg.notify.desktop === true);
cfg.thresholds.five_hour = { warn: [70], pause: 90 };
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
run(['init', '--settings', sp]);
const cfg2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
truthy('re-init preserves user-edited config', cfg2.thresholds.five_hour.pause === 90);

console.log('off / on (kill switch):');
run(['off']);
truthy('DISABLED file created', fs.existsSync(path.join(bd, 'DISABLED')));
// with the hatch on, a 99% pause must do nothing
fs.writeFileSync(path.join(bd, 'state.json'), JSON.stringify({ five_pct: 99, week_pct: 10, five_reset: Math.floor(Date.now() / 1000) + 3600, session_id: 's', cwd: dir.replace(/\\/g, '/') }));
const brink = path.join(__dirname, '..', 'src', 'brink.js');
const paused = execFileSync('node', [brink, 'claude', 'pause'], { encoding: 'utf8', env, input: '{}' });
eq('hatch blocks pause end-to-end', paused.trim(), '');
run(['on']);
truthy('DISABLED file removed', !fs.existsSync(path.join(bd, 'DISABLED')));
const paused2 = execFileSync('node', [brink, 'claude', 'pause'], { encoding: 'utf8', env, input: '{}' });
truthy('pause works again after brink on', paused2.includes('"permissionDecision":"deny"'));

console.log('release (per-session hatch, report 2026-07-31):');
const rel = run(['release', 's']);
truthy('release reports the session freed', /RELEASED/.test(rel));
truthy('released_<sid> flag created', fs.existsSync(path.join(bd, 'released_s')));
// end-to-end: the released session (sid 's' via state.json fallback) passes the gate...
const pausedRel = execFileSync('node', [brink, 'claude', 'pause'], { encoding: 'utf8', env, input: '{}' });
eq('released session passes the pause gate end-to-end', pausedRel.trim(), '');
// ...while another session on the same machine is still protected.
const pausedOther = execFileSync('node', [brink, 'claude', 'pause'], { encoding: 'utf8', env, input: JSON.stringify({ session_id: 'someone-else' }) });
truthy('other sessions still paused while one is released', pausedOther.includes('"permissionDecision":"deny"'));
const relUndo = run(['release', 's', '--undo']);
truthy('release --undo reports re-protection', /protected/.test(relUndo));
truthy('released_<sid> flag removed by --undo', !fs.existsSync(path.join(bd, 'released_s')));
const pausedAfterUndo = execFileSync('node', [brink, 'claude', 'pause'], { encoding: 'utf8', env, input: '{}' });
truthy('pause enforced again after release --undo', pausedAfterUndo.includes('"permissionDecision":"deny"'));
const relNoSid = runSafe(['release']);
truthy('release without a sid exits 1 with usage', relNoSid.status === 1 && /usage: brink release/.test(relNoSid.stderr));

console.log('doctor:');
// runSafe (not run): a doctor check that fails must surface as a FAIL assertion, never
// an uncaught execFileSync throw that kills the rest of the npm test chain.
const docRes = runSafe(['doctor', '--no-toast', '--settings', sp]);
const doc = docRes.stdout;
truthy('doctor exits 0 on healthy sandbox', docRes.status === 0);
truthy('doctor passes on healthy sandbox', /All critical checks passed/.test(doc));
truthy('doctor ran the sandbox pause simulation', /pause fires at threshold/.test(doc));
truthy('doctor wrote the sandbox handoff (new per-session location)', /ok +HANDOFF\.md written \(sandbox\)/.test(doc));
truthy('doctor verified the kill switch', /kill switch blocks the pause/.test(doc));
// broken install must fail loudly with exit 1
const spBroken = path.join(dir, 'settings-empty.json');
fs.writeFileSync(spBroken, '{}');
const docBroken = runSafe(['doctor', '--no-toast', '--settings', spBroken]);
truthy('doctor exits 1 when hooks missing', docBroken.status === 1);

console.log('doctor sensor-liveness (Task 11 - kill the false-BLIND warn, get loud when actually inert):');
// Each scenario gets its own BRINK_DIR + settings.json so they can't interfere with
// each other or with the sandbox/off-on state above. Thin wrapper over runSafe (same
// non-throwing capture) — just swaps in a per-scenario BRINK_DIR via the opts env.
const runDoctorIn = (settingsFile, brinkDir) =>
  runSafe(['doctor', '--no-toast', '--settings', settingsFile],
    { env: { ...process.env, BRINK_DIR: brinkDir, BRINK_SILENT: '1' }, timeout: 30000 });
const wiredHooks = {
  PreToolUse: [{ hooks: [{ type: 'command', command: 'node brink.js claude pause' }] }],
  PostToolUse: [{ hooks: [{ type: 'command', command: 'node brink.js claude warn' }] }],
};

// (a) fresh state.json + a statusLine with NO Brink reference at all -> the sensor
// check must still be `ok` (state.json is unfakeable proof), never the BLIND warn.
const dA = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-doctor-a-'));
const spA = path.join(dA, 'settings.json');
fs.writeFileSync(spA, JSON.stringify({ statusLine: { type: 'command', command: 'node my-own-statusline.js' }, hooks: wiredHooks }, null, 2));
fs.writeFileSync(path.join(dA, 'state.json'), JSON.stringify({ five_pct: 42, week_pct: 10 }));
const rA = runDoctorIn(spA, dA);
truthy('(a) fresh state + non-Brink statusLine: sensor check is ok', /ok +statusline sensor wired/.test(rA.stdout));
truthy('(a) fresh state + non-Brink statusLine: no BLIND warn', !/BLIND/.test(rA.stdout));
fs.rmSync(dA, { recursive: true, force: true });

// (a2) REGRESSION: a FRESH state.json with NO usage numbers (the documented
// API-key/Bedrock case that structurally CANNOT report a usage%) is still a live sensor
// - it wrote a fresh file moments ago. Freshness ALONE is the liveness proof, so the
// sensor check must be `ok` and doctor must exit 0; the usage absence stays the SEPARATE
// section-3 "usage data present" soft-warn, not a duplicated hard fail. This asserts the
// gate is `if (stateFresh)`, NOT `if (stateFresh && hasUsage)` — the latter would hard-
// fail this live sensor and re-introduce the exact false-fail Task 11 exists to kill.
const dA2 = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-doctor-a2-'));
const spA2 = path.join(dA2, 'settings.json');
fs.writeFileSync(spA2, JSON.stringify({ statusLine: { type: 'command', command: 'node statusline-brink.js' }, hooks: wiredHooks }, null, 2));
fs.writeFileSync(path.join(dA2, 'state.json'), JSON.stringify({ session_id: 's' })); // fresh, but no five_pct/week_pct
const rA2 = runDoctorIn(spA2, dA2);
truthy('(a2) fresh state, NO usage: sensor check is ok (freshness alone = liveness)', /ok +statusline sensor wired/.test(rA2.stdout));
truthy('(a2) fresh state, NO usage: NOT a hard fail on the sensor line', !/FAIL +statusline sensor wired/.test(rA2.stdout));
truthy('(a2) fresh state, NO usage: doctor still exits 0', rA2.status === 0);
truthy('(a2) fresh state, NO usage: section-3 usage-data soft-warn still fires', /warn +usage data present/.test(rA2.stdout));
fs.rmSync(dA2, { recursive: true, force: true });

// (b) statusLine wrapped by Task 10's statusline-wrap.js, no state.json yet (brand-new
// install) -> recognized as Brink-wired: a soft "hasn't run yet" note, NOT the "no
// Brink-aware statusLine found" fail that an unwired install gets.
const dB = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-doctor-b-'));
const spB = path.join(dB, 'settings.json');
fs.writeFileSync(spB, JSON.stringify({ statusLine: { type: 'command', command: 'node statusline-wrap.js --orig-b64 eA==' }, hooks: wiredHooks }, null, 2));
const rB = runDoctorIn(spB, dB);
truthy('(b) wrapped statusLine (statusline-wrap.js) recognized as Brink-wired', !/no Brink-aware statusLine found/.test(rB.stdout));
truthy('(b) wrapped statusLine + never run: soft warn, not a hard fail', /warn +statusline sensor wired - state\.json has not been written yet/.test(rB.stdout));
fs.rmSync(dB, { recursive: true, force: true });

// (c) statusLine wired (direct sensor), but state.json is STALE (>30 min) -> the sensor
// silently stopped. This must be a LOUD fail (fails++ / exit 1), never a quiet warn.
const dC = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-doctor-c-'));
const spC = path.join(dC, 'settings.json');
fs.writeFileSync(spC, JSON.stringify({ statusLine: { type: 'command', command: 'node statusline-brink.js' }, hooks: wiredHooks }, null, 2));
const stateC = path.join(dC, 'state.json');
fs.writeFileSync(stateC, JSON.stringify({ five_pct: 50, week_pct: 5 }));
const staleTime = new Date(Date.now() - 60 * 60 * 1000);
fs.utimesSync(stateC, staleTime, staleTime);
const rC = runDoctorIn(spC, dC);
truthy('(c) stale state.json -> loud FAIL, not a quiet warn', /FAIL +statusline sensor wired/.test(rC.stdout));
truthy('(c) stale state.json -> message says Brink will NOT pause you', /will NOT pause you/.test(rC.stdout));
truthy('(c) stale state.json -> doctor exits 1', rC.status === 1);
fs.rmSync(dC, { recursive: true, force: true });

// (d) resume enabled -> doctor also checks that `claude` resolves to an absolute path
// (Task 8's Get-Command/where.exe resolution, mirrored via core/claude-exe.js).
if (os.platform() === 'win32') {
  const dD = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-doctor-d-'));
  const spD = path.join(dD, 'settings.json');
  fs.writeFileSync(spD, JSON.stringify({ statusLine: { type: 'command', command: 'node statusline-brink.js' }, hooks: wiredHooks }, null, 2));
  fs.writeFileSync(path.join(dD, 'state.json'), JSON.stringify({ five_pct: 10, week_pct: 5 }));
  fs.writeFileSync(path.join(dD, 'config.json'), JSON.stringify({ resume: { enabled: true } }, null, 2));
  const rD = runDoctorIn(spD, dD);
  truthy('(d) resume enabled: doctor runs the claude-resolves check', /claude resolves to an absolute path/.test(rD.stdout));
  fs.rmSync(dD, { recursive: true, force: true });
}

console.log('uninstall:');
const un = run(['uninstall', '--settings', sp]);
truthy('uninstall reports removals', /PreToolUse/.test(un) && /PostToolUse/.test(un));
s = JSON.parse(fs.readFileSync(sp, 'utf8'));
truthy('brink hooks gone', !/brink\.js/.test(JSON.stringify(s.hooks || {})));
truthy('custom statusline RESTORED from backup', /my-custom-statusline\.js/.test(JSON.stringify(s.statusLine)));
truthy('foreign Stop hook still intact', /echo stop/.test(JSON.stringify(s.hooks.Stop)));
truthy('foreign model key still intact', s.model === 'opus');
const un2 = run(['uninstall', '--settings', sp]);
truthy('second uninstall is a clean no-op', /Nothing to remove/.test(un2));

console.log('handoff:');
// Own BRINK_DIR, deliberately NOT `bd` — the off/on block above already ran a real
// `brink.js claude pause` against bd (env pinned BRINK_DIR=bd), which genuinely writes a
// HANDOFF.md into bd's session-dir tree. Reusing bd here would make the "no handoff yet"
// case flaky/false depending on test order, so seed a fresh, isolated dir instead.
const hoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-cli-handoff-'));
const hoEnv = { ...process.env, BRINK_DIR: hoDir, BRINK_SILENT: '1' };
const runHo = (args) => execFileSync('node', [cli, ...args], { encoding: 'utf8', env: hoEnv });

const noHandoff = runHo(['handoff']);
truthy('no handoff found - friendly message', /No handoff found/.test(noHandoff));
truthy('no handoff found - mentions never paused / already cleaned', /paused|resumed|cleaned/.test(noHandoff));

// seed two session-dir handoffs (core/paths layout: <hoDir>/<project-slug>/<sid>/HANDOFF.md)
// with distinct, explicit mtimes so "newest wins" is deterministic rather than racing the
// filesystem's write-time clock resolution.
const oldHandoff = corePaths.handoffPath(hoDir, dir, 'sid-old');
const newHandoff = corePaths.handoffPath(hoDir, dir, 'sid-new');
fs.mkdirSync(path.dirname(oldHandoff), { recursive: true });
fs.mkdirSync(path.dirname(newHandoff), { recursive: true });
fs.writeFileSync(oldHandoff, '# OLD HANDOFF\nstale content\n');
fs.writeFileSync(newHandoff, '# NEW HANDOFF\nfresh content\n');
const past = new Date(Date.now() - 60 * 60 * 1000);
const now = new Date();
fs.utimesSync(oldHandoff, past, past);
fs.utimesSync(newHandoff, now, now);

const handoffOut = runHo(['handoff']);
truthy('prints the newest handoff\'s absolute path', handoffOut.includes(newHandoff));
truthy('prints the newest handoff\'s contents', /NEW HANDOFF/.test(handoffOut));
truthy('does not print the older handoff\'s contents', !/OLD HANDOFF/.test(handoffOut));
fs.rmSync(hoDir, { recursive: true, force: true });

console.log('version/help:');
truthy('help lists handoff command', /brink handoff/.test(run(['help'])));
truthy('version prints semver', /^\d+\.\d+\.\d+/.test(run(['version']).trim()));
let unknownFails = false;
try { run(['bogus']); } catch (e) { unknownFails = e.status === 1; }
truthy('unknown command exits 1', unknownFails);

fs.rmSync(dir, { recursive: true, force: true });
console.log('');
if (fail) { console.log('SOME FAILED'); process.exit(1); } else { console.log('ALL PASS'); }

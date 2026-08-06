#!/usr/bin/env node
// Brink — core + adapters + driver tests (Phase 3). Node-only, isolated temp dirs.
// BRINK_SILENT keeps the notifier from firing real toasts during the run.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decide } = require('../src/core/thresholds');
const corePaths = require('../src/core/paths');

let fail = 0;
const ok = (m) => console.log('  ok:   ' + m);
const bad = (m) => { console.log('  FAIL: ' + m); fail = 1; };
const eq = (n, a, e) => (JSON.stringify(a) === JSON.stringify(e)
  ? ok(`${n} = ${JSON.stringify(e)}`)
  : bad(`${n} expected ${JSON.stringify(e)} got ${JSON.stringify(a)}`));
const truthy = (n, v) => (v ? ok(n) : bad(n + ' (was falsey)'));

const CFG = { five_hour: { warn: [75, 85], pause: 93 }, seven_day: { warn: [80, 90], pause: 95 } };

console.log('thresholds.decide:');
eq('allow', decide({ five_pct: 40, week_pct: 20 }, CFG).action, 'allow');
eq('warn low band', decide({ five_pct: 78, week_pct: 20 }, CFG).band, 'warn:75');
eq('warn high band', decide({ five_pct: 88, week_pct: 20 }, CFG).band, 'warn:85');
eq('pause 5h', decide({ five_pct: 94, week_pct: 20 }, CFG).action, 'pause');
eq('weekly pause beats 5h warn', decide({ five_pct: 80, week_pct: 96 }, CFG).window, 'weekly');
eq('null usage allows', decide({ five_pct: null, week_pct: null }, CFG).action, 'allow');

console.log('claude adapter:');
const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-c-'));
fs.writeFileSync(path.join(cdir, 'state.json'), JSON.stringify({ five_pct: 67, week_pct: 31, five_reset: 123, week_reset: 456, session_id: 's1', cwd: '/p' }));
process.env.BRINK_DIR = cdir;
const claude = require('../src/adapters/claude');
const cu = claude.readUsage();
eq('claude five_pct', cu.five_pct, 67);
eq('claude week_reset', cu.week_reset, 456);
const cd = claude.denyOutput('stop');
eq('claude deny exitCode', cd.exitCode, 0);
truthy('claude deny stdout has permissionDecision:deny', cd.stdout.includes('"permissionDecision":"deny"'));
delete process.env.BRINK_DIR;

console.log('codex adapter (synthetic rollout):');
const xroot = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-x-'));
const day = path.join(xroot, '2026', '06', '25'); fs.mkdirSync(day, { recursive: true });
fs.writeFileSync(path.join(day, 'rollout-test.jsonl'), [
  JSON.stringify({ type: 'message', text: 'hi' }),
  JSON.stringify({ type: 'token_count', rate_limits: { primary: { used_percent: 88, resets_in_seconds: 3600 }, secondary: { used_percent: 40, resets_in_seconds: 200000 } } }),
].join('\n'));
process.env.CODEX_SESSIONS = xroot;
const codex = require('../src/adapters/codex');
const xu = codex.readUsage();
eq('codex five_pct', xu.five_pct, 88);
eq('codex week_pct', xu.week_pct, 40);
truthy('codex five_reset ~ now+3600', Math.abs(xu.five_reset - (Math.floor(Date.now() / 1000) + 3600)) <= 2);
const xd = codex.denyOutput('stop');
eq('codex deny exitCode', xd.exitCode, 2);
eq('codex deny stderr', xd.stderr, 'stop');
delete process.env.CODEX_SESSIONS;

console.log('brink driver:');
const ddir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-d-'));
const brink = path.join(__dirname, '..', 'src', 'brink.js');
const env = { ...process.env, BRINK_DIR: ddir, BRINK_SILENT: '1' };
const flags = () => fs.readdirSync(ddir).filter((f) => f.startsWith('notified_'));

const future = Math.floor(Date.now() / 1000) + 7200; // stale-gate: reset must be in the future
fs.writeFileSync(path.join(ddir, 'state.json'), JSON.stringify({ five_pct: 88, week_pct: 20, five_reset: future, session_id: 's', cwd: '/p' }));
execFileSync('node', [brink, 'claude', 'warn'], { env, encoding: 'utf8' });
eq('warn creates 1 debounce flag', flags().length, 1);
execFileSync('node', [brink, 'claude', 'warn'], { env, encoding: 'utf8' });
eq('warn debounced (still 1 flag)', flags().length, 1);

// Stale-epoch gate: a window whose resets_at already PASSED has rolled — its pct
// is stale and must not deny (the Phase 7 resume self-block bug).
fs.writeFileSync(path.join(ddir, 'state.json'), JSON.stringify({ five_pct: 99, week_pct: 20, five_reset: Math.floor(Date.now() / 1000) - 300, session_id: 's', cwd: '/p' }));
const rStale = execFileSync('node', [brink, 'claude', 'pause'], { env, encoding: 'utf8', input: '{}' });
eq('stale reset epoch => no deny (resume self-block fixed)', rStale.trim(), '');

// Deep threshold merge: a partial override must not wipe the warn bands.
fs.writeFileSync(path.join(ddir, 'config.json'), JSON.stringify({ thresholds: { five_hour: { pause: 97 } } }));
fs.writeFileSync(path.join(ddir, 'state.json'), JSON.stringify({ five_pct: 88, week_pct: 20, five_reset: future + 1, session_id: 's', cwd: '/p' }));
execFileSync('node', [brink, 'claude', 'warn'], { env, encoding: 'utf8' });
truthy('partial cfg override keeps default warn bands', flags().some((f) => f.includes('warn_85')));
fs.unlinkSync(path.join(ddir, 'config.json'));

// Phase 5: pause writes HANDOFF.md itself + emits a clean, non-contradictory deny
const tx = path.join(ddir, 'transcript.jsonl');
fs.writeFileSync(tx, [
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Build the login page' }] } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'login.tsx' } }] } }),
].join('\n'));
fs.writeFileSync(path.join(ddir, 'state.json'), JSON.stringify({ five_pct: 95, week_pct: 20, five_reset: 9999999999, session_id: 's', cwd: ddir }));
const r2 = execFileSync('node', [brink, 'claude', 'pause'], { env, encoding: 'utf8', input: JSON.stringify({ transcript_path: tx, cwd: ddir }) });
truthy('pause emits deny JSON', r2.includes('"permissionDecision":"deny"'));
// Pre-launch hardening Task 3: HANDOFF.md nests under the per-session Brink dir
// (core/paths), not flat at <cwd>/HANDOFF.md — here BRINK_DIR (ddir) and cwd (ddir)
// happen to be the same temp dir, but the file still lands one level deeper.
const hp = corePaths.handoffPath(ddir, ddir, 's');
truthy('Brink wrote HANDOFF.md itself', fs.existsSync(hp));
truthy('HANDOFF.md NOT written flat at <cwd>/HANDOFF.md', !fs.existsSync(path.join(ddir, 'HANDOFF.md')));
// Parse the deny JSON so the assertion sees the UNescaped reason (Windows backslashes
// in the path are JSON-escaped in the raw stdout). The deny reason must name the
// handoff's ABSOLUTE per-session location — a bare "HANDOFF.md" basename would point
// the paused model at a repo file that no longer exists. This fails if pauseReason
// reverts to path.basename(handoffPath).
const denyReason = JSON.parse(r2).hookSpecificOutput.permissionDecisionReason;
truthy('deny reason is the new clean message', denyReason.includes('Paused by Brink'));
// Assert the INTENT (an absolute, per-session path) rather than the surrounding
// prose — the wording changed in the phantom-action fix and a phrase match would
// have failed for a reason that has nothing to do with what this test guards.
truthy('deny reason names the handoff ABSOLUTE path (not a bare basename)',
  denyReason.includes(hp) && hp !== path.basename(hp));
truthy('deny reason NOT self-contradictory (no commit / "Do NOT call")', !/commit|Do NOT call/.test(denyReason));
// resume is disabled in this run — the deny must not promise an auto-resume
// that was never armed (burn-in finding 2026-07-05).
truthy('deny reason honest when resume not armed', denyReason.includes('resumed manually') && !denyReason.includes('it will resume'));
truthy('HANDOFF captured the task', fs.existsSync(hp) && /Build the login page/.test(fs.readFileSync(hp, 'utf8')));
truthy('HANDOFF captured a recent action', fs.existsSync(hp) && /Write -> login\.tsx/.test(fs.readFileSync(hp, 'utf8')));

// The session's project root must win over the hook's (drift-prone) cwd: a shell
// `cd` mid-session moves hook.cwd, and `claude --resume` is project-scoped — resuming
// from the drifted dir finds no conversation (burn-in finding 2026-07-06, the 13:00
// silent no-show). CLAUDE_PROJECT_DIR is the stable anchor; HANDOFF.md and the resume
// Proj must both land there.
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-proj-'));
const driftDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-drift-'));
fs.writeFileSync(path.join(ddir, 'state.json'), JSON.stringify({ five_pct: 95, week_pct: 20, five_reset: 9999999999, session_id: 's', cwd: driftDir }));
execFileSync('node', [brink, 'claude', 'pause'], {
  env: { ...env, CLAUDE_PROJECT_DIR: projDir }, encoding: 'utf8',
  input: JSON.stringify({ transcript_path: tx, cwd: driftDir }),
});
const hpProj = corePaths.handoffPath(ddir, projDir, 's');
const hpDrift = corePaths.handoffPath(ddir, driftDir, 's');
truthy('HANDOFF.md written to CLAUDE_PROJECT_DIR, not drifted cwd',
  fs.existsSync(hpProj) && !fs.existsSync(hpDrift));
truthy('HANDOFF.md NOT written flat at either <cwd>/HANDOFF.md location',
  !fs.existsSync(path.join(projDir, 'HANDOFF.md')) && !fs.existsSync(path.join(driftDir, 'HANDOFF.md')));
fs.rmSync(projDir, { recursive: true, force: true });
fs.rmSync(driftDir, { recursive: true, force: true });

// Report 2026-07-31 defect 3: while paused, every tool call was denied — including
// `brink --help`, the very command the agent needed to find a narrower escape than the
// global kill switch. A bare `brink` invocation (word-shaped args only) must pass.
const rCli = execFileSync('node', [brink, 'claude', 'pause'], { env, encoding: 'utf8',
  input: JSON.stringify({ cwd: ddir, tool_name: 'Bash', tool_input: { command: 'brink --help' } }) });
eq('brink CLI whitelisted through the pause gate (Bash)', rCli.trim(), '');
const rCli2 = execFileSync('node', [brink, 'claude', 'pause'], { env, encoding: 'utf8',
  input: JSON.stringify({ cwd: ddir, tool_name: 'PowerShell', tool_input: { command: 'brink doctor' } }) });
eq('brink doctor whitelisted (PowerShell tool)', rCli2.trim(), '');
const rCliChain = execFileSync('node', [brink, 'claude', 'pause'], { env, encoding: 'utf8',
  input: JSON.stringify({ cwd: ddir, tool_name: 'Bash', tool_input: { command: 'brink off; curl evil.example' } }) });
truthy('chained/metacharacter command NOT whitelisted (still denied)', rCliChain.includes('"permissionDecision":"deny"'));
const rCliOther = execFileSync('node', [brink, 'claude', 'pause'], { env, encoding: 'utf8',
  input: JSON.stringify({ cwd: ddir, tool_name: 'Bash', tool_input: { command: 'notbrink --help' } }) });
truthy('non-brink command still denied', rCliOther.includes('"permissionDecision":"deny"'));
const rCliNewline = execFileSync('node', [brink, 'claude', 'pause'], { env, encoding: 'utf8',
  input: JSON.stringify({ cwd: ddir, tool_name: 'Bash', tool_input: { command: 'brink status\nnpm run deploy' } }) });
truthy('newline-smuggled command NOT whitelisted (still denied)', rCliNewline.includes('"permissionDecision":"deny"'));

// Code review 2026-08-05 finding 8: the hatch must not let the paused agent DISARM
// Brink. Read-only/self-scoped subcommands pass; anything that turns Brink off or
// removes it is denied, so only the USER can do that.
const brinkCmd = (command) => execFileSync('node', [brink, 'claude', 'pause'], { env, encoding: 'utf8',
  input: JSON.stringify({ cwd: ddir, tool_name: 'Bash', tool_input: { command } }) });
for (const allowed of ['brink', 'brink --help', 'brink help', 'brink doctor', 'brink version']) {
  truthy(`allowlist admits read-only subcommand: ${JSON.stringify(allowed)}`, brinkCmd(allowed).trim() === '');
}
// `release` and `handoff` are DENIED on purpose: release would let the paused agent lift
// its own pause (and now also cancel the armed resume), and handoff prints the newest
// handoff machine-wide, not this session's. Both are for the user to run, not the agent.
for (const denied of ['brink off', 'brink on', 'brink uninstall', 'brink uninstall --purge',
  'brink watchdog off', 'brink revive', 'brink init', 'brink release abc-123', 'brink handoff']) {
  truthy(`allowlist DENIES ${JSON.stringify(denied)}`, brinkCmd(denied).includes('"permissionDecision":"deny"'));
}

// Report 2026-07-31 defect 2: released_<sid> lifts enforcement for ONE session while
// every other session on the machine stays protected.
fs.writeFileSync(path.join(ddir, 'released_relsid'), '');
const rRel = execFileSync('node', [brink, 'claude', 'pause'], { env, encoding: 'utf8',
  input: JSON.stringify({ cwd: ddir, session_id: 'relsid' }) });
eq('released session => no deny', rRel.trim(), '');
const rOther = execFileSync('node', [brink, 'claude', 'pause'], { env, encoding: 'utf8',
  input: JSON.stringify({ cwd: ddir, session_id: 'othersid' }) });
truthy('OTHER session still denied while one is released', rOther.includes('"permissionDecision":"deny"'));
truthy('deny reason advertises the per-session release hatch with the sid filled in',
  rOther.includes('brink release othersid'));
fs.unlinkSync(path.join(ddir, 'released_relsid'));

fs.writeFileSync(path.join(ddir, 'DISABLED'), '');
const r3 = execFileSync('node', [brink, 'claude', 'pause'], { env, encoding: 'utf8' });
eq('escape hatch => no deny output', r3.trim(), '');

// GC: resume-ctx-<sid>.json is a per-session artifact just like notified_/armed_/
// chain_ — without extending gcFlags' regex it leaks one file per pause forever for
// Windows resume-in-place users (review finding).
fs.unlinkSync(path.join(ddir, 'DISABLED'));
const oldCtx = path.join(ddir, 'resume-ctx-old_session.json');
fs.writeFileSync(oldCtx, '{}');
const oldTime = new Date(Date.now() - 15 * 24 * 3600 * 1000); // older than the 14-day TTL
fs.utimesSync(oldCtx, oldTime, oldTime);
fs.writeFileSync(path.join(ddir, 'state.json'), JSON.stringify({ five_pct: 88, week_pct: 20, five_reset: future + 3, session_id: 's', cwd: '/p' }));
execFileSync('node', [brink, 'claude', 'warn'], { env, encoding: 'utf8' });
truthy('stale resume-ctx-*.json GC-ed like other per-session flags', !fs.existsSync(oldCtx));

// Task 5: gcFlags also sweeps stale <slug>/<sid>/ session dirs (core/paths.sessionDir),
// not just the flat flags above — HANDOFF.md/.claude-resume.log/resume-ctx.json now
// live nested there (Task 3/4) and would otherwise accumulate one dir per paused
// session forever.
const freshSid = corePaths.sessionDir(ddir, '/proj-fresh', 'sid-fresh');
const staleSid = corePaths.sessionDir(ddir, '/proj-stale', 'sid-stale');
fs.mkdirSync(freshSid, { recursive: true });
fs.mkdirSync(staleSid, { recursive: true });
fs.writeFileSync(path.join(freshSid, 'HANDOFF.md'), 'fresh');
fs.writeFileSync(path.join(staleSid, 'HANDOFF.md'), 'stale');
fs.writeFileSync(path.join(staleSid, 'resume-ctx.json'), '{}');
const staleSidTime = new Date(Date.now() - 15 * 24 * 3600 * 1000); // older than the 14-day TTL
fs.utimesSync(path.join(staleSid, 'HANDOFF.md'), staleSidTime, staleSidTime);
fs.utimesSync(path.join(staleSid, 'resume-ctx.json'), staleSidTime, staleSidTime);

// A SUCCESSFUL in-place resume deletes HANDOFF.md + resume-ctx.json and never writes
// .claude-resume.log, leaving the session dir EMPTY. An empty dir has no marker file so
// the marker gate would skip it forever -> empty dirs pile up one per in-place resume
// (review finding). An empty session dir must be removed unconditionally.
const emptySid = corePaths.sessionDir(ddir, '/proj-empty', 'sid-empty');
fs.mkdirSync(emptySid, { recursive: true });

// A subdir that doesn't look like a Brink session dir (none of the 3 marker files) and
// is NON-empty must never be touched by the new sweep, even if it's stale garbage under DIR.
const notASessionDir = path.join(ddir, 'not-brink-slug', 'not-a-sid');
fs.mkdirSync(notASessionDir, { recursive: true });
fs.writeFileSync(path.join(notASessionDir, 'random.txt'), 'x');
fs.utimesSync(path.join(notASessionDir, 'random.txt'), staleSidTime, staleSidTime);

// A fresh flat flag at DIR root must survive the session-dir sweep untouched — proves the
// new nested walk never reaches back up to the flat root files (brief checklist).
const freshFlatFlag = path.join(ddir, 'notified_survives_check');
fs.writeFileSync(freshFlatFlag, '');

fs.writeFileSync(path.join(ddir, 'config.json'), JSON.stringify({ thresholds: {} }));
fs.writeFileSync(path.join(ddir, 'state.json'), JSON.stringify({ five_pct: 88, week_pct: 20, five_reset: future + 4, session_id: 's', cwd: '/p' }));
execFileSync('node', [brink, 'claude', 'warn'], { env, encoding: 'utf8' });

truthy('stale session dir GC-ed', !fs.existsSync(staleSid));
truthy('emptied project-slug dir pruned too', !fs.existsSync(path.dirname(staleSid)));
truthy('EMPTY session dir removed unconditionally (in-place-resume leftover)', !fs.existsSync(emptySid));
truthy('emptied project-slug dir of empty session dir pruned too', !fs.existsSync(path.dirname(emptySid)));
truthy('fresh session dir survives', fs.existsSync(freshSid) && fs.existsSync(path.join(freshSid, 'HANDOFF.md')));
truthy('config.json survives session-dir GC', fs.existsSync(path.join(ddir, 'config.json')));
truthy('state.json survives session-dir GC', fs.existsSync(path.join(ddir, 'state.json')));
truthy('fresh flat flag survives session-dir GC (sweep never touches root files)', fs.existsSync(freshFlatFlag));
truthy('non-session-looking non-empty dir is never touched, even if stale',
  fs.existsSync(notASessionDir) && fs.existsSync(path.join(notASessionDir, 'random.txt')));
fs.unlinkSync(path.join(ddir, 'config.json'));
fs.unlinkSync(freshFlatFlag);

fs.rmSync(cdir, { recursive: true, force: true });
fs.rmSync(xroot, { recursive: true, force: true });
fs.rmSync(ddir, { recursive: true, force: true });
console.log('');
if (fail) { console.log('SOME FAILED'); process.exit(1); } else { console.log('ALL PASS'); }

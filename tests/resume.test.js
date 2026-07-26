#!/usr/bin/env node
// Brink — resume arming logic tests (Phase 7). Node-only, pure (no scheduler touched).
const { resumeCfg, shouldArm, armArgs, pauseReason, DEFAULT_RESUME, DEFAULT_CONTINUE } = require('../src/core/resume');

let fail = 0;
const ok = (m) => console.log('  ok:   ' + m);
const bad = (m) => { console.log('  FAIL: ' + m); fail = 1; };
const eq = (n, a, e) => (JSON.stringify(a) === JSON.stringify(e)
  ? ok(`${n} = ${JSON.stringify(e)}`)
  : bad(`${n} expected ${JSON.stringify(e)} got ${JSON.stringify(a)}`));
const truthy = (n, v) => (v ? ok(n) : bad(n + ' (was falsey)'));

const CTX = { session_id: 'sess-1', reset: 1000000000, proj: 'C:/proj' };

console.log('resumeCfg defaults / coercion:');
eq('empty => defaults', resumeCfg({}), DEFAULT_RESUME);
eq('enabled coerced to bool', resumeCfg({ resume: { enabled: 'yes' } }).enabled, false);
eq('buffer clamps negative to default', resumeCfg({ resume: { buffer_seconds: -5 } }).buffer_seconds, 90);
eq('buffer floored', resumeCfg({ resume: { buffer_seconds: 120.9 } }).buffer_seconds, 120);
eq('skip coerced', resumeCfg({ resume: { skip_permissions: 1 } }).skip_permissions, false);
eq('max_chain default 5', resumeCfg({}).max_chain, 5);
eq('max_chain 0 = unlimited accepted', resumeCfg({ resume: { max_chain: 0 } }).max_chain, 0);
eq('max_chain negative clamps to default', resumeCfg({ resume: { max_chain: -2 } }).max_chain, 5);
eq('in_place default true', resumeCfg({}).in_place, true);
eq('in_place coerced to bool', resumeCfg({ resume: { in_place: 'no' } }).in_place, false);
eq('continue_prompt default is a non-empty string', typeof resumeCfg({}).continue_prompt === 'string' && resumeCfg({}).continue_prompt.length > 0, true);
eq('continue_prompt override kept', resumeCfg({ resume: { continue_prompt: 'go on' } }).continue_prompt, 'go on');
eq('continue_prompt rejects leading special char (falls back to default)', /^[\/!@#]/.test(resumeCfg({ resume: { continue_prompt: '/compact' } }).continue_prompt), false);

// ASCII-only default (pre-launch hardening Task 7): resume-ctx.json used to be written
// UTF-8 without a BOM, and PowerShell 5.1's ANSI-decode of a BOM-less file mangled a
// non-ASCII char here (an em-dash) before it reached the injected continue-prompt.
// brink.js now writes the ctx UTF-8-WITH-BOM (fixing the general case), but the DEFAULT
// itself stays plain ASCII so the common (unconfigured) path never depends on that.
truthy('DEFAULT_CONTINUE is ASCII-only', /^[\x00-\x7F]*$/.test(DEFAULT_CONTINUE));
eq('DEFAULT_CONTINUE is the resumeCfg default continue_prompt', DEFAULT_RESUME.continue_prompt, DEFAULT_CONTINUE);

// Chain cap: an unattended pause->resume->pause loop must not burn windows forever.
console.log('chainAllowed:');
const { chainAllowed } = require('../src/core/resume');
eq('under cap => allowed', chainAllowed({ resume: { max_chain: 3 } }, 2), true);
eq('at cap => blocked', chainAllowed({ resume: { max_chain: 3 } }, 3), false);
eq('0 = unlimited', chainAllowed({ resume: { max_chain: 0 } }, 999), true);
eq('default cap blocks at 5', chainAllowed({}, 5), false);
eq('garbage count treated as 0', chainAllowed({}, NaN), true);

console.log('shouldArm:');
eq('disabled by default => false', shouldArm({}, CTX, 'win32'), false);
eq('enabled on win32 => true', shouldArm({ resume: { enabled: true } }, CTX, 'win32'), true);
eq('enabled but non-windows => false', shouldArm({ resume: { enabled: true } }, CTX, 'darwin'), false);
eq('no session id => false', shouldArm({ resume: { enabled: true } }, { reset: 123 }, 'win32'), false);
eq('no reset epoch => false', shouldArm({ resume: { enabled: true } }, { session_id: 's' }, 'win32'), false);
eq('non-finite reset => false', shouldArm({ resume: { enabled: true } }, { session_id: 's', reset: Infinity }, 'win32'), false);

console.log('armArgs:');
const args = armArgs({ resume: { enabled: true, buffer_seconds: 60, skip_permissions: true } }, CTX);
truthy('passes -ResetsAt epoch', args[args.indexOf('-ResetsAt') + 1] === '1000000000');
truthy('passes -Sid', args[args.indexOf('-Sid') + 1] === 'sess-1');
truthy('passes -Proj', args[args.indexOf('-Proj') + 1] === 'C:/proj');
truthy('passes -Buffer from cfg', args[args.indexOf('-Buffer') + 1] === '60');
truthy('passes -Skip=1 when skip_permissions', args[args.indexOf('-Skip') + 1] === '1');
truthy('-Skip=0 by default', armArgs({ resume: { enabled: true } }, CTX)[
  armArgs({ resume: { enabled: true } }, CTX).indexOf('-Skip') + 1] === '0');
truthy('all args are strings', args.every((a) => typeof a === 'string'));
truthy('passes -ClaudeExe empty by default (no ctx.claude_exe)', args[args.indexOf('-ClaudeExe') + 1] === '');
const withExe = armArgs({ resume: { enabled: true } }, { ...CTX, claude_exe: 'C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd' });
truthy('passes -ClaudeExe when ctx.claude_exe is set', withExe[withExe.indexOf('-ClaudeExe') + 1] === 'C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd');

// Trailing (back)slash in proj would escape the scheduled task's quoted -Argument
const slashed = armArgs({ resume: { enabled: true } }, { ...CTX, proj: 'C:\\proj\\sub\\' });
truthy('trailing backslash stripped from -Proj', slashed[slashed.indexOf('-Proj') + 1] === 'C:\\proj\\sub');
const fwd = armArgs({ resume: { enabled: true } }, { ...CTX, proj: 'C:/proj/' });
truthy('trailing forward slash stripped from -Proj', fwd[fwd.indexOf('-Proj') + 1] === 'C:/proj');

// The deny reason must reflect what Brink actually DID: promising "it will resume"
// with nothing armed sends the user away expecting work that never happens
// (burn-in finding 2026-07-05 — the 03:10 no-show).
console.log('pauseReason:');
const base = { pct: 93.4, window: 'five-hour', resetText: '03:10', file: 'HANDOFF.md' };
const armedMsg = pauseReason({ ...base, armed: true });
truthy('armed: says an auto-resume is scheduled', armedMsg.includes('scheduled an auto-resume'));
truthy('armed: rounds pct', armedMsg.includes('93%'));
truthy('armed: names the handoff file', armedMsg.includes('HANDOFF.md'));
const unarmedMsg = pauseReason({ ...base, armed: false });
truthy('unarmed: never promises a resume', !unarmedMsg.includes('scheduled an auto-resume') && !unarmedMsg.includes('it will resume'));
truthy('unarmed: tells the model the user must resume manually', unarmedMsg.includes('resumed manually'));
truthy('no file: no save claim', !/saved/.test(pauseReason({ ...base, file: '', armed: false })));
truthy('no resetText: no dangling reset clause', !pauseReason({ ...base, resetText: '', armed: true }).includes('resets at'));

console.log('');
if (fail) { console.log('SOME FAILED'); process.exit(1); } else { console.log('ALL PASS'); }

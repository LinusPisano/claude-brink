#!/usr/bin/env node
// Brink — installer test (Phase 4). Targets a sandbox settings.json, NEVER the live one.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let fail = 0;
const ok = (m) => console.log('  ok:   ' + m);
const bad = (m) => { console.log('  FAIL: ' + m); fail = 1; };
const eq = (n, a, e) => (JSON.stringify(a) === JSON.stringify(e) ? ok(`${n} = ${JSON.stringify(e)}`) : bad(`${n} expected ${JSON.stringify(e)} got ${JSON.stringify(a)}`));
const truthy = (n, v) => (v ? ok(n) : bad(n + ' (was falsey)'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-i-'));
const sp = path.join(dir, 'settings.json');
// seed a pre-existing settings.json with unrelated content we must preserve
fs.writeFileSync(sp, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }, null, 2));
const install = path.join(__dirname, '..', 'src', 'install.js');

console.log('first install:');
execFileSync('node', [install, '--settings', sp, '--statusline'], { encoding: 'utf8' });
let s = JSON.parse(fs.readFileSync(sp, 'utf8'));
const cmdOf = (event) => {
  for (const g of (s.hooks[event] || [])) for (const h of (g.hooks || [])) if (/brink\.js/.test(h.command || '')) return h.command;
  return '';
};
truthy('PreToolUse pause hook added', /brink\.js" claude pause/.test(cmdOf('PreToolUse')));
truthy('PostToolUse warn hook added', /brink\.js" claude warn/.test(cmdOf('PostToolUse')));
truthy('statusLine set to brink', /statusline-brink\.js/.test(JSON.stringify(s.statusLine)));
truthy('preserved existing Stop hook', /echo hi/.test(JSON.stringify(s.hooks.Stop)));
truthy('preserved unrelated model key', s.model === 'opus');
truthy('one-time backup created', fs.existsSync(sp + '.brink-bak'));

console.log('second install (must be idempotent):');
execFileSync('node', [install, '--settings', sp, '--statusline'], { encoding: 'utf8' });
s = JSON.parse(fs.readFileSync(sp, 'utf8'));
eq('PreToolUse still 1 brink hook', (s.hooks.PreToolUse || []).filter((g) => /brink/.test(JSON.stringify(g))).length, 1);
eq('PostToolUse still 1 brink hook', (s.hooks.PostToolUse || []).filter((g) => /brink/.test(JSON.stringify(g))).length, 1);

console.log('invalid settings.json (must ABORT, not wipe):');
const sp2 = path.join(dir, 'settings-broken.json');
fs.writeFileSync(sp2, '{ this is not json');
let aborted = false;
try { execFileSync('node', [install, '--settings', sp2], { encoding: 'utf8', stdio: 'pipe' }); }
catch (e) { aborted = e.status === 1; }
truthy('exits 1 on unparseable settings', aborted);
eq('original file untouched', fs.readFileSync(sp2, 'utf8'), '{ this is not json');

console.log('BOM-prefixed settings.json (must parse, not abort):');
const sp3 = path.join(dir, 'settings-bom.json');
fs.writeFileSync(sp3, '﻿' + JSON.stringify({ model: 'opus' }));
execFileSync('node', [install, '--settings', sp3], { encoding: 'utf8' });
const s3 = JSON.parse(fs.readFileSync(sp3, 'utf8'));
truthy('BOM settings: hooks added + model preserved', s3.model === 'opus' && !!s3.hooks.PreToolUse);

// --- Task 10: statusline auto-wrap - never clobber, never go inert -----------------
// A gnarly original command on purpose: quotes, a space in a path, and backslashes -
// the exact stuff that breaks naive string-embedding. Base64 must round-trip it exactly.
const ORIG_STATUSLINE_CMD = 'node "C:\\Program Files\\my status\\status.js" --flag "hello world"';
const decodeOrigArg = (command) => {
  const m = /--orig-b64\s+(\S+)/.exec(command || '');
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : null;
};

console.log('install over an EXISTING custom statusLine (must auto-wrap, not clobber):');
const sp4 = path.join(dir, 'settings-wrap.json');
fs.writeFileSync(sp4, JSON.stringify({
  model: 'sonnet',
  statusLine: { type: 'command', command: ORIG_STATUSLINE_CMD },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] },
}, null, 2));
execFileSync('node', [install, '--settings', sp4, '--statusline'], { encoding: 'utf8' });
let s4 = JSON.parse(fs.readFileSync(sp4, 'utf8'));
truthy('statusLine now points at statusline-wrap.js', /statusline-wrap\.js/.test(s4.statusLine.command));
truthy('statusLine does NOT point directly at statusline-brink.js', !/statusline-brink\.js/.test(s4.statusLine.command));
eq('wrapper recorded the ORIGINAL command exactly (quoting preserved)', decodeOrigArg(s4.statusLine.command), ORIG_STATUSLINE_CMD);
truthy('one-time backup created', fs.existsSync(sp4 + '.brink-bak'));
const bak4 = JSON.parse(fs.readFileSync(sp4 + '.brink-bak', 'utf8'));
eq('backup preserved the pristine original statusLine object', bak4.statusLine, { type: 'command', command: ORIG_STATUSLINE_CMD });
truthy('preserved unrelated foreign hook across the wrap', /echo stop/.test(JSON.stringify(s4.hooks.Stop)));

console.log('second install over an already-wrapped statusLine (must be idempotent - no double-wrap):');
execFileSync('node', [install, '--settings', sp4, '--statusline'], { encoding: 'utf8' });
const s4b = JSON.parse(fs.readFileSync(sp4, 'utf8'));
eq('statusLine command unchanged by re-install', s4b.statusLine.command, s4.statusLine.command);

// Regression guard: the "already wrapped" detection must be filename-based
// (statusline-wrap.js / statusline-brink.js), NOT a loose /brink/ substring check
// against the whole statusLine JSON. A substring check would only happen to work in
// THIS repo because the folder is named "claude-brink-plh" - copy install.js into a
// directory whose path does NOT contain "brink" and prove idempotency still holds
// there too (a real node_modules-adjacent install could easily land under a path with
// no "brink" in it, e.g. a renamed/vendored copy).
console.log('idempotency holds even when the install dir path contains no "brink" substring:');
const noBrinkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-plain-'));
truthy('sandbox dir path has no "brink" substring (test is actually probing the gap)', !/brink/i.test(noBrinkDir));
const installCopy = path.join(noBrinkDir, 'install.js');
fs.copyFileSync(install, installCopy);
const sp4nb = path.join(dir, 'settings-wrap-nobrink.json');
fs.writeFileSync(sp4nb, JSON.stringify({ statusLine: { type: 'command', command: ORIG_STATUSLINE_CMD } }, null, 2));
execFileSync('node', [installCopy, '--settings', sp4nb, '--statusline'], { encoding: 'utf8' });
const nb1 = JSON.parse(fs.readFileSync(sp4nb, 'utf8'));
truthy('first run (from a no-"brink"-path install.js) wraps as expected', /statusline-wrap\.js/.test(nb1.statusLine.command));
execFileSync('node', [installCopy, '--settings', sp4nb, '--statusline'], { encoding: 'utf8' });
const nb2 = JSON.parse(fs.readFileSync(sp4nb, 'utf8'));
eq('second run from that same path is idempotent (no wrap-of-wrap)', nb2.statusLine.command, nb1.statusLine.command);
truthy('not double-wrapped (only one statusline-wrap.js segment in the command)',
  (nb2.statusLine.command.match(/statusline-wrap\.js/g) || []).length === 1);
fs.rmSync(noBrinkDir, { recursive: true, force: true });

console.log('uninstall restores the wrapped original (via cli.js, which owns uninstall):');
const cli = path.join(__dirname, '..', 'src', 'cli.js');
execFileSync('node', [cli, 'uninstall', '--settings', sp4], { encoding: 'utf8' });
const s4c = JSON.parse(fs.readFileSync(sp4, 'utf8'));
eq('original statusLine restored verbatim after uninstall', s4c.statusLine, { type: 'command', command: ORIG_STATUSLINE_CMD });
truthy('brink hooks removed on uninstall', !/brink\.js/.test(JSON.stringify(s4c.hooks || {})));
truthy('foreign Stop hook survived uninstall', /echo stop/.test(JSON.stringify(s4c.hooks.Stop)));

console.log('install with NO existing statusLine (must wire the sensor directly, unwrapped):');
const sp5 = path.join(dir, 'settings-nowrap.json');
fs.writeFileSync(sp5, JSON.stringify({ model: 'sonnet' }, null, 2));
execFileSync('node', [install, '--settings', sp5, '--statusline'], { encoding: 'utf8' });
const s5 = JSON.parse(fs.readFileSync(sp5, 'utf8'));
truthy('statusLine set directly to statusline-brink.js (no wrapper needed)', /statusline-brink\.js/.test(s5.statusLine.command));
truthy('no wrapper involved when there was nothing to wrap', !/statusline-wrap\.js/.test(s5.statusLine.command));

// --- statusline-wrap.js runtime: tees stdin to BOTH children, never loses the ----
// sensor's state.json write, even though this test's "original" is a stub. ----
console.log('statusline-wrap.js actually runs BOTH children and still writes state.json:');
const wrapScript = path.join(__dirname, '..', 'src', 'statusline-wrap.js');
const stubOriginal = 'node -e "process.stdout.write(\'ORIG\')"';
const stubB64 = Buffer.from(stubOriginal, 'utf8').toString('base64');
const wrapBrinkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-wrap-state-'));
const wrapInput = JSON.stringify({
  session_id: 'wrap-test',
  workspace: { current_dir: dir.replace(/\\/g, '/') },
  rate_limits: { five_hour: { used_percentage: 42, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
});
const wrapOut = execFileSync('node', [wrapScript, '--orig-b64', stubB64], {
  encoding: 'utf8',
  input: wrapInput,
  env: { ...process.env, BRINK_DIR: wrapBrinkDir, BRINK_NO_RESET_PING: '1' },
});
truthy('wrapper output includes the ORIGINAL command\'s stdout', /ORIG/.test(wrapOut));
truthy('wrapper output includes Brink\'s render', /5h:42%/.test(wrapOut));
const wrapState = JSON.parse(fs.readFileSync(path.join(wrapBrinkDir, 'state.json'), 'utf8'));
eq('sensor still wrote state.json through the wrapper', wrapState.five_pct, 42);
fs.rmSync(wrapBrinkDir, { recursive: true, force: true });

fs.rmSync(dir, { recursive: true, force: true });

// --- Task 12: non-Windows install still wires hooks+sensor, but says resume is manual ---
// install.js reads a real `os.platform()` in production; BRINK_TEST_PLATFORM is a
// test-only override (never set outside this suite) so this child-process test can
// deterministically simulate "not Windows" without needing an actual Mac/Linux box.
const { spawnSync } = require('child_process');
console.log('simulated non-Windows install (must still wire hooks+sensor, and say resume is manual):');
const dirNonWin = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-i-nonwin-'));
const spNonWin = path.join(dirNonWin, 'settings.json');
const nonWinR = spawnSync('node', [install, '--settings', spNonWin, '--statusline'],
  { encoding: 'utf8', env: { ...process.env, BRINK_TEST_PLATFORM: 'darwin' } });
truthy('non-Windows install exits 0', nonWinR.status === 0);
const sNonWin = JSON.parse(fs.readFileSync(spNonWin, 'utf8'));
const cmdOfNonWin = (event) => {
  for (const g of (sNonWin.hooks[event] || [])) for (const h of (g.hooks || [])) if (/brink\.js/.test(h.command || '')) return h.command;
  return '';
};
truthy('non-Windows: PreToolUse pause hook still wired', /brink\.js" claude pause/.test(cmdOfNonWin('PreToolUse')));
truthy('non-Windows: PostToolUse warn hook still wired', /brink\.js" claude warn/.test(cmdOfNonWin('PostToolUse')));
truthy('non-Windows: statusLine sensor still wired', /statusline-brink\.js/.test(JSON.stringify(sNonWin.statusLine)));
// The clear message must land on STDERR specifically (install.js's console.error call)
// so it never contaminates the single-line JSON status object on stdout.
truthy('non-Windows: stdout still just the JSON status line (message not mixed in)',
  !/Windows-only/.test(nonWinR.stdout || '') && /"settingsPath"/.test(nonWinR.stdout || ''));
truthy('non-Windows: prints the "auto-resume is Windows-only" message on stderr',
  /Windows-only/.test(nonWinR.stderr || '') && /resume manually/.test(nonWinR.stderr || ''));
truthy('non-Windows: message points at the roadmap (not an in-place claim)', /roadmap/.test(nonWinR.stderr || ''));
fs.rmSync(dirNonWin, { recursive: true, force: true });

console.log('simulated Windows install (must NOT print the non-Windows message):');
const dirWin = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-i-win-'));
const spWin = path.join(dirWin, 'settings.json');
const winR = spawnSync('node', [install, '--settings', spWin], { encoding: 'utf8', env: { ...process.env, BRINK_TEST_PLATFORM: 'win32' } });
truthy('win32: install exits 0', winR.status === 0);
truthy('win32: no Windows-only-resume message printed', !/Windows-only/.test(winR.stderr || ''));
fs.rmSync(dirWin, { recursive: true, force: true });

console.log('');
if (fail) { console.log('SOME FAILED'); process.exit(1); } else { console.log('ALL PASS'); }

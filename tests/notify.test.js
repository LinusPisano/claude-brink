#!/usr/bin/env node
// Brink — notifier tests. Pure command-builder assertions so the macOS/Linux
// desktop paths are verifiable from any dev machine (no live toast needed).
const { notify, desktopCommand } = require('../src/notify');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let fail = 0;
const ok = (m) => console.log('  ok:   ' + m);
const bad = (m) => { console.log('  FAIL: ' + m); fail = 1; };
const truthy = (n, v) => (v ? ok(n) : bad(n + ' (was falsey)'));

console.log('desktopCommand:');
const win = desktopCommand('win32', 'hello');
truthy('win32 -> powershell notify.ps1', win.cmd === 'powershell' && win.args.some((a) => /notify\.ps1$/.test(a)));
truthy('win32 passes -Msg', win.args[win.args.indexOf('-Msg') + 1] === 'hello');

const mac = desktopCommand('darwin', 'usage at 85%');
truthy('darwin -> osascript', mac.cmd === 'osascript');
truthy('darwin script says display notification with Brink title',
  /display notification "usage at 85%" with title "Brink"/.test(mac.args[mac.args.indexOf('-e') + 1]));
// AppleScript string is double-quoted — quotes/backslashes in the message must be escaped
const macEsc = desktopCommand('darwin', 'say "hi" \\ done');
truthy('darwin escapes quotes and backslashes',
  macEsc.args[macEsc.args.indexOf('-e') + 1].includes('say \\"hi\\" \\\\ done'));

const lin = desktopCommand('linux', 'paused');
truthy('linux -> notify-send Brink <msg>', lin.cmd === 'notify-send' && lin.args[0] === 'Brink' && lin.args[1] === 'paused');

truthy('unknown platform -> null (no-op)', desktopCommand('sunos', 'x') === null);

// Phone push is REMOVED (owner decision 2026-07-06): no functional ntfy remnants —
// no endpoint call, no topic config, no env override. (Comments may mention history.)
const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'notify.js'), 'utf8');
truthy('no ntfy push code remains', !/ntfy\.sh|ntfy_topic|BRINK_NTFY/.test(src));

// --- notify(): a pause/warn must NEVER be invisible (Task 12, pre-launch hardening) ---
// If the desktop notifier is unsupported for this platform, or it genuinely fails to
// fire, notify() must fall back to writing the message to stderr — never just
// `{ok:false}` with silence. Deliberate config opt-out (notify.desktop:false) is the
// one case that stays quiet on purpose (negative control below).
console.log('');
console.log('notify(): never-invisible stderr fallback:');

// Isolates BRINK_DIR (a fresh temp dir per case, no leftover config.json) so
// loadNotifyCfg() sees a clean {} unless a case writes its own config.
function withSandboxBrinkDir(configObj, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-notify-'));
  if (configObj) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(configObj));
  const origBrinkDir = process.env.BRINK_DIR;
  process.env.BRINK_DIR = dir;
  return Promise.resolve().then(fn).finally(() => {
    if (origBrinkDir === undefined) delete process.env.BRINK_DIR; else process.env.BRINK_DIR = origBrinkDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// Captures process.stderr.write for the duration of `fn`, restoring it after.
function captureStderr(fn) {
  const origWrite = process.stderr.write;
  let captured = '';
  process.stderr.write = (chunk) => { captured += chunk; return true; };
  return Promise.resolve().then(fn).finally(() => { process.stderr.write = origWrite; }).then((res) => ({ res, captured }));
}

async function testUnsupportedPlatformFallsBackToStderr() {
  // os.platform() is called live (per-call, not at require time) inside notify.js's
  // desktop(), so patching the shared `os` module singleton reaches straight through —
  // no need to reload notify.js's module cache for this one.
  const origPlatform = os.platform;
  os.platform = () => 'sunos'; // no desktopCommand branch for this platform -> unsupported
  try {
    await withSandboxBrinkDir(null, async () => {
      const { res, captured } = await captureStderr(() => notify('paused at 93% - test'));
      truthy('unsupported platform -> ok:false', res.ok === false);
      truthy('unsupported platform -> desktop-unsupported label', /^desktop-unsupported\(/.test(res.desktop));
      truthy('unsupported platform -> stderrFallback:true (non-silent)', res.stderrFallback === true);
      truthy('unsupported platform -> message actually written to stderr', captured.includes('paused at 93% - test'));
    });
  } finally { os.platform = origPlatform; }
}

async function testSpawnFailureFallsBackToStderr() {
  // child_process.spawn is destructured at notify.js's module TOP LEVEL, so unlike
  // os.platform() above, patching child_process's export after notify.js already
  // loaded would not reach the already-bound local — reload the module fresh so its
  // destructure picks up the faked spawn.
  const cp = require('child_process');
  const { EventEmitter } = require('events');
  const origSpawn = cp.spawn;
  cp.spawn = () => {
    const em = new EventEmitter();
    process.nextTick(() => em.emit('error', new Error('ENOENT: simulated spawn failure')));
    return em;
  };
  const notifyPath = require.resolve('../src/notify');
  delete require.cache[notifyPath];
  try {
    const fresh = require('../src/notify');
    await withSandboxBrinkDir(null, async () => {
      const { res, captured } = await captureStderr(() => fresh.notify('resume arming FAILED - test'));
      truthy('spawn failure -> ok:false', res.ok === false);
      truthy('spawn failure -> spawn-error label', /-spawn-error$/.test(res.desktop));
      truthy('spawn failure -> stderrFallback:true (non-silent)', res.stderrFallback === true);
      truthy('spawn failure -> message actually written to stderr', captured.includes('resume arming FAILED - test'));
    });
  } finally {
    cp.spawn = origSpawn;
    delete require.cache[notifyPath]; // leave a clean, real module behind
  }
}

async function testConfigDisabledStaysQuiet() {
  // Negative control: an explicit notify.desktop:false opt-out is NOT a failure —
  // it must NOT get the stderr fallback (that would defeat disabling notifications).
  await withSandboxBrinkDir({ notify: { desktop: false } }, async () => {
    const { res, captured } = await captureStderr(() => notify('should stay quiet - test'));
    truthy('desktop:false -> ok:false', res.ok === false);
    truthy('desktop:false -> desktop-disabled label', res.desktop === 'desktop-disabled');
    truthy('desktop:false -> stderrFallback:false (explicit opt-out honored, not a failure)', res.stderrFallback === false);
    truthy('desktop:false -> nothing written to stderr', captured === '');
  });
}

// --- Production call-graph proof: the fallback must survive a REAL spawn (Task 12 ----
// review fix). notify()'s in-process tests above observe a monkey-patched
// process.stderr.write, but production doesn't call the export - it SPAWNS
// `node notify.js <msg>`. brink.js/statusline-brink.js used stdio:'ignore', which
// routed the child's stderr to the null device, so the fallback was DEAD in prod (a
// warn = notify()+exit(0), no other visibility). These tests spawn notify.js the way
// production does and prove the message reaches the child's stderr - AND prove it would
// have been swallowed under 'ignore', so the stdio:[...,'inherit'] change is load-bearing.
function runNotifyChild(msg, { stdErrMode }) {
  // BRINK_DIR isolated so no real config.json disables/skews; BRINK_SILENT explicitly
  // cleared (the parent test run may set it). BRINK_TEST_PLATFORM forces the desktop
  // builder to unsupported inside the child, deterministically triggering the fallback.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-notify-child-'));
  const env = { ...process.env, BRINK_DIR: dir, BRINK_TEST_PLATFORM: 'sunos' };
  delete env.BRINK_SILENT;
  // stdio index 2 = the child's stderr. 'pipe' mirrors an inherit-to-a-captured-parent
  // (production inherits to the terminal; the test captures instead). 'ignore' reproduces
  // the OLD broken wiring to prove the difference.
  const r = spawnSync('node', [path.join(__dirname, '..', 'src', 'notify.js'), msg],
    { encoding: 'utf8', env, stdio: ['ignore', 'pipe', stdErrMode], timeout: 15000 });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

function testRealSpawnStderrIsReachable() {
  console.log('');
  console.log('notify.js child-process (production call graph): fallback reaches stderr:');
  // 'pipe' == what stdio:[...,'inherit'] gives production (a real, non-null stderr).
  const piped = runNotifyChild('paused via real spawn - test', { stdErrMode: 'pipe' });
  const childStdout = (piped.stdout || '').trim();
  let parsed = {}; try { parsed = JSON.parse(childStdout); } catch {}
  truthy('child stdout is still the clean JSON result (fallback did not pollute stdout)',
    parsed.stderrFallback === true && parsed.ok === false);
  truthy('child stderr carries the message when stderr is a real pipe (inherit-equivalent)',
    (piped.stderr || '').includes('paused via real spawn - test'));

  // Now the OLD wiring: stdio index 2 = 'ignore' (== stdio:'ignore' -> /dev/null). The
  // fallback still RUNS in the child (stderrFallback:true in its JSON stdout) but its
  // write vanishes - proving the inherit change is exactly what makes it visible.
  const ignored = runNotifyChild('paused into the void - test', { stdErrMode: 'ignore' });
  let parsed2 = {}; try { parsed2 = JSON.parse((ignored.stdout || '').trim()); } catch {}
  truthy('under stdio:ignore the child STILL runs the fallback (JSON says stderrFallback:true)',
    parsed2.stderrFallback === true);
  truthy('under stdio:ignore the message is UNREACHABLE (parent captured no child stderr)',
    (ignored.stderr || '') === '' || ignored.stderr === null);
}

(async () => {
  await testUnsupportedPlatformFallsBackToStderr();
  await testSpawnFailureFallsBackToStderr();
  await testConfigDisabledStaysQuiet();
  testRealSpawnStderrIsReachable();

  console.log('');
  if (fail) { console.log('SOME FAILED'); process.exit(1); } else { console.log('ALL PASS'); }
})();

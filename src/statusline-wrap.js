#!/usr/bin/env node
// Brink — statusline auto-wrap (pre-launch hardening Task 10). Installed by
// `brink init --statusline` IN PLACE OF the user's own statusLine command, but only
// when one already existed - never clobber, never go inert. Reads Claude's statusLine
// JSON from stdin ONCE and tees the same bytes to two children:
//   (a) the user's ORIGINAL statusLine command (so their look/feel keeps working), and
//   (b) statusline-brink.js, the sensor (MUST run every refresh - it's the only place
//       Claude pipes rate_limits, and the PreToolUse pause hook is blind without the
//       state.json it writes).
// stdout = the original's stdout, then a space, then Brink's render. Best-effort: if
// either child fails, hangs, or errors mid-stream, the other's output still gets
// through - a broken original statusline must never take Brink down with it, and
// Brink must never swallow the original's output.
//
// The original command travels as a base64 CLI arg, not an env var or a raw inline
// shell string: Claude Code's statusLine.command can run under different shells
// depending on platform (cmd.exe / PowerShell / sh), and `VAR=val cmd` / `set VAR=val
// && cmd` / `$env:VAR='val'; cmd` are three different, mutually incompatible syntaxes.
// A bare base64 string has no spaces or shell metacharacters, so it survives unquoted
// in all of them, and decoding it back recovers the original command's exact bytes -
// including whatever quoting IT used internally - with no re-escaping step to get wrong.
//
// Usage: node statusline-wrap.js --orig-b64 <base64-of-original-command>

const path = require('path');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const optIdx = argv.indexOf('--orig-b64');
const origB64 = optIdx >= 0 ? (argv[optIdx + 1] || '') : '';
const origCmd = origB64 ? Buffer.from(origB64, 'base64').toString('utf8') : '';

const SENSOR = path.join(__dirname, 'statusline-brink.js');

// A statusLine command runs on every prompt refresh - if the user's original ever
// hangs (network call, stuck process, ...) it must not freeze Claude Code's UI
// forever waiting on it. Bounded wait; the sensor side still gets its own attempt.
const CHILD_TIMEOUT_MS = 5000;

// Run one child, feed it `input` on stdin, resolve its stdout as a string. Never
// rejects/throws - a child that fails to spawn, exits non-zero, errors mid-stream,
// or overruns the timeout just resolves with whatever (if anything) it managed to print.
function runChild(command, args, opts, input) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(out);
    };
    let child;
    try {
      child = spawn(command, args, { ...opts, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve('');
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(); }, CHILD_TIMEOUT_MS);
    child.on('error', finish); // e.g. ENOENT - the original command doesn't exist
    if (child.stdout) child.stdout.on('data', (d) => { out += d; });
    if (child.stdin) {
      child.stdin.on('error', () => {}); // EPIPE if the child exits before we finish writing
      try { child.stdin.write(input); child.stdin.end(); } catch {}
    }
    child.on('close', finish);
  });
}

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', async () => {
  // Sensor runs via the exact node binary/argv (no shell) - no quoting to get wrong.
  const sensorPromise = runChild(process.execPath, [SENSOR], {}, raw);
  // Original runs through a shell (it's an arbitrary command string, just like Claude
  // itself would run it as statusLine.command).
  const origPromise = origCmd ? runChild(origCmd, [], { shell: true }, raw) : Promise.resolve('');

  const [origOut, brinkOut] = await Promise.all([origPromise, sensorPromise]);

  let out = origOut;
  if (brinkOut) out += (out ? ' ' : '') + brinkOut;
  process.stdout.write(out);
});

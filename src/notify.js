#!/usr/bin/env node
// Brink — notifier. CLI-agnostic: `node notify.js "message"` fires a native
// desktop notification (Windows toast / macOS notification center / Linux
// notify-send). Because it's just "send a message", it works from a hook, a
// scheduled resume job, or any caller.
//
// Phone push (ntfy) was REMOVED by owner decision 2026-07-06 — desktop-only.
//
// Config: reads notify.{desktop, windows_toast} from $BRINK_DIR/config.json.
// `desktop: false` disables on every platform; the legacy `windows_toast: false`
// still disables on Windows (back-compat with pre-0.2 configs).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadNotifyCfg() {
  try {
    const dir = process.env.BRINK_DIR || path.join(os.homedir(), '.claude', 'brink');
    const raw = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
    const c = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    return (c && typeof c.notify === 'object' && c.notify) || {};
  } catch { return {}; }
}

// Pure builder: platform -> { cmd, args } (or null = unsupported platform).
// Kept side-effect-free so the macOS/Linux paths are unit-testable from Windows.
// `label` is the success status this platform reports — the ONE place platform
// labels live, so desktop() and doctor never drift a hand-maintained copy.
function desktopCommand(platform, msg) {
  if (platform === 'win32') {
    return {
      cmd: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(__dirname, 'notify.ps1'), '-Msg', msg],
      label: 'win-toast',
    };
  }
  if (platform === 'darwin') {
    // AppleScript string literal — escape backslashes first, then double quotes.
    const esc = msg.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return { cmd: 'osascript', args: ['-e', `display notification "${esc}" with title "Brink"`], label: 'mac-notify' };
  }
  if (platform === 'linux') {
    return { cmd: 'notify-send', args: ['Brink', msg], label: 'linux-notify' }; // args array — no shell, no escaping
  }
  return null;
}
const OK_LABELS = ['win-toast', 'mac-notify', 'linux-notify']; // a fired notification
// Deliberate, config-driven silence (notify.desktop: false / windows_toast: false) is
// NOT a failure — the user explicitly opted out, so it must NOT get the stderr
// fallback below (that would defeat the point of disabling notifications).
const SILENCED_BY_CONFIG = ['desktop-disabled', 'win-toast-disabled'];

// NOT detached, and awaited: live-fire testing proved PowerShell 5.1 dies at startup
// when spawned DETACHED_PROCESS (no console), and an attached child dies when the
// parent's console closes — so the parent must outlive it. notify.js itself is the
// detached fire-and-forget layer, so waiting ~1-2s here blocks nobody.
function desktop(msg, cfg) {
  // BRINK_TEST_PLATFORM: test-only override (never set in production, same pattern as
  // install.js / BRINK_DETECT_OVERRIDE) so a CHILD-process test can force the desktop
  // builder to an unsupported platform across a real spawn boundary - the only way to
  // prove the stderr fallback survives production's stdio wiring (an in-process
  // os.platform monkey-patch can't reach a spawned child). Falls through to the real
  // os.platform() whenever unset.
  const platform = process.env.BRINK_TEST_PLATFORM || os.platform();
  if (cfg.desktop === false) return Promise.resolve('desktop-disabled');
  if (platform === 'win32' && cfg.windows_toast === false) return Promise.resolve('win-toast-disabled');
  const c = desktopCommand(platform, msg);
  if (!c) return Promise.resolve(`desktop-unsupported(${platform})`);
  const label = c.label;
  return new Promise((resolve) => {
    try {
      const child = spawn(c.cmd, c.args, { stdio: 'ignore', windowsHide: true });
      const t = setTimeout(() => resolve(`${label}-timeout`), 8000);
      child.on('error', () => { clearTimeout(t); resolve(`${label}-spawn-error`); });
      child.on('close', (code) => { clearTimeout(t); resolve(code === 0 ? label : `${label}-exit-${code}`); });
    } catch { resolve(`${label}-error`); }
  });
}

// A pause/warn must NEVER be invisible (pre-launch hardening Task 12). If the desktop
// notifier is unsupported on this platform (`desktop-unsupported(...)` — e.g. a
// non-win32/darwin/linux OS) or it genuinely failed to fire (spawn error, non-zero
// exit, timeout — see desktopCommand()/desktop() above), fall back to writing the
// message straight to stderr so it still surfaces somewhere. Deliberate config-driven
// silence (SILENCED_BY_CONFIG) and BRINK_SILENT (test/CI escape hatch, handled above)
// are excluded on purpose — those are the user (or the test harness) asking for quiet,
// not a broken notifier.
async function notify(msg) {
  if (process.env.BRINK_SILENT) return { silent: true };
  const d = await desktop(msg, loadNotifyCfg());
  const ok = OK_LABELS.includes(d); // ok = a notification actually fired
  let stderrFallback = false;
  if (!ok && !SILENCED_BY_CONFIG.includes(d)) {
    process.stderr.write(`[Brink] ${msg}\n`);
    stderrFallback = true;
  }
  return { desktop: d, ok, stderrFallback };
}

if (require.main === module) {
  const msg = process.argv.slice(2).join(' ') || 'Brink test notification';
  notify(msg).then((r) => console.log(JSON.stringify(r)));
}
module.exports = { notify, desktopCommand };

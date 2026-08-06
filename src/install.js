#!/usr/bin/env node
// Brink installer — Claude Code adapter (the `brink init` for Claude).
// Usage: node install.js [--settings <path>] [--statusline]
// Registers the Brink hooks into the target Claude Code settings.json:
//   PreToolUse  -> node brink.js claude pause   (graceful auto-pause before the limit)
//   PostToolUse -> node brink.js claude warn    (threshold warning notifications)
//   UserPromptSubmit -> node brink.js claude busy   (watchdog: a turn is in flight)
//   Stop        -> node brink.js claude idle    (watchdog: turn finished cleanly)
//   SessionEnd  -> node brink.js claude end     (watchdog: clean teardown clears too)
//   The three watchdog hooks are inert until config watchdog.mode is set (brink.js
//   exits before touching disk) — wiring them unconditionally keeps init one-shot.
//   --statusline also wires the usage sensor in. Claude only pipes rate_limits to the
//   statusLine, so the sensor MUST live there - but a real custom statusLine (ccstatusline,
//   powerline, ...) must keep working too. Auto-wrap, never clobber (pre-launch hardening
//   Task 10): no existing statusLine -> point it straight at statusline-brink.js (today's
//   behavior); an existing one -> back it up (below) and point it at statusline-wrap.js,
//   which tees stdin to BOTH the original command and the sensor every refresh.
// Idempotent (won't duplicate the brink hook for an event, won't re-wrap an already-Brink
// statusLine). Backs up the original settings.json once (statusline-wrap.js never needs
// this backup itself - it gets the original command directly, as a base64 argv).
//
// SAFE BY DEFAULT for testing: pass --settings <sandbox> to target a throwaway file.
// Bare `node` is used (not an absolute path) so the command works whether Claude Code
// runs the hook in bash or PowerShell — node is on PATH wherever Claude Code runs.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = __dirname;
const q = (p) => `"${String(p).replace(/\\/g, '/')}"`;
const cmd = (script, ...args) => ['node', q(path.join(SRC, script)), ...args].join(' ');

const argv = process.argv.slice(2);
const getOpt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? (argv[i + 1] || true) : d; };
const settingsPath = getOpt('--settings', path.join(os.homedir(), '.claude', 'settings.json'));
const withStatusline = argv.includes('--statusline');
// BRINK_TEST_PLATFORM: test-only override (never set in production) so the
// non-Windows resume message can be exercised deterministically from install.test.js,
// which runs install.js as a real child process (a real os.platform() can't be
// monkey-patched across that process boundary the way the in-process notify.test.js
// patches it). Same pattern as BRINK_DETECT_OVERRIDE in brink.js.
const PLATFORM = process.env.BRINK_TEST_PLATFORM || os.platform();

const PAUSE = cmd('brink.js', 'claude', 'pause');
const WARN = cmd('brink.js', 'claude', 'warn');
const BUSY = cmd('brink.js', 'claude', 'busy');
const IDLE = cmd('brink.js', 'claude', 'idle');
const END = cmd('brink.js', 'claude', 'end');
const STATUS = cmd('statusline-brink.js');

// BOM-tolerant read. Returns null (NOT {}) on a parse failure so the caller can
// ABORT — silently proceeding here wiped the user's whole settings.json down to
// Brink-only content (review finding: a UTF-8 BOM was enough to trigger it).
const read = (p) => {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch { return null; }
};
const hasBrinkHook = (s, event) =>
  ((s.hooks && s.hooks[event]) || []).some((g) => (g.hooks || []).some((h) => /brink\.js/.test(h.command || '')));

function addHook(s, event, command) {
  s.hooks = s.hooks || {};
  s.hooks[event] = s.hooks[event] || [];
  if (hasBrinkHook(s, event)) return false;
  s.hooks[event].push({ hooks: [{ type: 'command', command }] });
  return true;
}

function main() {
  const existed = fs.existsSync(settingsPath);
  let s = {};
  if (existed) {
    s = read(settingsPath);
    if (s === null) {
      console.error(`Brink install ABORTED: ${settingsPath} exists but is not valid JSON. ` +
        'Fix it (or remove it) and re-run - refusing to overwrite your settings.');
      process.exit(1);
    }
    if (!fs.existsSync(settingsPath + '.brink-bak')) {
      fs.copyFileSync(settingsPath, settingsPath + '.brink-bak'); // one-time backup
    }
  }
  const changed = [];
  if (addHook(s, 'PreToolUse', PAUSE)) changed.push('PreToolUse(pause)');
  if (addHook(s, 'PostToolUse', WARN)) changed.push('PostToolUse(warn)');
  if (addHook(s, 'UserPromptSubmit', BUSY)) changed.push('UserPromptSubmit(busy)');
  if (addHook(s, 'Stop', IDLE)) changed.push('Stop(idle)');
  if (addHook(s, 'SessionEnd', END)) changed.push('SessionEnd(end)');
  // Filename-based, NOT a loose /brink/ substring check: statusline-wrap.js's own
  // filename doesn't contain "brink", so a substring check would only catch an
  // already-wrapped statusLine by accident of the install directory's own name
  // (e.g. this repo's "claude-brink-plh") - a real `node_modules`-adjacent install
  // under a differently-named path would fail to recognize its own wrapper and
  // double-wrap on every re-install. Match the two sensor/wrapper filenames instead.
  const isBrinkStatusLine = (sl) => /statusline-brink\.js|statusline-wrap\.js/.test(JSON.stringify(sl || ''));
  if (withStatusline && !isBrinkStatusLine(s.statusLine)) {
    if (s.statusLine && s.statusLine.command) {
      // Auto-wrap, never clobber (Task 10): a real custom statusLine keeps running.
      // The pristine original is already sitting in the one-time settings.json.brink-bak
      // made above - `brink uninstall` restores straight from there. All we do here is
      // hand the ORIGINAL command string to the new wrapper so it can still invoke it.
      // Loud, not silent (review finding carried over from the old clobber behavior).
      console.error(`note: wrapping your existing statusLine (original preserved in ${settingsPath}.brink-bak - both will run)`);
      const origB64 = Buffer.from(s.statusLine.command, 'utf8').toString('base64');
      // Spread the existing object rather than replacing it: statusLine carries sibling
      // keys Claude Code honours (padding, refreshInterval, hideVimModeIndicator, ...) and
      // rebuilding it as a bare {type, command} silently dropped every one of them on the
      // first init — a formatting change the user never asked for, and one uninstall could
      // not undo either (post-fix review 2026-08-06). Only `command` is ours to change.
      s.statusLine = { ...s.statusLine, type: 'command', command: cmd('statusline-wrap.js', '--orig-b64', origB64) };
      changed.push('statusLine(wrapped existing)');
    } else {
      s.statusLine = { type: 'command', command: STATUS };
      changed.push('statusLine');
    }
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
  console.log(JSON.stringify({ settingsPath, changed, alreadyInstalled: changed.length === 0 }));
  // Non-Windows (Task 12 / pre-launch hardening): the hooks + sensor wiring above is
  // plain Node/JSON and already cross-platform — pause, HANDOFF.md, and the desktop
  // notifier (with its own stderr fallback, notify.js) all work here. Only auto-resume
  // (Windows Task Scheduler + terminal injection, core/resume.js `shouldArm`) is
  // Windows-only in v1. Say so loudly, once, right after install — silence here would
  // let a Mac/Linux user believe a pause will resume itself when it never arms.
  if (PLATFORM !== 'win32') {
    console.error("Auto-resume is Windows-only for now - you'll get a graceful pause + " +
      'handoff; resume manually. (in-place/headless resume support for macOS/Linux is on the roadmap.)');
  }
}
main();

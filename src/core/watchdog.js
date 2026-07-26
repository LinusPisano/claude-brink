// Brink core — watchdog config + busy-marker path (pure, no I/O). Watchdog feature.
//
// The watchdog closes the one death Brink v1 couldn't survive: a session killed
// OUTSIDE a usage pause (terminal window closed mid-turn, process crash, reboot).
// A pause arms its own resume before the session stops; a kill fires no hook, so
// recovery needs something alive OUTSIDE the session — the watchdog daemon
// (src/watchdog.ps1, installed via `brink watchdog on`), which scans busy markers
// and revives sessions whose process died while a turn was still in flight.
//
// Marker lifecycle (all wired by install.js / hooks.json):
//   UserPromptSubmit -> brink.js claude busy  -> write/refresh busy_<sid>.json
//   Stop             -> brink.js claude idle  -> delete (turn finished cleanly)
//   SessionEnd       -> brink.js claude end   -> delete UNLESS reason is 'other'
//                       ('other' covers abnormal teardown — the watchdog's case)
// Dead pid + surviving marker == died mid-work. No marker == closed idle, on
// purpose: stays dead. That distinction is what keeps the watchdog from
// resurrecting every session the user closes deliberately.
//
// cfg.watchdog: { mode:'off'|'ask'|'auto', poll_seconds, cancel_window_seconds,
//                 max_revives_per_hour, revive_prompt }
// mode is the master switch and defaults OFF — with it off, the busy/idle hooks
// exit before touching disk and the daemon (if somehow running) scans nothing.

const path = require('path');
const { sanitizeSid } = require('./paths');

// Same TUI-input guard rationale as core/resume.js DEFAULT_CONTINUE: plain ASCII,
// no leading / ! @ #, no newline — this string is typed into `claude -p` argv, not
// injected into a console, but the config guard below is shared so a garbage
// override can never smuggle TUI-special input in either place.
const DEFAULT_REVIVE_PROMPT =
  'This session was terminated unexpectedly while work was in progress. ' +
  'Review the recent conversation and continue the task - do not redo finished work.';

const DEFAULT_WATCHDOG = {
  mode: 'off',                 // 'off' | 'ask' (notify only) | 'auto' (revive after cancel window)
  poll_seconds: 60,            // daemon scan interval
  cancel_window_seconds: 60,   // auto mode: grace between the toast and the revive (brink cancel)
  max_revives_per_hour: 3,     // global backstop across ALL sessions; 0 = unlimited
  revive_prompt: DEFAULT_REVIVE_PROMPT,
};

// NOTE for maintainers: src/watchdog.ps1 re-implements these defaults/clamps in
// PowerShell (the daemon can't require() this module). If you change a default or
// a clamp here, change it there too — tests/watchdog.test.js pins the PS side.
function watchdogCfg(cfg) {
  const w = (cfg && typeof cfg.watchdog === 'object' && cfg.watchdog) || {};
  const out = { ...DEFAULT_WATCHDOG, ...w };
  // Only the two live modes pass through; anything else (typo, boolean, 'ASK') is
  // 'off' — a mangled config must fail CLOSED (no marker writes, no revives).
  out.mode = out.mode === 'auto' || out.mode === 'ask' ? out.mode : 'off';
  const int = (v, d, lo, hi) =>
    Number.isFinite(v) && v >= lo && v <= hi ? Math.floor(v) : d;
  out.poll_seconds = int(out.poll_seconds, DEFAULT_WATCHDOG.poll_seconds, 10, 3600);
  out.cancel_window_seconds = int(out.cancel_window_seconds, DEFAULT_WATCHDOG.cancel_window_seconds, 0, 600);
  out.max_revives_per_hour = int(out.max_revives_per_hour, DEFAULT_WATCHDOG.max_revives_per_hour, 0, 1000);
  const rp = typeof out.revive_prompt === 'string' ? out.revive_prompt.trim() : '';
  out.revive_prompt = rp && !/^[\/!@#]/.test(rp) && !/\n/.test(rp) ? rp : DEFAULT_REVIVE_PROMPT;
  return out;
}

// Flat file at the brink-dir root, like chain_/armed_ — one marker per session id.
// (Not nested under the per-project session dir: the daemon scans these every poll
// cycle and a flat glob is one readdir, not a two-level walk.)
function busyMarkerPath(brinkDir, sid) {
  return path.join(brinkDir, 'busy_' + sanitizeSid(sid) + '.json');
}

module.exports = { watchdogCfg, busyMarkerPath, DEFAULT_WATCHDOG, DEFAULT_REVIVE_PROMPT };

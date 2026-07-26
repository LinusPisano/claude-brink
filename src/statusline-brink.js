#!/usr/bin/env node
// Brink — sensor + state writer (Phase 1)
// A Claude Code statusLine command. Reads the usage JSON Claude pipes on stdin,
// renders a minimal status string, AND atomically writes a tiny state file that
// the PreToolUse pause hook reads (hooks can't see rate_limits directly).
//
// Node-based on purpose: JSON.parse is built in (no jq/python dependency) and it
// runs anywhere Claude Code runs. State dir overridable via $BRINK_DIR (tests).
//
// Install (later phase) as:  "statusLine": { "type": "command",
//   "command": "node \"<path>/statusline-brink.js\"" }

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { recordUsage } = require('./core/sensor-record');

// Reset-ping defaults (Phase 6): weekly ON, 5h OFF — a 5h reset fires several times
// a day and trains you to ignore pings; the weekly reset is days of budget coming back.
// floor = only ping if you were at/above this % before it rolled (else it is noise).
const DEFAULT_RESET = {
  five_hour: { enabled: false, floor: 75 },
  seven_day: { enabled: true,  floor: 80 },
};

function readJson(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch { return null; }
}

function loadResetCfg(dir) {
  const c = readJson(path.join(dir, 'config.json')) || {};
  const rp = c.reset_ping || {};
  return {
    five_hour: { ...DEFAULT_RESET.five_hour, ...(rp.five_hour || {}) },
    seven_day: { ...DEFAULT_RESET.seven_day, ...(rp.seven_day || {}) },
  };
}

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let j = {};
  try { j = JSON.parse(raw || '{}'); } catch { j = {}; }

  const dir = process.env.BRINK_DIR || path.join(os.homedir(), '.claude', 'brink');

  const rl = j.rate_limits || {};
  const five = rl.five_hour || {};
  const week = rl.seven_day || {};
  const num = (v) => (typeof v === 'number' ? v : null);

  const fivePct   = num(five.used_percentage);
  const weekPct   = num(week.used_percentage);
  const fiveReset = num(five.resets_at);
  const weekReset = num(week.resets_at);
  const sid = j.session_id || '';
  const cwd = (j.workspace && j.workspace.current_dir) || j.cwd || '';

  // --- render (minimal; merge into your full status line) ---
  let rate = '';
  if (fivePct !== null) rate = `5h:${Math.round(fivePct)}%`;
  if (fiveReset !== null) {
    const left = fiveReset - Math.floor(Date.now() / 1000);
    if (left > 0) rate += ` (${Math.floor(left / 3600)}h${Math.floor((left % 3600) / 60)}m)`;
  }
  if (weekPct !== null) rate += `${rate ? ' * ' : ''}7d:${Math.round(weekPct)}%`;
  process.stdout.write(rate);

  // --- persist state + history, detect resets AND same-window meter drops ---
  // recordUsage (core/sensor-record.js) owns the atomic state.json write (per-PID
  // tmp + guarded rename — see that file for the concurrency story), the rolling
  // usage-history.jsonl append (burn-rate projection + anomaly forensics), and the
  // event detection. Naturally debounced: the new reading is persisted before the
  // next refresh compares against it. BRINK_NO_RESET_PING disables pings for tests.
  const state = {
    five_pct: fivePct, week_pct: weekPct,
    five_reset: fiveReset, week_reset: weekReset,
    session_id: sid, cwd,
  };
  let events = [];
  try {
    ({ events } = recordUsage(dir, state, { reset_ping: loadResetCfg(dir) }));
  } catch { /* sensor is best-effort; never crash the prompt */ }

  if (!process.env.BRINK_NO_RESET_PING) {
    try {
      for (const ev of events) {
        // stderr inherited (not 'ignore') so notify.js's never-invisible fallback can
        // surface a missing/failed desktop notifier - best-effort here: Claude Code may
        // swallow statusLine stderr, and a reset ping ("budget's back") is non-critical
        // good news, unlike the warn/pause path in brink.js.
        const c = spawn('node', [path.join(__dirname, 'notify.js'), ev.message],
          { detached: true, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
        c.on('error', () => {}); // async spawn failure must never crash the sensor
        c.unref();
      }
    } catch { /* never let a ping failure break the prompt */ }
  }
});

// Brink core — sensor-side usage recorder (burn-in fixes, 2026-07-16).
// ONE entry point shared by statusline-brink.js (and any custom statusline that
// embeds the sensor) for everything that must happen with a fresh usage reading:
//   1. persist state.json atomically (now stamped with `updated_at`),
//   2. append the reading to a rolling usage-history.jsonl — the forensic record
//      the 07-15/16 weekly meter-drop anomaly had to be diagnosed WITHOUT, and the
//      sample source for the gate's burn-rate projection (core/thresholds.js), and
//   3. return notify-worthy events: window resets (core/reset.js, unchanged) plus
//      same-window meter DROPS.
// Meter drops (burn-in finding F2): the weekly meter fell 95 -> 4 with resets_at
// unchanged. Within a window real usage is monotonic, so a big drop without a
// rollover means the provider adjusted the meter/allowance out-of-band. Left
// undetected, the user sits out a pause whose "resets at <date>" overstates the
// wait — ping it like a reset so they know budget is back.
const fs = require('fs');
const path = require('path');
const { detectResets, GUARD } = require('./reset');

const HISTORY_FILE = 'usage-history.jsonl';
const HISTORY_MAX_BYTES = 256 * 1024; // prune trigger — ~2k lines of readings
const HISTORY_KEEP = 500;             // lines kept after a prune

// A drop must be big AND from a height that mattered: small wobbles (rounding,
// re-bucketing) and drops from low usage are noise, not an allowance change.
const DROP_MIN = 20;   // percentage points fallen
const DROP_FLOOR = 50; // only meaningful if the meter was actually high

const WINDOWS = [
  { key: 'five_hour', label: '5h', pct: 'five_pct', reset: 'five_reset' },
  { key: 'seven_day', label: 'weekly', pct: 'week_pct', reset: 'week_reset' },
];

function detectMeterDrops(prev, cur) {
  if (!prev || !cur) return [];
  const events = [];
  for (const w of WINDOWS) {
    const pp = prev[w.pct]; const cp = cur[w.pct];
    const pr = prev[w.reset]; const cr = cur[w.reset];
    if (typeof pp !== 'number' || typeof cp !== 'number') continue;
    if (typeof pr !== 'number' || typeof cr !== 'number') continue;
    if (Math.abs(cr - pr) > GUARD) continue; // window rolled/changed — reset.js territory
    if (pp < DROP_FLOOR || pp - cp < DROP_MIN) continue;
    events.push({
      windowKey: w.key,
      label: w.label,
      prevPct: Math.round(pp),
      curPct: Math.round(cp),
      message: `Brink: ${w.label} usage meter dropped ${Math.round(pp)}% -> ${Math.round(cp)}% without a reset - budget looks available again (provider-side adjustment)`,
    });
  }
  return events;
}

// Best-effort append + size-triggered prune. History must never break the sensor.
function appendHistory(dir, state, now) {
  const p = path.join(dir, HISTORY_FILE);
  const line = JSON.stringify({
    t: now,
    five_pct: state.five_pct, week_pct: state.week_pct,
    five_reset: state.five_reset, week_reset: state.week_reset,
    sid: state.session_id || '',
    // Model dimension (report 2026-07-31 defect 1): without it, post-hoc forensics
    // cannot even see which model burned a window. rl_extra names any rate-limit
    // buckets beyond five_hour/seven_day the payload carried (the per-model-bucket
    // probe question) — only present when there were any.
    model: state.model || '',
    ...(state.rl_extra && state.rl_extra.length ? { rl_extra: state.rl_extra } : {}),
  }) + '\n';
  try {
    fs.appendFileSync(p, line);
    let size = 0;
    try { size = fs.statSync(p).size; } catch {}
    if (size > HISTORY_MAX_BYTES) {
      const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(p, lines.slice(-HISTORY_KEEP).join('\n') + '\n');
    }
  } catch { /* lost line — next tick appends again */ }
}

// Read the newest `limit` history entries (ascending order preserved; malformed
// lines dropped). Used by the gate's burn-rate projection — a missing/corrupt
// history just means no projection this check.
function readHistory(dir, limit) {
  try {
    const raw = fs.readFileSync(path.join(dir, HISTORY_FILE), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return (limit ? lines.slice(-limit) : lines)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// The one call a sensor makes per refresh. `incoming` = normalized reading
// ({five_pct, week_pct, five_reset, week_reset, session_id, cwd}, numbers or null).
// Returns { state, events, prev } — caller decides how to notify (each statusline
// owns its own spawn/env-guard policy).
function recordUsage(dir, incoming, cfg) {
  fs.mkdirSync(dir, { recursive: true });
  const statePath = path.join(dir, 'state.json');
  let prev = null;
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    prev = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch {}
  const now = Math.floor(Date.now() / 1000);
  const state = { ...incoming, updated_at: now };
  // Per-PID tmp + guarded rename: concurrent sessions share this dir, and a shared
  // tmp path made ~21% of concurrent refreshes crash on the rename (reproduced live);
  // Windows also throws EPERM if a long-hold reader has the target open — a lost
  // cycle must never crash the sensor (same contract the statuslines always had).
  try {
    const tmp = path.join(dir, `state.json.tmp.${process.pid}`);
    fs.writeFileSync(tmp, JSON.stringify(state));
    try { fs.renameSync(tmp, statePath); }
    catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  } catch { /* next refresh rewrites */ }
  appendHistory(dir, state, now);
  let events = [];
  try { events = detectResets(prev, state, cfg || {}); } catch {}
  try { events = events.concat(detectMeterDrops(prev, state)); } catch {}
  return { state, events, prev };
}

module.exports = { recordUsage, detectMeterDrops, readHistory, HISTORY_FILE };

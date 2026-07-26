// Brink core — reset-ping detector (pure, no I/O). Phase 6.
// Detects when a usage window has ROLLED OVER (its resets_at epoch jumped forward)
// so Brink can fire a "your budget is back" ping. Only meaningful for a window you
// were actually near the limit on — a floor gate keeps a reset from 12% silent
// (that is not budget you were waiting on, it is noise).
//
// prev / cur: { five_pct, week_pct, five_reset, week_reset }  (last-seen + current state)
// cfg.reset_ping: { five_hour:{enabled,floor}, seven_day:{enabled,floor} }
//
// Signal = resets_at advancing. Within a window resets_at is fixed; on rollover it
// jumps to the next window's end (hours for 5h, days for weekly). GUARD kills float
// jitter so only a genuine rollover counts.

const GUARD = 60; // seconds

const WINDOWS = [
  { key: 'five_hour', label: '5h',     pct: 'five_pct', reset: 'five_reset' },
  { key: 'seven_day', label: 'weekly', pct: 'week_pct', reset: 'week_reset' },
];

function detectResets(prev, cur, cfg) {
  if (!prev || !cur) return []; // first run (no prior state) never pings
  const rp = (cfg && cfg.reset_ping) || {};
  const events = [];
  for (const w of WINDOWS) {
    const spec = rp[w.key] || {};
    if (!spec.enabled) continue;
    const pr = prev[w.reset];
    const cr = cur[w.reset];
    if (typeof pr !== 'number' || typeof cr !== 'number') continue;
    if (cr <= pr + GUARD) continue; // didn't roll over
    const prevPct = prev[w.pct];
    const floor = typeof spec.floor === 'number' ? spec.floor : 0;
    if (typeof prevPct === 'number' && prevPct < floor) continue; // weren't near the limit
    events.push({
      windowKey: w.key,
      label: w.label,
      prevPct: typeof prevPct === 'number' ? Math.round(prevPct) : null,
      message: `Brink: ${w.label} limit reset - full quota again`
        + (typeof prevPct === 'number' ? ` (was ${Math.round(prevPct)}%)` : ''),
    });
  }
  return events;
}

module.exports = { detectResets, GUARD };

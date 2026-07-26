// Brink core — threshold decision engine (pure, no I/O). Phase 3.
// Shared by every adapter (Claude, Codex, ...). Given normalized usage + config,
// decide allow | warn | pause for the most-urgent window.
//
// usage: { five_pct, week_pct, five_reset, week_reset }  (pct = number 0-100 or null)
// cfg:   { five_hour:{warn:[75,85], pause:93}, seven_day:{warn:[80,90], pause:95} }

function bandFor(pct, spec) {
  // highest band crossed: 'pause' | 'warn:<n>' | null
  if (typeof pct !== 'number') return null;
  if (typeof spec.pause === 'number' && pct >= spec.pause) return 'pause';
  const warns = (spec.warn || []).slice().sort((a, b) => b - a); // high -> low
  for (const w of warns) if (pct >= w) return `warn:${w}`;
  return null;
}

function decide(usage, cfg) {
  const windows = [
    { key: 'five_hour', label: '5h', pct: usage.five_pct, reset: usage.five_reset },
    { key: 'seven_day', label: 'weekly', pct: usage.week_pct, reset: usage.week_reset },
  ];
  const hit = windows
    .map((w) => ({ ...w, band: bandFor(w.pct, cfg[w.key] || {}) }))
    .filter((w) => w.band);

  // pause beats warn; then higher pct wins
  hit.sort((a, b) => {
    const rank = (x) => (x.band === 'pause' ? 2 : 1);
    return rank(b) - rank(a) || b.pct - a.pct;
  });

  const top = hit[0];
  if (!top) return { action: 'allow' };
  return {
    action: top.band === 'pause' ? 'pause' : 'warn',
    band: top.band,
    window: top.label,
    windowKey: top.key,
    pct: top.pct,
    reset: top.reset,
  };
}

// --- Burn-rate projection (burn-in finding F1, 2026-07-16) ---
// The 07-12 MISS: heavy parallel-subagent burn crossed 93 -> 100 between checks, so
// the limit surfaced as a hard API error inside the running call instead of a pause.
// The gate cannot interrupt a tool call mid-flight — but at the LAST check before a
// long call it can look at the burn RATE: if usage is inside `headroom` points of
// the pause threshold and the sustained rate projects past it within
// `lookahead_min`, pause NOW. A few minutes early beats a hard wall mid-flight.
// Clamps keep it honest: needs >= min_span_sec of same-window samples (no verdicts
// from one noisy tick), a positive rate, and only fires near the threshold.

const PROJ_DEFAULT = { enabled: true, lookahead_min: 10, headroom: 12, min_span_sec: 120, window_sec: 600 };
const PROJ_GUARD = 60; // same-window reset-epoch tolerance, mirrors core/reset.js GUARD

function projectionCfg(raw) {
  const p = (raw && typeof raw.projection === 'object' && raw.projection) || {};
  const num = (v, d, min, max) => (Number.isFinite(v) && v >= min && v <= max ? v : d);
  return {
    enabled: p.enabled !== false, // default ON — this IS the shipped fix for the overshoot MISS
    lookahead_min: num(p.lookahead_min, PROJ_DEFAULT.lookahead_min, 1, 60),
    headroom: num(p.headroom, PROJ_DEFAULT.headroom, 1, 50),
    min_span_sec: num(p.min_span_sec, PROJ_DEFAULT.min_span_sec, 30, 3600),
    window_sec: num(p.window_sec, PROJ_DEFAULT.window_sec, 60, 7200),
  };
}

// samples: usage-history.jsonl entries ({t, five_pct, week_pct, five_reset,
// week_reset}). Returns a pause-shaped decision ({...decide() shape, projected:
// {rate_per_min, lookahead_min, threshold}}) or null. Pure — caller supplies now.
function projectedDecision(usage, samples, cfg, proj, nowSec) {
  if (!proj || !proj.enabled || !Array.isArray(samples) || samples.length === 0) return null;
  const now = Number.isFinite(nowSec) ? nowSec : Math.floor(Date.now() / 1000);
  const windows = [
    { key: 'five_hour', label: '5h', pctKey: 'five_pct', resetKey: 'five_reset' },
    { key: 'seven_day', label: 'weekly', pctKey: 'week_pct', resetKey: 'week_reset' },
  ];
  let best = null;
  let bestUrgency = -Infinity;
  for (const w of windows) {
    const cur = usage[w.pctKey];
    const curReset = usage[w.resetKey];
    const spec = cfg[w.key] || {};
    if (typeof cur !== 'number' || typeof spec.pause !== 'number') continue;
    if (cur >= spec.pause) continue;                // decide() already owns this
    if (cur < spec.pause - proj.headroom) continue; // not close enough to project from
    if (typeof curReset !== 'number') continue;     // can't prove same-window samples
    // Only samples from THIS window: a rate computed across a rollover is fiction.
    const eligible = samples
      .filter((s) => s && typeof s.t === 'number' && now - s.t <= proj.window_sec
        && typeof s[w.pctKey] === 'number' && typeof s[w.resetKey] === 'number'
        && Math.abs(s[w.resetKey] - curReset) <= PROJ_GUARD)
      .sort((a, b) => a.t - b.t);
    if (!eligible.length) continue;
    const oldest = eligible[0];
    const span = now - oldest.t;
    if (span < proj.min_span_sec) continue;         // not enough signal to call it a trend
    const rate = (cur - oldest[w.pctKey]) / (span / 60); // pct-points per minute
    if (rate <= 0) continue;
    const projected = cur + rate * proj.lookahead_min;
    if (projected < spec.pause) continue;
    const urgency = projected - spec.pause;
    if (urgency > bestUrgency) {
      bestUrgency = urgency;
      best = {
        action: 'pause', band: 'pause', window: w.label, windowKey: w.key,
        pct: cur, reset: curReset,
        projected: {
          rate_per_min: Math.round(rate * 10) / 10,
          lookahead_min: proj.lookahead_min,
          threshold: spec.pause,
        },
      };
    }
  }
  return best;
}

module.exports = { decide, bandFor, projectionCfg, projectedDecision };

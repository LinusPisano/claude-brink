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
//
// headroom 12 -> 20 (sensor-freeze report 2026-08-19). A 10-agent workflow fan-out
// burned 75% -> 102% of the 5h window in 8m15s (+3.3 pts/min) while the sensor sat
// frozen, and the projection never even got a vote: at headroom 12 it is only
// considered from 81%, and the last live reading was 75%. Replaying that history
// through projectedDecision() puts the cutoff at 18. 20 buys margin without arming
// the projection during ordinary work — from 73% it still needs a sustained
// 2 pts/min to fire, roughly triple a heavy interactive session.
const PROJ_DEFAULT = { enabled: true, lookahead_min: 10, headroom: 20, min_span_sec: 120, window_sec: 600, blind_cap_sec: 300 };
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
    // How far a measured rate may be carried across a frozen sensor. Defaults to the
    // staleness budget so there is one number for "how long a reading is worth
    // anything", not two that can drift apart.
    blind_cap_sec: num(p.blind_cap_sec, stalenessCfg(raw).max_age_sec, 0, 3600),
  };
}

// samples: usage-history.jsonl entries ({t, five_pct, week_pct, five_reset,
// week_reset}). Returns a pause-shaped decision ({...decide() shape, projected:
// {rate_per_min, lookahead_min, threshold}}) or null. Pure — caller supplies now.
// Time anchoring (sensor-freeze report 2026-08-19). `cur` is as-of the sensor's
// `updated_at`, NOT as-of now. The original code measured the span to `now`, so during
// a freeze the numerator stood still while the denominator grew: the measured rate
// decayed toward zero exactly when it mattered. In the 08-19 incident the rate read
// 4.3/min at the moment the sensor froze and 0.33/min five minutes later — the gate
// ran, and by then the arithmetic had talked itself out of pausing.
//
// So: measure the rate over the OBSERVED interval (oldest sample -> updated_at), then
// carry it across the blind interval (updated_at -> now) to estimate usage now, and
// judge headroom and the projection on THAT estimate. With a fresh sensor the blind
// interval is ~0 and this is identical to the old behaviour.
//
// The blind extrapolation is capped (`blind_cap_sec`, default = staleness.max_age_sec).
// Uncapped, a session idle for hours would pause on its first tool call purely because
// time passed — which is exactly the "pause on age alone" this project refuses to do.
function projectedDecision(usage, samples, cfg, proj, nowSec) {
  if (!proj || !proj.enabled || !Array.isArray(samples) || samples.length === 0) return null;
  const now = Number.isFinite(nowSec) ? nowSec : Math.floor(Date.now() / 1000);
  // When the reading carries no stamp we cannot tell fresh from frozen; treating it as
  // current keeps legacy state.json files on exactly the old code path.
  const stamp = Number(usage && usage.updated_at);
  const obsEnd = Number.isFinite(stamp) && stamp > 0 && stamp <= now ? stamp : now;
  const blindSec = Math.min(now - obsEnd, Math.max(0, proj.blind_cap_sec));
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
    if (typeof curReset !== 'number') continue;     // can't prove same-window samples
    // Only samples from THIS window, and only from the OBSERVED interval: a rate
    // computed across a rollover — or across the blind gap — is fiction.
    const inWindow = samples
      .filter((s) => s && typeof s.t === 'number' && s.t <= obsEnd && obsEnd - s.t <= proj.window_sec
        && typeof s[w.pctKey] === 'number' && typeof s[w.resetKey] === 'number'
        && Math.abs(s[w.resetKey] - curReset) <= PROJ_GUARD);
    if (!inWindow.length) continue;
    // Contradictory same-second rows exist in the wild (08-19: 26% and 73% stamped the
    // same second by the same session — different rate-limit buckets landing in one
    // file). Usage only climbs inside a window, so the lower twin is the artifact:
    // collapse each timestamp to its highest reading before picking a baseline. Taking
    // the low one inflates the rate and manufactures a pause out of noise.
    const byTime = new Map();
    for (const s of inWindow) {
      const prev = byTime.get(s.t);
      if (!prev || s[w.pctKey] > prev[w.pctKey]) byTime.set(s.t, s);
    }
    const eligible = [...byTime.values()].sort((a, b) => a.t - b.t);
    const oldest = eligible[0];
    const span = obsEnd - oldest.t;
    if (span < proj.min_span_sec) continue;         // not enough signal to call it a trend
    const rate = (cur - oldest[w.pctKey]) / (span / 60); // pct-points per minute
    if (rate <= 0) continue;
    // Best estimate of where the meter actually stands right now.
    const estNow = cur + rate * (blindSec / 60);
    if (estNow < spec.pause - proj.headroom) continue; // still not close enough to project from
    const projected = estNow + rate * proj.lookahead_min;
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
          // Only present when the reading was stale enough to matter — keeps the
          // fresh-sensor payload byte-identical to what callers already log.
          ...(blindSec > 0 ? {
            estimated_now: Math.round(estNow * 10) / 10,
            blind_sec: blindSec,
          } : {}),
        },
      };
    }
  }
  return best;
}

// --- Staleness guard (blind-spot report 2026-07-22, prioritised after the 07-27 hook test) ---
// Brink reads usage from the state.json its statusline writes, and the statusline only
// re-renders on MAIN-session activity. When work burns tokens away from the main
// conversation — a background fan-out, a long idle wait — that file freezes at its
// pre-burn value. The 07-27 test settled what was previously guessed: subagent tool
// calls DO reach the gate, so brink.js runs throughout such a burn. It allowed the
// 07-22 burn only because every check read a frozen number and believed it.
//
// A stale reading cannot tell us the real usage, so this NEVER pauses — pausing on age
// alone is pausing on no evidence. It reports, and the caller warns. What it does buy:
// a frozen "8%" stops being silently indistinguishable from a live "8%".
const STALE_DEFAULT = { enabled: true, max_age_sec: 300 };

function stalenessCfg(raw) {
  const s = (raw && typeof raw.staleness === 'object' && raw.staleness) || {};
  const n = Number(s.max_age_sec);
  return {
    enabled: s.enabled !== false, // default ON
    max_age_sec: Number.isFinite(n) && n >= 30 && n <= 86400 ? Math.floor(n) : STALE_DEFAULT.max_age_sec,
  };
}

// Returns null when fresh, disabled, or unjudgeable; otherwise {age_sec, max_age_sec}.
// Pure — the caller supplies `now` so this stays testable without clock games.
function stalenessCheck(usage, cfg, nowSec) {
  if (!cfg || !cfg.enabled || !usage) return null;
  const stamp = Number(usage.updated_at);
  // No stamp at all: a state.json written before updated_at existed. Unknown age is
  // not evidence of staleness — warning here would cry wolf on every legacy install.
  if (!Number.isFinite(stamp) || stamp <= 0) return null;
  const now = Number.isFinite(nowSec) ? nowSec : Math.floor(Date.now() / 1000);
  const age = now - stamp;
  // A stamp in the future means a skewed clock, not a stale read.
  if (age < 0) return null;
  if (age <= cfg.max_age_sec) return null;
  return { age_sec: age, max_age_sec: cfg.max_age_sec };
}

module.exports = { decide, bandFor, projectionCfg, projectedDecision, stalenessCfg, stalenessCheck, STALE_DEFAULT };

# Sensor freeze: a fan-out blew the 5h window through an 8-minute blind gap while the gate kept running

**Date:** 2026-08-19 (~11:20–11:40 Europe/Stockholm)
**Machine:** SEQRUS40 (Windows 11 Pro), Claude Code, brink v1.2.0
**Status:** confirmed, root-caused, measured, one fix decided (projection `headroom` 12 → 20)
**Severity:** high — the 5h window went 75% → 102% with no warn and no pause, on a fully green install

## What happened (observed)

A `Workflow()` fan-out — **10 subagents, 1,391,518 subagent tokens** — was launched from the
main session. The main session then went idle waiting for the completion notification while
the agents burned. The 5h window crossed **85% (warn)**, **93% (pause)** and **100%** inside a
single unobserved stretch. Brink fired neither the 85% warn nor the 93% pause. `brink doctor`
was **16/16 green** before, during and after the burn — nothing was broken; the monitor was
looking at a photograph.

This is the **third** appearance of the same signature: the 07-12 MISS
(`docs/burn-in-report-2026-07.md`, F1) and the 07-22 background fan-out blind spot
(`docs/token-blindspot-report-2026-07-22.md`). The burn-rate projection was built as the fix
for 07-12. This incident is the first time the projection has been replayed against real
history and shown to be **tuned too tight to fire**.

## Measurements (from `~/.claude/brink/usage-history.jsonl`)

| Time | 5h reading | Note |
|---|---|---|
| 11:22:02 | 52% | last quiet reading |
| 11:28:41 | 75% | **last fresh reading** — sensor freezes here |
| — | *(no samples)* | **8 min 15 s with zero readings** |
| 11:36:56 | 102% | already over; both 85% and 93% were crossed inside the gap |

Derived:

- **Observed rate across the gap:** 27 points / 8.25 min = **+3.3 points/min**.
- **Rate the projection itself computed** over its 600 s `window_sec` at the last fresh
  reading: **4.3 points/min** (steeper, because the 11:22 → 11:28 leg was already climbing —
  the projection's own arithmetic was *more* alarmed than the ex-post average).
- Both the 85% warn band and the 93% pause threshold fall strictly inside the gap. There was
  no reading at which `decide()` could have returned anything but `allow` — every value it
  ever saw was 75% or lower.

## Root-cause chain

1. **The sensor is the statusline, and the statusline only renders on MAIN-session activity.**
   The main session started the workflow and went idle. `state.json` froze at 75% while ten
   agents burned. This is the unchanged 07-22 root cause #1, now with a bigger fan-out behind it.
2. **The gate re-read the frozen number and believed it.** Every invocation during the gap read
   the same stale 75% and correctly (given its input) returned `allow`. The failure is stale
   *data*, not missing *invocation* — exactly as the 07-27 retraction in the 07-22 report says.
3. **The staleness guard DID detect it, and by design did nothing about it.** Two `stale_`
   markers were written (11:27:42 and 11:33:50) and two desktop notifications fired. Per
   `stalenessCheck()`'s contract in `src/core/thresholds.js`, the guard is advisory: *"A stale
   reading cannot tell us the real usage, so this NEVER pauses."* It told the truth to a screen
   nobody was watching, because the human's attention was on the workflow, not the terminal.
4. **The burn-rate projection missed by 6 percentage points.** `projectedDecision()` only
   considers a window once `cur >= pause - headroom`. With the shipped default
   `headroom: 12` that gate is `75 >= 93 - 12 = 81`. The last fresh reading was **75%**. The
   projection was never allowed to look at a rate that would have paused instantly.

## Evidence that the gate WAS running inside the blind gap

This matters because it retires the last live version of the "subagents bypass the hook"
hypothesis for the *background* `Workflow()` case, which the 07-22 report explicitly left open
("Still untested: … whether a *background* `Workflow()` … routes its subagents' calls through
the same hook is not yet proven, and that was the 07-22 configuration").

- A `stale_` marker can only be created by a gate run: `src/brink.js` lines 312–316 write
  `stale_<adapter>_<updated_at>` inside the `PreToolUse` path and nowhere else.
- `stale_claude_1787131721` was written at **11:33:50** — five minutes into the gap, with the
  main session idle.
- Therefore `brink.js` executed at 11:33:50, mid-burn, without main-session tool activity.

**Conclusion:** subagents do **not** bypass the hook, in the background-workflow configuration
too. The gate ran. It ran on a frozen sensor.

**What cannot be proven from the artifacts:** *which* session's tool call triggered the
11:33:50 gate run. The marker records the frozen `updated_at`, not the caller; the hook payload
is not persisted, and the transcripts do not carry a per-invocation gate log. The strong
inference is a subagent call (the main session was idle), but it is an inference, not a
measurement. If this needs to be settled, the cheap probe is to log `session_id` +
`tool_name` on every gate run for one fan-out.

## Why the projection didn't save it

The projection is not broken. It is correctly implemented and it was **arithmetically ready to
fire** — the rate it computed (4.3 p/min) projects 75% → 118% over the 10-minute lookahead,
comfortably past 93. It never got to run that arithmetic because of one guard line:

```js
if (cur < spec.pause - proj.headroom) continue; // not close enough to project from
```

`headroom: 12` encodes an assumption from July: *usage does not move more than ~12 points
before the next check*. At 3.3–4.3 points/min a modern fan-out covers 12 points in under four
minutes, and covers the whole 75 → 93 distance in about five. The headroom was sized for the
burn rates of single long calls, not ten-agent fan-outs.

## Headroom sweep (replay against the repo's own `projectedDecision()`)

Real `usage-history.jsonl` entries, real timestamps, `usage.five_pct = 75` at 11:28:41,
`lookahead_min: 10`, `min_span_sec: 120`, `window_sec: 600`, `five_hour.pause = 93`:

| `headroom` | Considered? (`75 >= 93 - h`) | Rate found | Projected | Decision |
|---|---|---|---|---|
| **12 (current default)** | no (needs ≥ 81) | — | — | no pause |
| 15 | no (needs ≥ 78) | — | — | no pause |
| **18** | yes (needs ≥ 75) | 4.3 p/min | 118% | **PAUSE** |
| 20 | yes | 4.3 p/min | 118% | **PAUSE** |
| 25 | yes | 4.3 p/min | 118% | **PAUSE** |
| 30 | yes | 4.3 p/min | 118% | **PAUSE** |

The boundary is exactly **18** — the incident sat one point below the cheapest headroom that
would have caught it, which is the least comfortable possible place for it to sit.

## The second defect: the rate decays during the freeze

Raising the headroom looked sufficient until the replay was run at the *other* timestamp.
The sweep above is evaluated at 11:28:41 — the instant the sensor froze. But the only
moment we can **prove** the gate ran is 11:33:50, five minutes later. Evaluated there:

| Evaluated at | Oldest eligible sample | Span | Rate | Verdict at any headroom ≤ 50 |
|---|---|---|---|---|
| 11:28:41 (freeze starts) | 34% @ 11:19:12 | 9.5 min | 4.32 /min | PAUSE (from headroom 18) |
| 11:33:50 (**proven** gate run) | 73% @ 11:27:46 | 6.1 min | **0.33 /min** | **no pause, at any value** |

The cause is an anchoring mismatch in `projectedDecision()`:

```js
const span = now - oldest.t;                       // measured to NOW
const rate = (cur - oldest[w.pctKey]) / (span / 60); // but `cur` is as-of updated_at
```

`cur` is pinned at the reading's `updated_at`. While the sensor is frozen the numerator
stands still and the denominator keeps growing, and the steep early samples slide out of
`window_sec` — so the measured rate **decays toward zero exactly while the real burn is at
its worst.** Headroom alone would therefore have covered only the first ~3 minutes of this
freeze, and only by luck of when a tool call happened to land.

A third, smaller defect surfaced in the same replay: the history contains contradictory
same-second rows. At 11:27:46 the same session wrote both `five_pct: 26` and `five_pct: 73`
(ten such contradictions exist in the file — different rate-limit buckets landing in one
log). `projectedDecision()` sorted by timestamp and took the first, so the low twin could
become the baseline and fabricate an 8 /min rate out of noise.

## Decision: fix the anchoring, and raise the headroom as a floor

Shipped in 1.3.0:

1. **Measure the rate over the observed interval, not to `now`.** Eligibility and span are
   anchored to `usage.updated_at`, so the rate reflects the interval the sensor actually
   sampled.
2. **Carry that rate across the blind interval.** `estNow = cur + rate * blind`, where
   `blind = min(now - updated_at, projection.blind_cap_sec)`. The headroom gate and the
   projection are then judged on `estNow` rather than on the frozen `cur`.
3. **Cap the extrapolation** (`blind_cap_sec`, default 300 = `staleness.max_age_sec`).
   Without it a session that merely sat idle would pause on its first tool call purely
   because time had passed — precisely the "pause on age alone" this project refuses to do.
4. **Collapse contradictory same-timestamp rows to their highest reading** before choosing a
   baseline. Usage only climbs inside a window, so the lower twin is the artifact.
5. **`projection.headroom` default 12 → 20.** Kept as a floor, not as the fix: it is what
   lets the projection look at a 75% reading at all.

A reading with no `updated_at`, or a fresh one, takes the identical code path as before:
`blind` is 0, `estNow == cur`, and the payload carries no extra fields. The whole existing
suite passes unchanged.

Replayed against the real history with the shipped defaults, the fixed code pauses at every
gate run inside the gap, including the proven one:

| Gate run | Blind interval | Estimated usage | Verdict |
|---|---|---|---|
| 11:29:41 | 60 s | 79.3% | PAUSE |
| 11:31:41 | 180 s | 88.0% | PAUSE |
| **11:33:50 (proven)** | 300 s (capped) | **96.6%** | **PAUSE** |

The real meter read 102% at 11:36:56, so a 96.6% estimate at 11:33:50 is about right.

## Honest bounds on the fix

- **It extrapolates; it does not see.** This covers a burn that was *already visibly
  climbing* when the reading froze. A fan-out that starts entirely inside the blind gap
  still has no rate to carry, and nothing here would catch it.
- **The cap cuts both ways.** Beyond `blind_cap_sec` the estimate stops growing, so a
  freeze longer than five minutes is under-estimated by design. That is the deliberate
  price of never pausing on age alone.
- **A false pause is now possible where none was before.** If the burn stopped at the moment
  the sensor froze, the estimate over-reads by up to `rate × 5 min`. That is recoverable
  (`brink release <sid>`, handoff written, resume armed); a blown window is not.
- **It changes nothing for existing installs.** `brink init` scaffolds every default into
  `config.json`, so a user pinned at `"headroom": 12` stays there. The machine this incident
  happened on was exactly that case.

## What is NOT fixed

1. **Sensor blindness remains the root cause.** The statusline is still the only usage
   source, it still renders only on main-session activity, and a main session idling behind
   a fan-out still freezes `state.json`. Everything above it is downstream of a sensor that
   stops sampling exactly when sampling matters. Fix option #2 from the 07-22 report — a
   usage source independent of the statusline render, polled by the watchdog — is still
   unbuilt and is still the only structural fix.
2. **The staleness guard still never pauses.** That remains deliberate, and this incident
   does not refute it. It does show the ceiling of an advisory signal: it detected the
   freeze twice, correctly, within a minute, and the window blew anyway.
3. **The gate cannot interrupt work already in flight.** A pause at 11:28:41 stops the
   *next* tool call; ten agents already mid-call keep burning.
4. **No fan-out-aware accounting.** Brink still has no notion that 10 agents are live, and
   `usage.subagent_tokens` (1,391,518 here) only arrives after the burn.
5. **`brink doctor` has no projection check at all.** 16/16 green was structurally incapable
   of catching any of this. A config pinned below the shipped default is invisible today.

## Follow-ups

1. **[cheap] Log `session_id` + `tool_name` on gate runs**, or at least on `stale_` marker
   creation, so the next incident can name the caller instead of inferring it.
2. **[cheap] Add a `brink doctor` check** for `projection.*`: warn when a config pins a
   value below the shipped default, and when the projection is disabled.
3. **[structural, still open] Statusline-independent usage sampling.** Three incidents now
   trace to the same frozen file. Everything shipped here buys margin against the symptom.
4. **[housekeeping] Stop scaffolding pure defaults into `config.json`**, or add a migration,
   so future default changes actually reach existing users.
5. **Re-replay the sweep after any future fan-out incident.** Real history against
   `projectedDecision()` is the cheapest honest test brink has for whether its tuning still
   matches the burn rates it faces.

---
*Filed the day of the incident, from the machine it happened on. The three timestamps in the
measurement table are the whole story: the monitor did not fail loudly, it simply stopped
being told anything — and then talked itself out of the one inference it could still make.*

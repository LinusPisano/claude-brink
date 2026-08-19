# Brink burn-in report — July 2026

**Period:** 2026-07-04 → 2026-07-16 (dogfooding from first install; the hardened launch build live from 2026-07-11, `e3f947e`).
**Finalized:** 2026-07-16, two days ahead of the planned 07-18 gate, on owner instruction — the merge of the watchdog (2026-07-16) made `main` the actual launch build, and the fixes below wanted maximum soak time before the Aug 1 launch. Addendum window stays open through 07-18; anything new gets appended.

## Environment

One machine (N=1 — the N=2 clean-machine test is a separate, still-open gate):

- Windows 11 Home, Windows Terminal, npm-global `claude`, Node 24.
- Anthropic Max 5x plan; usage sensor = author's own custom statusline patched with the Brink sensor (the auto-wrap path normal users get is exercised by tests + doctor, not by this dogfood).
- Config: thresholds 93 (5h) / 95 (weekly); **resume ON + `skip_permissions: true` + in-place preferred** (author's informed opt-in — NOT the shipping default, which is all-off); watchdog `auto` since 07-13.
- Build under test: `main` — `e3f947e` (07-11 hardening) → `f4da4e0` (07-14 fast-follow) → `68ad296` (07-16 watchdog merge) → `8e5b921` (07-16 v1 pause message).

## Raw event counts (from the debounce-flag record in `~/.claude/brink/`)

| Event | Count | Notes |
|---|---|---|
| 5h warn (75%) | 16 | 07-04 → 07-14 |
| 5h warn (85%) | 16 | escalation chains behaved (75 → 85 → pause) |
| **5h pauses** | **12** | 07-05 00:33 → 07-15 16:07 |
| Weekly warn (80%) | 1 | 07-14 23:32 — first time the weekly band was ever reached |
| Weekly warn (90%) | 1 | 07-15 14:51 |
| **Weekly pauses** | **1** (+1 same-window deny in a second session, 07-16 09:15) | 07-15 19:07 — first weekly pause ever |
| Auto-resumes fired (chain counters, 8 sessions) | **13** | max 3 per session; the `max_chain: 5` cap was never hit |
| Watchdog holds (hold-gate defers) | 3 | 07-13 17:05, window at pause threshold, held until the 21:30 reset |
| Watchdog revives | 3 | 07-13 21:31:33 / 21:36:39 / 21:41:28 — serial scan staggered them |

## Successes (the launch story is real)

- **S1 — Full organic cycle on the merged build (07-12 ~19:00):** pause at 99% via the deny-gate → HANDOFF written to the new out-of-repo path (`~/.claude/brink/<slug>/<sid>/`) → auto-resume in place after the 20:30 reset → session continued mid-task. The complete v1 contract, unattended, on the shipping code.
- **S2 — Repeat in-place chain resumes (07-11):** one session (494caf8c) paused at 94% and 93% across two 5h windows; each time the continue-prompt was injected into the live window after reset and the build continued. The tool resumed its own developer 3× while its hardening was being built.
- **S3 — Watchdog triple revive with hold-gate (07-13, <12h after the feature was built):** three sessions killed simultaneously mid-work (~21:27); the daemon held all three ("usage window at pause threshold") instead of burning chain links pre-reset, then revived them serially after 21:30. Zero human hands.
- **S4 — First-ever weekly escalation handled cleanly (07-14 → 07-16):** 80% warn → 90% warn → pause at 95%, across four different sessions arming on the same weekly reset. The window-independence design (5h vs 7d) worked on its first real weekly event.
- **S5 — Post-merge health:** watchdog merged to main (07-16), hooks cut over, `brink doctor` all-green, full suite green.

## Findings

### F1 — MISS: limit crossed inside a long tool call (07-12 ~14:50) — **fix shipped**

The 5h limit was reached *during* a running subagent (Agent tool); the burn crossed 93 → 100 between PreToolUse checks, the subagent died on the API error, and Brink never fired. The deny-gate runs before each tool call — it cannot interrupt one mid-flight, and heavy parallel-subagent burn moves faster than the check cadence.

**Fix (shipped 07-16): burn-rate projection.** The sensor now appends every reading to a rolling `usage-history.jsonl`; at each pre-tool check, if usage is within 12 points of the pause threshold **and** the sustained burn rate (≥2 min of samples in the same window) projects past the threshold within 10 minutes, Brink pauses pre-emptively with an honest "(pre-emptive)" message. Default ON, `projection.enabled: false` to opt out. This narrows the gap; it cannot close it (nothing can pause a call mid-flight) — documented in README caveats.

**Open sub-investigation:** whether subagent-internal tool calls traverse the user's PreToolUse hooks at all (if they do, the gate already covers them and only the single-long-call gap remains; if not, projection is the only cover). Test recipe: run a cheap subagent while a logging PreToolUse hook is active; check whether its tool calls appear.

> **RESOLVED 2026-08-19 — yes, they do, including background `Workflow()` fan-outs.** A `stale_` marker was written five minutes into an 8-minute sensor freeze while the main session was idle behind a 10-agent workflow; only a gate run writes one. The gate covers subagent calls — it was reading a frozen number, not failing to run. (What the artifacts cannot show is *which* session's call triggered that run; follow-up #1 in the 08-19 report is to log `session_id` on gate runs so the next one can name it.) See `sensor-freeze-report-2026-08-19.md`.
>
> **Note on the "12 points" figure above:** that was the shipped `projection.headroom` default at the time. It was raised to **20** on 2026-08-19, along with a fix to the rate anchoring — the arithmetic described in this paragraph measured the span to `now` while the reading was pinned at `updated_at`, so the rate decayed to nothing during exactly the freeze it was meant to cover. This report is left as written; the correction lives in the 08-19 report.

### F2 — Weekly meter dropped 95 → 4 without a reset (07-15 → 07-16) — **fix shipped, verdict corrected**

The 07-16 09:15 weekly pause quoted "resets Jul 19, 08:00" — but by ~10:42 the same window read 4% with the reset epoch unchanged. **The initial in-session diagnosis ("stale reading carried over from a cross-machine resume") was WRONG and is retracted:** the flag record shows an organic escalation (80% on 07-14 23:32, 90% on 07-15 14:51, pause 07-15 19:07) confirmed by four independent sessions arming on the same reset. The 95% was real when written.

**Verdict:** the provider adjusted the weekly meter/allowance out-of-band (cause external and unverifiable from Brink's data — plan/boost change, account adjustment, or server-side recalibration). Brink behaved correctly on the data it had; the harm was the pause message overstating the wait (budget was back within ~1.5h) and the armed auto-resumes staying scheduled for Jul 19.

**Fix (shipped 07-16): same-window meter-drop detection.** Within a window, real usage is monotonic — the sensor now treats a drop of ≥20 points (from ≥50%) with an unchanged reset epoch as "budget is back", fires a notification, and the event lands in `usage-history.jsonl` so the next anomaly is diagnosable from data instead of reconstruction. A freshness guard was considered and **rejected**: a stale-high reading in an unrolled window is still a valid lower bound (monotonicity), so refusing to pause on stale data would only *reduce correct pauses*.

**Residual (accepted):** auto-resumes armed before such a drop stay scheduled for the quoted reset (four sessions currently armed for Jul 19 08:00). Benign by design — the in-place idle guard won't inject into an active session, jobs self-delete after firing, and `max_chain` caps runaways — but expect a small thundering-herd of resume attempts at Jul 19 08:00. Watch it; that's F3's territory.

### F3 — Multi-session shared budget — **documented boundary (per the 2026-07-16 grill, D3)**

Several concurrent sessions share one account window; Brink gates each session correctly but does not coordinate a budget split, and post-reset multiple armed resumes can wake together. What exists and was **proven live on 07-13**: the watchdog hold-gate + serial scan (held a 3-session herd, staggered revives), per-session `max_chain`, and the hourly global revive backstop. Deeper cross-session coordination (shared ledger/locks) is deliberately deferred — unproven necessity, race-prone — now documented as a known boundary in the README. Data point to collect: the Jul 19 08:00 four-session resume herd.

## Gate verdicts

| Component | Verdict | Evidence |
|---|---|---|
| Sensor → state chain | **PASS** | 12+1 pauses, 34 warns, zero sensor crashes; doctor liveness green throughout |
| Deny-gate (pause) | **PASS with F1 caveat** | every threshold crossing in the main loop paused; the in-call crossing (F1) missed — projection now covers the approach path |
| Handoff | **PASS** | written on every pause, new out-of-repo path verified live (S1) |
| Resume — in place | **PASS** | S1, S2: repeat organic successes on the shipping build |
| Resume — headless/scheduled | **PASS** | 13 chained auto-resumes, cap never breached, no runaway |
| Watchdog | **PASS** | S3 organic triple revive + hold-gate, first live fire <12h after build |
| Notifications | **PASS** | warn/pause/reset-ping toasts fired; no silent outcomes observed |
| Doctor | **PASS** | caught the cutover state correctly; all-green post-merge |

## Launch-gate status

1. ~~Watchdog merge → main~~ **done 07-16** (`68ad296`).
2. ~~v1 pause message (off-switch + no-queue-yet)~~ **done 07-16** (`8e5b921`).
3. ~~Burn-in report~~ — **this document**.
4. ~~Gate-trust fixes~~ — **shipped 07-16** (projection, meter-drop detection, usage history, README boundaries).
5. **Second-machine (N=2) test — deferred to post-release.** v1 therefore ships on N=1, leaning on: `brink doctor` (built for exactly this), the green clean-install simulation run for this report (tarball → isolated install → `init` → `doctor`), and the README's honest support caveats (macOS "not yet verified on real hardware" remains true and published).

## Addendum 2026-07-19 — the predicted resume herd fired; the rails held (F3 data point)

F2/F3 predicted it: four sessions stayed armed on the weekly reset (Jul 19 08:00) after the meter-drop incident. This morning it played out, fully logged:

- **~08:02** — the four scheduled resumes fired (each session `chain → 1`), all headless (`claude --resume <sid> -p`; the paused terminals were long dead). **All died on `API Error: Unable to connect to API (ConnectionRefused)`** — the API was unreachable right after the reset (plausibly everyone's resumes hitting it at once) — leaving dead-pid busy markers.
- **08:11–08:34** — watchdog wave 1: serial revives of three sessions (`chain → 2` each, ~8 min stagger). All **FAILED exit 1**, same ConnectionRefused, logged per-session.
- **09:13–09:30** — watchdog wave 2 (retry next cycle, `chain → 3`): API reachable again → all three **finished ok**; at least one (0143049e) completed real work on revive (restarted a dev server + tunnel and finished its task).
- **08:35–10:14** — the fourth session (e91efcab, this report's author-session) was **held ~100 min by the hourly rate cap** (`max_revives_per_hour: 3`; one held-poll log line per minute), then revived at 10:14:59 (`chain → 2`) and verified state instead of redoing finished work.
- **HANDOFF delete-on-resume-fire verified live** — e91efcab's handoff was consumed by the 08:02 dispatch, exactly per the designed lifecycle.

**Verdict:** the F3 fear ("armed resumes wake together and re-spend the window") did NOT materialize — Task Scheduler + the serial scan + the hourly cap spread four wake-ups over two hours, and total new spend was ~one completed turn per session. Every rail engaged: chain caps counted every attempt, the rate cap held, retries recovered from the API outage unattended.

**New v1.1 findings from the event:**
1. **Failed revives burn chain links** — each session spent 3 of its 5 `max_chain` links to get ONE completed turn, because the ConnectionRefused attempts counted. A revive that exits non-zero having done no work should arguably not consume the same budget as a successful one (or should back off explicitly on connection-class failures).
2. **The two revival mechanisms don't know about each other** — scheduled resume (resume-once) and the watchdog independently own the same session; the scheduler's failed 08:02 resume is what created the marker the watchdog then spent two waves reviving. Double-coverage worked here, but the interaction was emergent, not designed.
3. **Post-reset API unavailability window is real** (~08:02 → somewhere before 09:13) — resume `buffer_seconds: 90` may deserve a jittered/backoff-aware default for weekly resets, when everyone's scheduled resumes fire at once.

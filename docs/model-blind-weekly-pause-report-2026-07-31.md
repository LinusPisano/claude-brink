# Brink pauses on a weekly meter the session's model may not share — and offers no session-scoped escape

**Date:** 2026-07-31 (~01:10 Europe/Stockholm)
**Status:** observed live; root cause verified in source; the quota-bucket question needs one probe test
**Severity:** high — a weekly pause has a multi-day horizon (this one: ~56 h to reset), so a false positive costs days, not minutes

## What happened (observed)

A long browser-automation session (Bolagsverket company-name registration, mid-form) was
running on **Fable 5** (`claude-fable-5`). Brink paused it twice:

1. **5h pre-emptive pause** at 20:41 (88% + burn-rate projection past 93%). Legitimate call.
   Auto-resume after the 21:40 reset worked, **but** the session's Chrome DevTools connection
   (`--autoConnect` against the user's real browser) did not survive the gap — Chrome's
   remote-debugging toggle is session-bound and had to be manually re-enabled + Chrome
   restarted before work could continue (~25 min of troubleshooting).
2. **Weekly pause** at 00:09 (`week_pct` 95 ≥ `seven_day.pause` 95), reset 2026-08-02 08:00 —
   a ~56-hour pause horizon. The user overrode it: *"we still have tokens for Fable."* After
   `brink off`, the session continued for a long tail of model turns and tool calls without
   hitting any platform limit.

While paused, **every** tool call was denied — including `brink --help` via PowerShell, i.e.
the very command the agent needed to find a narrower escape than the global kill switch. The
only advertised way out was `brink off`, which drops protection for **all** sessions on the
machine.

## Root cause (verified in source)

Brink's usage pipeline is **model-blind by construction**:

- `src/statusline-brink.js` reads exactly two buckets from the statusline payload —
  `rate_limits.five_hour.used_percentage` and `rate_limits.seven_day.used_percentage` — and
  persists them to `state.json`. The payload's `model` field is available on the same object
  (`j.model`) and is **never read**. Any additional per-model rate-limit buckets in the
  payload are silently dropped.
- `src/adapters/claude.js#readUsage()` normalizes to `{five_pct, week_pct, …}` — two numbers,
  no model dimension.
- `src/core/thresholds.js` evaluates those two numbers against `five_hour`/`seven_day`
  thresholds. There is nowhere for "which limit governs *this* session's model" to enter the
  decision.

So the weekly pause fired mechanically on `week_pct=95`. Whether that was *correct* depends on
a question Brink cannot currently ask: **does the `seven_day` bucket in the statusline payload
govern the session's model?**

### Verified vs. hypothesis (premise discipline)

- **Verified:** Brink reads only the two buckets above and ignores `j.model`
  (source-inspected). `state.json` showed `week_pct: 95` at pause time; the
  `notified_claude_seven_day_pause_1785650400` marker fired 00:09:42.
- **User-reported, plausible, untested:** Fable-class usage draws on a separate weekly
  allowance, so the 95% reading belonged to a bucket this session wasn't consuming. Consistent
  with the platform having per-model-tier weekly limits (as with Opus-specific weekly caps on
  Max plans), and with the session running on unhindered after the override — but continuing
  past a 95% *threshold* is not proof (the meter was at 95, not 100).
- **Not established:** whether Claude Code's statusline `rate_limits` already reflects the
  active model's bucket (in which case the pause was right and the user's mental model wrong),
  or reflects a shared/most-restrictive pool (in which case Brink false-paused).

## Evidence (this machine)

- `~/.claude/brink/state.json` at pause: `{"five_pct":20,"week_pct":95,"week_reset":1785650400,
  "session_id":"3dc8d7d9-…","cwd":"C:\\Users\\Pisan\\GitHub\\pisanolinus"}` — 5h window at a
  comfortable 20%; only the weekly meter tripped.
- Markers: `notified_claude_seven_day_pause_1785650400` (7/31 00:09), preceded by
  `…seven_day_warn_80…` (7/29 21:40) and `…warn_90…` (7/30 17:53) for the same window.
- Session model: `claude-fable-5` (session `3dc8d7d9`).
- `DISABLED` file created 7/31 01:10 (`brink off`) — the global hatch was the only unblock path.

## Defects filed

1. **Model-blind quota evaluation.** The pause decision uses a usage number with no model
   dimension while the payload carries `model` alongside it. Minimum fix: record `model` in
   `state.json` and `usage-history.jsonl` so post-hoc forensics can even see which model burned
   a window. Full fix depends on the probe below.
2. **No session-scoped kill switch.** `brink off` writes a global `DISABLED` file
   (`src/cli.js`), yet Brink already keeps per-session state dirs
   (`~/.claude/brink/<project>/<session-id>/`) and per-session `busy_<sid>` markers. A
   `brink release <sid>` (or `brink off --session <sid>`) that suppresses enforcement for one
   session — ideally offered *in the pause message itself* — would have kept the safety net up
   for everything else. For weekly pauses (multi-day horizon) this granularity is the
   difference between a surgical override and disarming the whole machine for the weekend.
3. **The deny-hook blocks Brink's own diagnostics.** While paused, `brink --help` (PowerShell)
   was denied like any other call. The agent could not introspect Brink to help the user find a
   narrower escape. Whitelist the `brink` CLI (or at least `--help`/`status`) in the PreToolUse
   deny path.
4. **Handoff template: external connections don't survive pauses.** The Chrome remote-debugging
   channel died across pause #1 (Chrome's toggle is session-bound; the MCP reconnect needed a
   toggle re-enable + full Chrome restart + a user consent prompt). The 07-27 handoff happened
   to warn about this because the *previous session's author* wrote it in manually. Make it
   structural: HANDOFF.md should carry a standing "step 0: re-verify external connections
   (browser CDP, tunnels, dev servers) before resuming the task list" line whenever the
   transcript shows MCP browser/tunnel tool use.

## Probe test (settles defect 1)

Capture the raw statusline JSON on a Fable session and on a Sonnet/Opus session in the same
week (`env_probe`-style tee before `statusline-brink.js` consumes stdin). Compare:

- Does `rate_limits` contain more keys than `five_hour`/`seven_day` (per-model buckets)?
- Does `seven_day.used_percentage` differ between the two sessions at the same wall-clock time?

If the payload is per-model: Brink's read was already correct and the 95% was Fable's own meter
— close defect 1 as invalid, keep 2–4. If the payload is shared: implement per-model thresholds
keyed on `j.model` (e.g. don't weekly-pause a model tier whose own bucket has headroom, or at
minimum downgrade pause → warn when `model` differs from the bucket's dominant consumer in
`usage-history.jsonl`).

## Fix options (prioritized)

1. **[cheap, do now] Record `model` in state + history.** One field in
   `statusline-brink.js`/`sensor-record.js`. Enables all later analysis.
2. **[cheap, high UX value] `brink release <sid>`** — per-session enforcement bypass file
   (`released_<sid>`), checked in `brink.js` next to the `DISABLED` hatch; advertise it in the
   pause/deny message.
3. **[cheap] Whitelist `brink` CLI in the deny path.**
4. **[after probe] Model-aware thresholds** per the probe outcome.
5. **[template] Standing "re-verify external connections" line in HANDOFF.md.**

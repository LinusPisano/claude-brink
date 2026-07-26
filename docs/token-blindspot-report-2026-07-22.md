# Brink blind spot: background fan-out (Workflow/subagents) burns tokens unmonitored

**Date:** 2026-07-22 (~02:00 Europe/Stockholm)
**Status:** confirmed, root-caused, not yet fixed
**Severity:** high — a single tool call can run to the session limit with zero Brink warning

## What happened (observed)

A `Workflow()` "deep-research" run (Claude Code background workflow) consumed **~5.02M
subagent tokens** across **104 agents / 554 tool uses / ~15 min**, and **hit the session
limit** ("You've hit your session limit · resets 2:10am"). The synthesis step + 1 agent
failed on the limit. **Brink issued no warn and no pause during the entire burn.** The user
only found out from the workflow's own completion notification.

## Root cause

Brink is a **main-session, hook-and-statusline-driven** usage monitor. Background fan-out
is invisible to it on three independent levels:

1. **Usage source is the statusline.** `src/adapters/claude.js#readUsage()` reads
   `~/.claude/brink/state.json`, which is written by the Brink **statusline**. The statusline
   only re-renders on **main-session activity**. While a background workflow runs and the main
   session sits idle waiting for the completion notification, the statusline never re-renders,
   so `state.json` is **frozen at the pre-burn value**.
2. **Decision logic only runs on main-session hooks.** Per `settings.json` / `hooks.json`,
   brink fires on `PreToolUse` (pause), `PostToolUse` (warn), `UserPromptSubmit` (busy),
   `Stop` (idle), `SessionEnd` (end). A workflow's **subagents do not fire the main session's
   hooks**, and no main-session tool call happens during the ~15 min burn → **brink.js is never
   invoked** while the tokens are being spent. Even if it were, per (1) it would read stale data.
3. **The watchdog doesn't watch usage.** `watchdog.mode` is `auto` (daemon running), but
   `src/core/watchdog.js` / `watchdog.ps1` only do **crash-revival** (dead PID + surviving
   `busy_<sid>.json` marker). There is **no periodic usage poll**, so nothing samples the burn.

Net: the 5h rate-limit window climbed to 100% unobserved. The tokens *did* count toward the
platform limit (the limit was hit) — Brink simply never sampled usage during the window when it
mattered, because nothing woke it.

## Evidence (this machine, 2026-07-22 ~02:14)

- `~/.claude/brink/state.json`: `five_pct=4` (5h window had just reset at 2:10), `week_pct=79`
  (just under the `seven_day` warn floor of 80).
- No `notified_claude_five_hour_warn_*` / `_pause_*` marker exists for the window that burned
  tonight (latest such markers predate the run) → brink fired nothing for it.
- Config in effect: `thresholds.five_hour = warn[75,85] / pause 93`,
  `seven_day = warn[80,90] / pause 95`; `watchdog.mode = "auto"`.
- Workflow usage (from the completion notification): `subagent_tokens 5,020,604`,
  `agent_count 104`, `tool_uses 554`, `duration_ms 893,940`, 2 agents errored on the limit.

## Fix options (prioritized)

1. **[cheap, highest value] Warn the instant a background fan-out launches.**
   The main-session **`PreToolUse`** hook (the `pause` path) *does* fire for the `Workflow`
   tool call itself (and `Task`/Agent spawns). Add a branch in `brink.js`: if
   `tool_name ∈ {Workflow, Task}`, emit a **one-shot toast** — e.g. *"⚠ background fan-out
   launched — Brink can't meter its token burn; it can run to the session limit unmonitored."*
   No usage data needed; directly addresses the exact failure above. Smallest change.

2. **[medium, the real fix] Independent usage poll in the watchdog daemon.**
   `watchdog.ps1` already loops every `poll_seconds`. Extend it to sample usage each cycle and
   toast when `five_pct`/`week_pct` cross the configured thresholds — **decoupled from
   main-session hooks**. Caveat: the current source (`state.json`) is itself stale while the
   session is idle, so the poll needs a source that stays fresh independent of the statusline
   (read Claude Code's own usage/transcript directly, or whatever the statusline reads from).
   This closes the "idle main session while background burns" gap generally, not just for workflows.

3. **[cheap] Staleness guard.** `state.json` carries `updated_at`. When a hook fires and
   `updated_at` is older than N minutes, toast *"Brink usage data is Nm stale — a background
   task may be burning unmonitored."* Cheap early warning that needs no new data source.

4. **[investigate] Background-task-complete signal.** Claude Code emits a `task-notification`
   on background-task completion carrying `usage.subagent_tokens`. If any hook/event exposes it
   to brink, log it to `usage-history.jsonl` and retroactively warn. Verify whether this is
   hookable today.

## Recommendation

Ship **#1** first (an afternoon's work, kills the surprise). Then do **#3** as a safety net,
and scope **#2** as the durable fix. #2 is the only one that also catches non-workflow idle
burns (e.g. a long single agent), so it's the strategic target once #1 stops the bleeding.

---
*Filed from a live session immediately after a background deep-research fan-out tripped
the account's session limit — the incident is the evidence.*

# Brink

> **Usage limits should be checkpoints, not walls.**

Brink pauses Claude Code gracefully at your usage limit, writes a handoff of exactly what was in flight, and — on Windows — resumes your live session in place the moment your quota resets. Elsewhere, you get the pause and the handoff; you resume by hand.

[![tests](https://github.com/LinusPisano/claude-brink/actions/workflows/test.yml/badge.svg)](https://github.com/LinusPisano/claude-brink/actions/workflows/test.yml) [![version](https://img.shields.io/badge/version-1.3.0-blue)](#status) [![platform](https://img.shields.io/badge/Claude%20Code-Windows%20%7C%20macOS%20%7C%20Linux-informational)](#support-matrix) [![license](https://img.shields.io/badge/license-MIT-blue)](#license)

<!-- DEMO GIF GOES HERE — replace with docs/demo.gif (captured separately: a real pause -> reset -> in-place resume cycle) -->
<p align="center"><em>[ demo.gif — Brink pausing at the limit, then nudging the same session back to life on reset ]</em></p>

## Quickstart

```bash
npm i -g claude-brink
brink init      # wires the hooks + usage sensor into Claude Code
brink doctor    # verifies the whole chain on YOUR machine
```

That's it. `brink init` is idempotent, backs up your `settings.json` first, and never clobbers an existing custom statusline (see [Config](#config)). Run `brink doctor` after — it exercises the real chain end-to-end and tells you loudly if anything on your machine isn't wired.

### Turn on auto-resume (opt-in — it ships OFF)

Out of the box Brink **pauses and writes the handoff, but does not resume anything**. If you also want it to bring your session back when the quota resets, flip one flag — two ways:

**Option A — edit the config yourself.** In `~/.claude/brink/config.json`:

```json
"resume": { "enabled": true }
```

**Option B — let your agent do it.** Paste this into Claude Code:

> Enable Brink auto-resume: in `~/.claude/brink/config.json`, set `resume.enabled` to `true`. Change nothing else, then show me the resulting `resume` block.

Why off by default? Auto-resume spends your fresh quota unattended and (on Windows) types into your live terminal — that's a choice you should make, not inherit. See [Config](#config) for the guardrails around it (`resume.max_chain`, `resume.skip_permissions`).

## How it works

1. A statusline sensor reads your usage percentage every refresh and writes it to a small state file.
2. A `PreToolUse` hook checks that file before every tool call. Below your threshold, it does nothing.
3. At threshold, it **blocks the next tool call** and writes a handoff — the task, the recent actions, what's next — captured from the session transcript itself, not asked of the model.
4. When your limit resets, Brink resumes: on Windows, it injects a `continue` into the *same* window that paused (in place, no new process); everywhere else, you pick the handoff back up yourself. See the support matrix below.

The deny is the mechanism — it's a real `PreToolUse` block, not a warning, so the pause actually happens before the wall.

## Support matrix

Brink v1 supports **Claude Code**. Here's exactly what you get and where:

| | Windows Terminal / conhost | Other Windows terminals (VS Code, Cursor, WSL, tmux, JetBrains) | macOS / Linux |
|---|---|---|---|
| Pause + `HANDOFF.md` | ✅ | ✅ | ✅ |
| Desktop notification | ✅ (toast) | ✅ (toast) | ✅ (`osascript` / `notify-send`, falls back to stderr if unsupported) |
| Resume on reset | ✅ **in place** — injects `continue` into your live session | ✅ automatic **headless fallback** (`claude --resume` in a fresh process) | ❌ not yet — pause + handoff only; resume manually. Auto-resume is Windows-only for now (roadmap). |

In-place resume is the headline feature, but it depends on being able to write keystrokes into your terminal's console buffer — that only works in Windows Terminal and classic conhost today. Everywhere else on Windows, Brink automatically falls back to relaunching `claude --resume` headlessly, so a reset is never a no-op. `brink doctor` confirms whether Brink can classify your current terminal at all, and warns if it can't — a warning means in-place will fall back to headless.

> **macOS / Linux:** the pause + handoff + notifier logic is plain, cross-platform Node. Since 2026-08-05 the test suite **runs on real macOS and Linux runners on every push** ([CI](https://github.com/LinusPisano/claude-brink/actions/workflows/test.yml)), so the cross-platform core — threshold and burn-rate maths, reset handling, handoff writing, `settings.json` install/uninstall, path handling, and the notifier's command construction and stderr fallback — is now continuously verified there rather than assumed.
>
> Two gaps remain, and they are the honest ones: the Windows-only suites self-skip on those runners (nothing to verify — that code is `.ps1`), and CI cannot prove the **end-to-end** story. Nobody has yet run Brink on a macOS or Linux desktop against a live Claude Code install and watched a real pause fire, or confirmed that `osascript` / `notify-send` actually surface a visible notification — the tests assert the command Brink *builds*, not that the desktop displays it. If you run it there, `brink doctor` output in an issue is still gold.

## Config

Brink reads `~/.claude/brink/config.json` (a starter copy is scaffolded there the first time you run `brink init` — see `config.example.json` in this repo for the annotated version).

| Key | Default | What it does |
|---|---|---|
| `thresholds.five_hour.pause` | `93` | % of the 5h window at which Brink pauses. |
| `thresholds.seven_day.pause` | `95` | % of the 7-day window at which Brink pauses. |
| `thresholds.*.warn` | `[warn1, warn2]` | Earlier heads-up percentages (notification only, no pause). |
| `projection.headroom` | `20` | How far below the pause threshold the burn-rate projection starts looking (so from `93 - 20 = 73%` on the 5h window). Raised from `12` after the 2026-08-19 sensor freeze, where the projection never got a vote. |
| `projection.blind_cap_sec` | `300` | Caps how far a measured burn rate may be carried across a **frozen** reading when estimating current usage. Bounds the estimate so idling can't pause you. |
| `notify.desktop` | `true` | Desktop notifications on/off. |
| `resume.enabled` | `false` | **Opt-in.** Turns on auto-resume after a reset. |
| `resume.in_place` | `true` | When resume is enabled: try injecting into the live session before falling back to headless. |
| `resume.skip_permissions` | `false` | Relaunches the headless fallback with `--dangerously-skip-permissions`. **This runs an autonomous agent unattended, in your project, with no permission prompts, while you're away.** Leave it `false` unless you fully accept that. |
| `resume.max_chain` | `5` | Caps consecutive auto-resumes per session so a runaway pause→resume loop can't burn every window for days (`0` = unlimited). |
| `resume.continue_prompt` | *(a default string)* | The text injected on **in-place resume only**. Must be plain text — no leading `/ ! @ #`, no newline. The headless fallback ignores this and uses a fixed "Read `<handoff>` and continue…" prompt. |
| `staleness.enabled` | `true` | Warn when the usage reading has gone stale (see the background fan-out caveat). Never pauses on age alone. |
| `staleness.max_age_sec` | `300` | How old a reading may be before Brink says it may be far behind. |
| `watchdog.mode` | `off` | **Opt-in, Windows-only.** The revive-after-kill watchdog (see below). `ask` = notify only; `auto` = revive automatically after the cancel window. Turn on with `brink watchdog on`, not by hand — the daemon needs registering too. |
| `watchdog.cancel_window_seconds` | `60` | `auto` mode: grace period between the "reviving in Ns" toast and the actual revive. `brink cancel` aborts it. |
| `watchdog.max_revives_per_hour` | `3` | Global backstop across all sessions (`0` = unlimited). Revives also count toward `resume.max_chain` per session. |

**Where files live:** Brink never writes into your repo. Everything — `HANDOFF.md`, resume context, the resume log — lives under `~/.claude/brink/<project-slug>/<session-id>/`, keyed off your project path so it never collides and never shows up in `git status`. Run **`brink handoff`** to print the newest one without hunting for the path yourself.

## Commands

```
brink init [--no-statusline] [--settings <path>]   install hooks + usage sensor
brink doctor [--no-toast]                          verify the whole chain end-to-end
brink handoff                                      print the newest paused session's HANDOFF.md
brink watchdog on [--mode auto|ask] | off | status revive-after-kill daemon (Windows)
brink revive [<session-id>]                        revive the newest dead mid-work session now
brink cancel                                       abort a pending auto-revive in its cancel window
brink off | on                                      kill switch — instant disable / re-enable
brink release <session-id> [--undo]                lift the pause for ONE session only
brink uninstall [--purge]                          remove cleanly, restores your original statusline
brink version
```

`brink off` is the escape hatch: it drops a file that makes every hook a no-op immediately, no reinstall needed. It disarms **every** session on the machine, though — for a weekly pause with a multi-day horizon, that can be more than you meant. `brink release <session-id>` is the surgical version: it lifts enforcement for that one session while everything else stays protected (the pause message prints the exact command with the id filled in; `--undo` re-arms it). While paused, a narrow slice of the `brink` CLI is let through the tool-call gate so the agent can tell you *why* it stopped and what your options are: `brink --help`, `brink doctor`, `brink version`. Args must be plain words on a single line — no shell metacharacters, no newlines, no chaining.

Everything that would actually lift the pause is denied to the agent, including `release` and `handoff`. That is deliberate: `brink release <sid>` disables enforcement for the session, so letting the paused agent run it would mean the agent can release itself, and the pause would only hold until it decided otherwise. Lifting the pause is yours. The pause message prints the exact command with your session id already filled in — run it in any terminal, including this one.

`brink uninstall` is surgical too — it removes Brink's own hook entries, restores your statusline (from the original the wrapper carries, so a statusline you adopted *after* installing Brink comes back correctly), and unregisters Brink's Windows scheduler entries: the watchdog logon task and any pending one-shot resumes. It never touches anything else in `settings.json`.

## Watchdog: survive a closed terminal (opt-in, Windows)

A usage pause arms its own resume *before* the session stops. But close the terminal window mid-task — or crash, or reboot — and the session dies with **nothing armed**: no hook fires, so nothing can bring it back. The watchdog closes that gap.

How it works:

1. Hooks keep a tiny **busy marker** per session: written when you submit a prompt, deleted when the turn finishes cleanly (or the session exits on purpose). A marker that outlives its process means *died mid-work*. No marker means you closed an idle session deliberately — it stays dead.
2. A single hidden **daemon** (a logon Task Scheduler job — no console window, ever) scans the markers every minute. Dead process + surviving marker → it revives the session headlessly: `claude --resume <session> -p "…continue the task…"` from your project root, using the absolute claude path recorded while the session was alive.
3. In `auto` mode you get a toast and a **cancel window** (default 60s — `brink cancel` aborts); in `ask` mode you just get the toast and decide yourself with `brink revive`.

Safety rails: revives count toward the same `resume.max_chain` cap as scheduled resumes; a global `max_revives_per_hour` backstop stops kill-loops; if a usage window is already at its pause threshold the revive **waits for the reset** instead of burning a chain link; and `brink watchdog off` (or the `DISABLED` kill-switch file) shuts the whole thing down.

Turn it on with `brink watchdog on` (defaults to `auto`; use `--mode ask` for notify-only). `brink doctor` verifies the hooks, the task, and that the daemon is actually alive.

## Roadmap

v1 is Claude Code only. Planned next, in no particular order:

- **Codex CLI** — adapter is already built and field-verified against Codex's own source, but Codex's `rate_limits` data is null upstream today ([openai/codex#14880](https://github.com/openai/codex/issues/14880)), so it can't arm yet.
- **Gemini CLI**
- **GitHub Copilot CLI**
- **Cursor**
- Auto-resume for macOS/Linux (launchd/cron equivalents of the Windows Task Scheduler path).
- **Model-aware weekly thresholds** — the usage meter Brink reads has no model dimension, so a weekly pause can fire on a bucket the session's model may not even be drawing from. Since 1.1.0 the session's model (and any extra rate-limit buckets in the payload) is recorded in state + usage history as groundwork; acting on it waits on a probe of whether the statusline meter is per-model or shared.

If you want one of these sooner, open an issue — real usage shapes the order.

## Honest caveats

- **Resume is opt-in and young.** It's off by default. Enabling it means an agent can restart and keep working **unattended, while you're away** — read the `skip_permissions` warning above before turning that on too.
- **In-place resume writes keystrokes, it doesn't confirm the model acted on them.** A successful injection means the text reached your terminal's input buffer, not that the turn ran to completion. Since 1.1.0 the dispatcher watches the session's own transcript after injecting — if it doesn't grow within a minute, the keystrokes are presumed to have landed in the wrong window and it falls back to a headless resume, logging every step to the session's `.claude-resume.log`. That verifies the input *arrived*; it still can't prove the turn ran to completion.
- **The watchdog can revive a session you killed on purpose.** If you force-kill mid-turn *because* the agent was doing something wrong, `auto` mode will try to bring it back — that's what the toast + cancel window (and `ask` mode) are for. And if you already resumed the session yourself elsewhere, a revive creates a second branch of the same conversation. The watchdog can't tell these apart; the cancel window is the guard.
- **The usage sensor depends on an undocumented Claude Code surface.** Claude Code pipes `rate_limits` to the statusline today; that's not a versioned API. Some API-key/enterprise setups don't receive usage data at all — `brink doctor` tells you if that's you.
- **A 5h reset doesn't clear the weekly cap.** Brink tracks both windows independently and tells you which one you're actually hitting.
- **A single long tool call can still burn past the thresholds.** The gate runs before each tool call and cannot interrupt one mid-flight — a heavy parallel-subagent run once crossed the limit *inside* a call and died on the raw API error. Burn-rate projection (on by default, `projection.enabled: false` to opt out) pauses pre-emptively when the sustained burn rate projects past the threshold; it narrows this gap, it doesn't close it.
- **Background fan-out can outrun the usage reading.** Work that burns tokens *away* from the main conversation — a background workflow, a large parallel subagent fan-out — can leave Brink's usage reading frozen. The reading comes from the statusline, which only refreshes on main-session activity, so while the main session waits, the number stops moving even as the real usage climbs. Observed on 2026-07-22: a fan-out spent ~5M tokens across 104 agents in ~15 minutes and hit the session limit with no warning and no pause. Again on 2026-08-19: a 10-agent workflow took the 5h window from 75% to 102% inside an 8-minute gap with no reading at all. **Since 1.0.1 Brink tells you when this is happening** — if the reading is older than `staleness.max_age_sec` (default 5 min) it warns that the number may be far behind. It deliberately does *not* pause on age alone: a stale reading cannot tell anyone the real usage, and pausing on no evidence would be worse than saying so. **Since 1.3.0 the burn-rate projection does partially cover it:** it measures the rate over the interval the sensor actually observed and carries it across the blind interval to estimate where the meter stands now, capped by `projection.blind_cap_sec` so idling alone can never push you over. That is an extrapolation, not a measurement — it covers a burn that was already visibly climbing when the reading froze, and nothing about one that starts afterwards. Still treat the staleness warning as "go check your usage yourself."
- **Several concurrent sessions share one account budget.** Each session pauses itself correctly, but Brink doesn't coordinate a budget *split* across sessions, and after a reset several armed resumes can wake together. The watchdog serializes its revives and holds them while the window is still at the pause threshold; deeper cross-session coordination is on the roadmap.
- **The provider can adjust the usage meter out-of-band.** We've observed the weekly meter drop 95% → 4% with the reset time unchanged. Within a window real usage only climbs, so Brink treats a big same-window drop as "budget is back" and notifies you — but a pause that fired just before such an adjustment will have quoted a reset date you didn't actually have to wait for.
- **The handoff is transcript text, and resume feeds it back to a model.** `HANDOFF.md` is assembled from your session — the last request, plus the recent tool targets (filenames, commands). On resume the model is told to read that file and continue, so anything in it is read in an instruction position. Not all of it is necessarily yours: hook- or MCP-injected context arrives as user-role text, and a filename in a repo you read is attacker-influenceable. Since 1.0.2 the transcript block is delivered as an explicitly-labelled untrusted, fenced block with fence sequences neutralised, so embedded text cannot break out or pose as directives. **This matters most if you enable `resume.skip_permissions`** — that combination hands an unattended, prompt-free agent a document it cannot vouch for. Leave it `false` unless you have a reason.
- **No unattended commits, ever.** Brink blocks a tool call and writes a file. It never touches your branch.

## Status

**v1.3.0 — the projection stops going blind when the sensor does.** On 2026-08-19 a 10-agent workflow took a 5h window from 75% to 102% inside an 8-minute gap with no reading at all, on a `brink doctor` 16/16-green install. The gate ran throughout — a `stale_` marker written five minutes into the gap proves it — and read the same frozen 75% every time. Two defects, both found by replaying the real `usage-history.jsonl` through this repo's own `projectedDecision()`: the burn-rate projection only woke at `pause - headroom` = 81%, so at 75% it never got a vote; and it measured the rate over the span to *now* while the reading was pinned at `updated_at`, so during a freeze the rate decayed toward zero exactly when it mattered — 4.3/min when the sensor froze, 0.33/min five minutes later. Now the rate is measured over the interval the sensor actually observed and carried across the blind interval to estimate current usage, capped by `projection.blind_cap_sec` so idling alone can't pause you; `projection.headroom` default moves `12 → 20`. Also fixed: contradictory same-second rows in the history (two readings 47 points apart, same session, same second) could be picked as the rate baseline and manufacture a pause out of noise. **Existing installs keep their pinned values** — `brink init` writes every default into your `config.json`, so if yours says `"headroom": 12` you keep 12. Edit it or re-scaffold to pick this up. See `docs/sensor-freeze-report-2026-08-19.md`.

**v1.2.0 — the escape hatches actually work now.** A second whole-repo review (multi-agent, every finding adversarially verified before it counted) found that `brink off` and `brink release` were only honoured on the pause path: an already-armed resume ignored both and would still nudge a live session at reset. It also found that the paused-session CLI allowlist admitted *every* `brink` subcommand — so a paused agent could run `brink off` or `brink uninstall --purge` and disarm the thing holding it. Both are fixed, along with a handoff that could be deleted for a resume that never ran, and a diagnostic log written in two incompatible encodings. Reviewing those fixes then caught four regressions inside them, which are fixed too. Every change ships with a regression test verified failing first. **If you are on 1.1.0 or earlier, upgrade** — `brink release <sid>` is only a real per-session disable from 1.2.0 on.

**v1.1.0 — first public release series.** The pause + handoff core has been through an adversarial review pass and twelve days of continuous dogfooding on **Windows 11** (12 real 5h pauses, a first weekly pause, 13 chained auto-resumes, 3 watchdog revives — the full record, including what it got wrong, is in [`docs/burn-in-report-2026-07.md`](docs/burn-in-report-2026-07.md)). 1.1.0 is the field-report release: per-session `brink release`, transcript-verified in-place resume with a dispatch log, handoff preservation, and model recording all come out of two dogfooding reports ([`docs/concurrent-resume-report-2026-07-27.md`](docs/concurrent-resume-report-2026-07-27.md), [`docs/model-blind-weekly-pause-report-2026-07-31.md`](docs/model-blind-weekly-pause-report-2026-07-31.md)). Resume and the cross-platform notifier are newer and have days, not months, of real-world runtime — that's why resume ships off by default and `brink doctor` exists. The macOS/Linux path is cross-platform by design and its core is now **exercised on real macOS and Linux runners in CI on every push**, but nobody has yet run it end-to-end against a live Claude Code install on those desktops (see the [support matrix](#support-matrix) for exactly what that does and doesn't cover). If you hit something, `brink doctor` output in a GitHub issue is the fastest way to help fix it.

Anthropic explicitly declined a configurable usage-threshold-alert feature request ([claude-code#17431](https://github.com/anthropics/claude-code/issues/17431)). Brink is that feature, built as a drop-in — plus the handoff and resume layer on top.

## Sponsors

Brink is free and MIT-licensed — no paywall, no gated features, and no plans to add one to v1. If it saves you a lockout, consider sponsoring the work: see the Sponsor button on this repo, or [github.com/sponsors/LinusPisano](https://github.com/sponsors/LinusPisano).

## License

[MIT](LICENSE).

## Author

Built by **Linus Pisano** — CAD + full-stack + agentic AI.

- [pisanolinus.com](https://pisanolinus.com)
- [linkedin.com/in/linus-pisano](https://www.linkedin.com/in/linus-pisano)
- [pisanolinus@gmail.com](mailto:pisanolinus@gmail.com)

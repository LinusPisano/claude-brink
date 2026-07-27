# Auto-resume never fired for a session that paused three times — report 2026-07-27

**Version:** 1.0.2 (published to npm)
**Severity:** high — the resume feature silently did not work, and its recovery artifact was destroyed
**Reported from:** a long MRC build session, `sid 1ae5fe6f-00de-4da1-af8e-e9c19321e894`, project slug `C--Users-Pisan`

## Symptom

The session paused three times on 2026-07-27 (05:20, 12:59, 16:16 arm times). Each pause
promised an auto-resume. **None of the three fired.** On all three occasions the human had
to manually type a variant of *"The usage limit has reset. Continue the task you paused
at"* to get work moving again — which is precisely the manual intervention Brink exists to
remove.

Worse, on the third pause the handoff file was **deleted** without the session ever being
resumed, so the promised recovery artifact did not exist when it was needed.

## Evidence (all verified, not inferred)

1. **The paused session's directory is empty.**
   `~/.claude/brink/C--Users-Pisan/1ae5fe6f-.../` contains no `HANDOFF.md`, no
   `resume-ctx.json`, no `.claude-resume.log`. Directory mtime `18:21` — one minute after
   the 18:20 reset, so something ran and left nothing behind.

2. **A concurrent session WAS resumed, at the same reset.**
   `~/.claude/brink/C--Users-Pisan/9188bc5f-.../.claude-resume.log`, written `18:22`,
   contains an assistant response in Swedish about the Brink repo, npm 1.0.2 and Obsidian
   UI files — an entirely different task from the paused session's work. That session
   received the resume; this one did not.

3. **Both sessions armed for all three of the same reset epochs.**
   ```
   armed_1ae5fe6f-..._1785133200   armed_9188bc5f-..._1785133200
   armed_1ae5fe6f-..._1785151200   armed_9188bc5f-..._1785151200
   armed_1ae5fe6f-..._1785169200   armed_9188bc5f-..._1785169200
   ```
   Two concurrent sessions, same project slug, competing for every reset.

4. **No scheduled tasks remain.** `schtasks /query` matches nothing for Brink — the
   `BrinkResume_<sid>` tasks self-cleaned, i.e. their dispatchers ran to completion and
   believed they were done.

5. **`writeHandoff` fails silently and the pause text claims success anyway.**
   `src/core/handoff.js:97-101` wraps the mkdir+write in `try { … } catch { return null }`.
   `src/brink.js:355` assigns the result to `handoffPath` and never checks it. The pause
   message then tells the model, unconditionally, that *"Your progress and next steps are
   already saved to <path>"*. If the write fails for any reason, the user is told the
   opposite of the truth.

## Root cause

Two distinct defects, either of which alone is enough to lose a session.

### A. In-place resume can report success without the target receiving anything, and then deletes the handoff

`src/resume-dispatch.ps1` sets `$resolved = $didInPlace`, and on `$resolved` deletes both
`resume-ctx.json` and `HANDOFF.md` (lines ~93-97). But `$didInPlace` reflects only that the
injection *call* succeeded — not that the intended session actually received a prompt.

`detect-terminal.ps1` resolves its target by walking the CIM process ancestry from the hook
PID. **With two concurrent Claude sessions under the same project slug, there is nothing in
that resolution tied to the session id.** If both sessions resolve to the same terminal — or
if one resolves to a window that is no longer the one hosting that conversation — the
injection lands somewhere other than the paused conversation while still reporting success.

The observed state matches this exactly: one session got a resume it had no use for
(*"the auto-resume fired by itself… it had nothing left to do"*), the other got nothing and
had its handoff deleted.

**The deletion is the damaging part.** The handoff is the recovery artifact; deleting it on
an unverified success turns a recoverable miss into an unrecoverable one.

### B. The in-place path is forensically silent

`resume-once.ps1` (headless) writes `.claude-resume.log`. The in-place path writes no log at
all. When in-place "succeeds" but nothing happens, there is **no record whatsoever** —
which is why this took a filesystem forensics pass to diagnose rather than reading a log.
That silence is also why three consecutive failures went unnoticed as a pattern.

## Suggested fixes

1. **Never delete the handoff on an unverified in-place success.** Either keep `HANDOFF.md`
   until a subsequent run observes the session actually advanced, or delete only on the
   headless path where the resume genuinely ran. Cheapest correct version: stop treating
   `$didInPlace` as proof and only delete when `resume-once.ps1` reports a real resume.
2. **Bind target resolution to the session id.** `detect-terminal.ps1` should confirm the
   resolved terminal actually hosts `-Sid`, and refuse to inject (falling back to headless)
   when it cannot. Today nothing prevents session A's dispatcher injecting into session B.
3. **Log the in-place path** to the same `.claude-resume.log`, including the resolved target
   PID, whether injection was attempted, and the outcome.
4. **Stop claiming the handoff was written when it wasn't.** `brink.js` should check
   `writeHandoff`'s return value and, on `null`, say so in the pause message instead of
   naming a path that does not exist.
5. **Consider a concurrency guard.** Two sessions in one project slug arming for the same
   reset is normal (long builds spawn sibling sessions); the dispatchers should not be able
   to service each other's pauses.

## Reproduction

Run two Claude sessions in the same project directory. Let both hit a Brink pause armed for
the same reset. At reset, observe: at most one session receives an injection, every
dispatcher self-cleans, and any session whose dispatcher reported in-place success has its
`HANDOFF.md` deleted regardless of whether that session advanced.

## Not root-caused

Which specific path ran for `1ae5fe6f` — in-place reporting a false success, or a headless
run that returned a non-42 code without reaching the conversation — cannot be determined,
because defect B means that path left no log. That gap is itself the first thing worth
closing.

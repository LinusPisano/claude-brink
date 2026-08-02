// Brink core — resume arming decision + arg builder (pure, no I/O). Phase 7.
// A paused Claude can't wake itself, so resume is EXTERNAL: on pause, Brink (opt-in)
// registers a one-shot Windows Task Scheduler job for the window's reset time that
// relaunches `claude --resume` from HANDOFF.md. This module decides WHETHER to arm
// and builds the PowerShell args; the actual scheduling lives in arm-resume.ps1.
//
// cfg.resume: { enabled:false, buffer_seconds:90, skip_permissions:false, max_chain:5,
//              in_place:true, continue_prompt:DEFAULT_CONTINUE }

// ASCII-only (pre-launch hardening Task 7): resume-ctx.json used to be written UTF-8
// WITHOUT a BOM, and PowerShell 5.1's ANSI-decode of a BOM-less file mangled a non-ASCII
// character here (an em-dash) before it reached the injected continue-prompt. brink.js
// now writes that file UTF-8-WITH-BOM, which fixes the general case, but the DEFAULT
// stays plain ASCII regardless of that plumbing so the common (unconfigured) path never
// depends on it.
const DEFAULT_CONTINUE = 'The usage limit has reset. Continue the task you paused before the pause - do not redo finished work.';
const DEFAULT_RESUME = { enabled: false, buffer_seconds: 90, skip_permissions: false, max_chain: 5, in_place: true, continue_prompt: DEFAULT_CONTINUE };

function resumeCfg(cfg) {
  const r = (cfg && cfg.resume) || {};
  const out = { ...DEFAULT_RESUME, ...r };
  // coerce / sanity-clamp
  out.enabled = out.enabled === true;
  out.buffer_seconds = Number.isFinite(out.buffer_seconds) && out.buffer_seconds >= 0
    ? Math.floor(out.buffer_seconds) : DEFAULT_RESUME.buffer_seconds;
  out.skip_permissions = out.skip_permissions === true;
  out.max_chain = Number.isFinite(out.max_chain) && out.max_chain >= 0
    ? Math.floor(out.max_chain) : DEFAULT_RESUME.max_chain;
  // Default true (pre-filled by the spread above); === true keeps it true only when the
  // merged value is the literal boolean true (default or explicit), same pattern as the
  // other bools in this file. Any non-boolean override (garbage config value) coerces
  // to false rather than silently staying enabled.
  out.in_place = out.in_place === true;
  const cp = typeof out.continue_prompt === 'string' ? out.continue_prompt.trim() : '';
  out.continue_prompt = (cp && !/^[\/!@#]/.test(cp) && !/\n/.test(cp)) ? cp : DEFAULT_CONTINUE;  // guard TUI-special/newline
  return out;
}

// Chain cap (safety): an unattended pause->resume->pause loop must not burn every
// window for days with nobody watching. `count` = auto-resumes already fired for this
// session; at/above max_chain we refuse to re-arm (0 = unlimited, documented).
function chainAllowed(cfg, count) {
  const max = resumeCfg(cfg).max_chain;
  if (max === 0) return true;
  const n = Number.isFinite(count) ? count : 0;
  return n < max;
}

// Arm only when: resume is enabled, we're on a platform with a scheduler (Windows in v1),
// and we actually have the session id + reset epoch the resume needs.
function shouldArm(cfg, ctx, platform) {
  if (!resumeCfg(cfg).enabled) return false;
  if (platform !== 'win32') return false;       // mac/Linux (launchd/cron) documented, not v1
  if (!ctx || !ctx.session_id) return false;
  if (typeof ctx.reset !== 'number' || !isFinite(ctx.reset)) return false;
  return true;
}

// PowerShell args for arm-resume.ps1. Strings only (spawn args).
// Proj is stripped of trailing (back)slashes: the scheduled task embeds it inside
// an escaped-quoted -Argument string, where a trailing backslash would escape the
// closing quote and mangle the whole command line (review finding).
// ctx.claude_exe (pre-launch hardening Task 8): claude's ABSOLUTE path, resolved by
// brink.js at arm time inside the interactive hook process (PATH intact) - threaded
// through arm-resume.ps1 -> resume-dispatch.ps1 -> resume-once.ps1 as -ClaudeExe so the
// scheduled Task Scheduler job (which only sees the persistent HKCU/HKLM registry PATH,
// not a version-manager shim / shell-hook / manually-edited profile PATH) can invoke
// claude directly instead of relying on a bare-name PATH lookup. Empty when unresolved -
// resume-once.ps1 falls back to its pre-existing bare `claude` lookup.
function armArgs(cfg, ctx) {
  const r = resumeCfg(cfg);
  const proj = String(ctx.proj || '').replace(/[\\/]+$/, '');
  return [
    '-ResetsAt', String(ctx.reset),
    '-Sid', String(ctx.session_id || ''),
    '-Proj', proj,
    '-Buffer', String(r.buffer_seconds),
    '-Skip', r.skip_permissions ? '1' : '0',
    '-ClaudeExe', String(ctx.claude_exe || ''),
  ];
}

// Deny-reason builder (pure). `armed` = whether a resume job is ACTUALLY registered
// for this reset — the tail must match reality. An unconditional "it will resume"
// with resume disabled made the paused session promise the user an auto-continue
// that never fired (burn-in finding 2026-07-05). Same principle as the save line:
// never claim an action that did not happen. Tool-neutral wording — this reason
// is shared by the claude and codex adapters.
function pauseReason({ pct, window, resetText, file, armed, projected, sid }) {
  // A pause DENIES the tool call that was in flight, so whatever this turn announced
  // it was doing never actually ran. Saying only "your progress is saved" invites the
  // model — and the user reading it — to treat the announced action as done. Burn-in
  // 2026-07-15: a safety-backup copy was announced, denied, and a later session almost
  // deleted a cloud remote trusting a backup that did not exist.
  const denied = `The tool call that was in flight was denied and did NOT run — nothing this turn said it was doing has taken effect. Re-verify any such action before relying on it. `;
  // Never claim a save that did not happen (review finding) — and never stay SILENT
  // about it either (report 2026-07-27 fix 4): a missing save clause reads as "nothing
  // to save", when the truth is the recovery artifact failed to write.
  const saved = file
    ? `Your notes and next steps (not your pending actions) are saved to ${file}. `
    : `A handoff file could NOT be written — include a short summary of where the task stands in your reply, it is the only record. `;
  const tail = armed
    ? `Brink has scheduled an auto-resume${file ? ' from the handoff' : ''} shortly after the reset`
    : `auto-resume is NOT armed — tell the user this session must be resumed manually after the reset`;
  // Projected (pre-emptive) pauses fire BELOW the threshold — the headline must say
  // so, or "paused at 84%" reads as a bug to the very user it just protected.
  const head = projected
    ? `Paused by Brink (pre-emptive): you are at ${Math.round(pct)}% of your ${window} usage limit and burning ~${projected.rate_per_min}%/min — projected past the ${projected.threshold}% pause threshold within ${projected.lookahead_min} min`
    : `Paused by Brink: you are at ${Math.round(pct)}% of your ${window} usage limit`;
  // The release hatch is advertised WITH the sid filled in: a weekly pause has a
  // multi-day horizon, and without this line the only escape the user learns about
  // is the global kill switch (report 2026-07-31 defect 2).
  const release = sid ? `, or lift the pause for JUST this session with \`brink release ${sid}\`` : '';
  return head +
    `${resetText ? `, which resets at ${resetText}` : ''}. ${denied}${saved}` +
    `Stop here and reply to the user in plain text — do not start new work; ${tail}. ` +
    `Tell the user: any prompts they send now won't be queued yet (that's coming) — and they can disable Brink for all sessions with \`brink off\`${release}.`;
}

module.exports = { resumeCfg, shouldArm, armArgs, chainAllowed, pauseReason, DEFAULT_RESUME, DEFAULT_CONTINUE };

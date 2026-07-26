// Brink core — per-session path helpers (pure, no I/O, no deps). Pre-launch hardening
// Task 1. Every Brink file that used to live in the user's repo (HANDOFF.md,
// .claude-resume.log, resume-ctx) now lives under
//   ~/.claude/brink/<project-slug>/<sid>/
// so a repo never carries Brink's droppings. This module only computes the strings;
// callers (handoff.js, brink.js, the PS resume scripts) do the actual I/O.
//
// <project-slug> encoding: the abs project dir with the drive-colon AND every path
// separator replaced by '-' — mirrors Claude Code's own ~/.claude/projects encoding.
//   C:\Users\Dev\GitHub\my-app  ->  C--Users-Dev-GitHub-my-app
// Git-bash paths (/c/Users/...) are normalized to the Windows drive form first (and
// the drive letter upper-cased) so the SAME project gets the SAME slug no matter which
// shell reports cwd — that's what makes this collision-safe rather than just readable.

const path = require('path');

function projectSlug(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return '_no-project';
  let p = cwd.trim();

  // git-bash / MSYS style drive prefix: /c/Users/... -> C:/Users/... (upper-cased).
  p = p.replace(/^\/([a-zA-Z])(?=\/|$)/, (_, d) => d.toUpperCase() + ':');

  // Windows drive-letter case is normalized too (c:\... and C:\... are the same project).
  p = p.replace(/^([a-zA-Z]):/, (_, d) => d.toUpperCase() + ':');

  // Trailing slash(es) never change the slug.
  p = p.replace(/[\\/]+$/, '');
  if (!p) return '_no-project';

  // Drive-colon + every remaining path separator (either flavor) -> '-'.
  // NOTE: do NOT trim leading/trailing dashes here. A dash produced by a path
  // separator is indistinguishable from a dash that is a literal char in the
  // folder name, so trimming would collapse two DIFFERENT real project dirs onto
  // the same slug (e.g. ...\proj- and ...\proj) — the exact collision this slug
  // exists to prevent. Trailing separators are already stripped above; a plain
  // unix absolute path keeps its leading dash by design.
  const slug = p.replace(/[\\/:]/g, '-');

  return slug || '_no-project';
}

function sanitizeSid(sid) {
  return String(sid == null ? '' : sid).replace(/[^\w.-]/g, '_');
}

function sessionDir(brinkDir, cwd, sid) {
  return path.join(brinkDir, projectSlug(cwd), sanitizeSid(sid));
}

function handoffPath(brinkDir, cwd, sid) {
  return path.join(sessionDir(brinkDir, cwd, sid), 'HANDOFF.md');
}

function resumeLogPath(brinkDir, cwd, sid) {
  return path.join(sessionDir(brinkDir, cwd, sid), '.claude-resume.log');
}

function ctxPath(brinkDir, cwd, sid) {
  return path.join(sessionDir(brinkDir, cwd, sid), 'resume-ctx.json');
}

module.exports = { projectSlug, sanitizeSid, sessionDir, handoffPath, resumeLogPath, ctxPath };

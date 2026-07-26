// Brink core — resolve claude's ABSOLUTE executable path via `Get-Command` (falls back
// to `where.exe`). Pre-launch hardening Task 8: a Task Scheduler job only sees the
// persistent HKCU/HKLM PATH, not a version-manager shim / shell-hook / manually-edited
// profile PATH, so a bare `claude` lookup that works fine interactively can silently fail
// inside the scheduled resume job. Resolving HERE (at arm time, inside the interactive
// hook process whose PATH is intact) and threading the absolute path through
// arm-resume.ps1 -> resume-dispatch.ps1 -> resume-once.ps1 as -ClaudeExe avoids that.
//
// Shared by brink.js (arms the resume with it) and cli.js `doctor` (Task 11: flags an
// empty resolution loudly instead of letting it fail silently at 3am reset time).
//
// Best-effort only: every branch is wrapped, and any failure just falls through to the
// next strategy / an empty string. Callers treat '' as "let the caller fall back to its
// own bare `claude` PATH lookup" (resume-once.ps1) or "warn — resume may not fire"
// (doctor).
const { spawnSync } = require('child_process');

function resolveClaudeExe() {
  try {
    const r = spawnSync('powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        "(Get-Command claude -All -ErrorAction SilentlyContinue | Where-Object { $_.CommandType -eq 'Application' -and $_.Source -like '*.cmd' } | Select-Object -First 1 -ExpandProperty Source)"],
      { encoding: 'utf8', timeout: 10000 });
    const out = (r.stdout || '').trim();
    if (out) return out;
  } catch {}
  try {
    const r2 = spawnSync('where.exe', ['claude'], { encoding: 'utf8', timeout: 10000 });
    const lines = (r2.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const cmd = lines.find((l) => /\.cmd$/i.test(l));
    if (cmd) return cmd;
    if (lines[0]) return lines[0];
  } catch {}
  return '';
}

module.exports = { resolveClaudeExe };

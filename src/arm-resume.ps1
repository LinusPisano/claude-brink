# Brink - arm resume (Phase 7, opt-in; resume-in-place forwarding added Phase 8)
# Registers a one-shot Windows Task Scheduler job for the reset time that runs
# resume-dispatch.ps1 (Task 7) - it prefers injecting "continue" into the live
# session (via -CtxPath, when brink.js recorded an injectable resume-ctx-<sid>.json
# at pause) and falls back to the existing headless `claude --resume` relaunch
# (resume-once.ps1) when no ctx was recorded or the live session is gone/uninjectable.
# Buffer/Skip/CtxPath/SessionDir are passed through from config.json / brink.js (core/resume.js).
# Invoked SYNCHRONOUSLY by brink.js (detached PowerShell dies without a console -
# live-fire finding 2026-07-04).
#
# BRINK_NO_SCHEDULE: when set, skip Task Scheduler entirely (test-only escape hatch -
# tests/resumectx.test.js exercises the resume-ctx write without touching the real
# scheduler; never set this in production). Exits NON-ZERO on purpose: brink.js treats
# exit 0 as "armed" and tells the user an auto-resume is scheduled. If this env var ever
# leaked into a real run, exit 0 would register nothing but still promise a resume (the
# 2026-07-05 false-promise class) - failing with a non-zero code instead degrades to
# brink.js's honest "arming FAILED / not armed" path.
param(
  [Parameter(Mandatory)][string]$ResetsAt,
  [string]$Sid,
  [string]$Proj,
  [int]$Buffer = 90,
  [string]$Skip = '0',
  [string]$CtxPath = '',
  [string]$SessionDir = '',
  [string]$ClaudeExe = ''
)

if ($env:BRINK_NO_SCHEDULE) { exit 3 }

$fireAt = [DateTimeOffset]::FromUnixTimeSeconds([int64]$ResetsAt).ToLocalTime().AddSeconds($Buffer).DateTime
# Sanitize the task name: session ids are normally uuid-safe, but Task Scheduler
# rejects several characters, and the name must round-trip to resume-dispatch.ps1.
$name = 'BrinkResume_' + ($Sid -replace '[^\w\-]', '_')
Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue

$dispatch = Join-Path $PSScriptRoot 'resume-dispatch.ps1'
# -ExecutionPolicy Bypass: stock Windows is Restricted and would refuse the script.
# -CtxPath is always passed (possibly empty) - resume-dispatch.ps1 treats a missing/
# empty/dead ctx as "no in-place target" and falls straight through to resume-once.ps1.
# SessionDir ends in the sanitized sid, not a path separator, so it shouldn't ever carry
# a trailing backslash - but strip one defensively anyway: a trailing backslash right
# before the closing quote would escape it and mangle the whole -Argument command line
# (the same hazard already handled for Proj at the JS layer, core/resume.js armArgs()).
$sessionDirClean = if ($SessionDir) { $SessionDir.TrimEnd('\') } else { '' }
# -ClaudeExe (pre-launch hardening Task 8): claude's ABSOLUTE path, resolved by brink.js
# at arm time in the interactive hook process (PATH intact) - forwarded through so the
# scheduled task's resume-once.ps1 can invoke claude directly instead of a bare-name
# PATH lookup, which a non-interactive scheduled task can fail to resolve for a claude
# installed via a version manager / shell hook / manually-edited profile. Possibly empty
# (unresolved) - resume-dispatch.ps1/resume-once.ps1 fall back to bare `claude` in that case.
$arg = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$dispatch`" -Sid `"$Sid`" -Proj `"$Proj`" -Buffer $Buffer -Skip `"$Skip`" -CtxPath `"$CtxPath`" -SessionDir `"$sessionDirClean`" -ClaudeExe `"$ClaudeExe`""
Register-ScheduledTask -TaskName $name -RunLevel Limited `
  -Action  (New-ScheduledTaskAction  -Execute 'powershell.exe' -Argument $arg) `
  -Trigger (New-ScheduledTaskTrigger  -Once -At $fireAt) `
  -Settings(New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries) -ErrorAction Stop | Out-Null

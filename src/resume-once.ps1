# Brink - resume once (Phase 7, opt-in)
# Fires at reset: relaunches Claude headless from HANDOFF.md, then cleans up its task.
# NOTE: fresh process - continuity depends entirely on HANDOFF.md + the session id.
# SessionDir (pre-launch hardening Task 4): the per-session dir under
# ~/.claude/brink/<slug>/<sid>/ where brink.js wrote HANDOFF.md. Falls back to $Proj
# when empty (an old scheduled task registered before this upgrade fired without it) so
# a stale in-flight task doesn't hard-crash instead of resuming.
param([string]$Sid, [string]$Proj, [int]$Buffer = 90, [string]$Skip = '0', [string]$SessionDir = '', [string]$ClaudeExe = '')
$sdir = if ($SessionDir) { $SessionDir } else { $Proj }

# Append ONE line to a log, UTF-8, opening and closing the handle each time.
#
# Encoding contract (code review 2026-08-05, finding 7): `*>> $log` writes UTF-16LE in
# PS 5.1 while bare Add-Content writes the ANSI codepage, so this one file used to end up
# in two incompatible encodings - the single diagnostic artifact the never-fail-silently
# design depends on was unreadable in any single decoding.
#
# Streaming contract (post-fix review 2026-08-06): the first attempt at that fix piped the
# whole run into ONE Add-Content (`... *>&1 | Add-Content`). Measured: that holds an
# EXCLUSIVE lock on the log for the entire resume and flushes only at the end - so the log
# is unreadable exactly while you want to watch it, and a killed resume loses everything.
# Per-line ForEach-Object keeps the file closed between writes: readable live, durable on kill.
#
# -LiteralPath, not -Path: a project path containing [ or ] is a wildcard to -Path, which
# would silently write nowhere and leave a resume looking successful with no log at all.
function Write-LogLine($path, $text) {
  try { Add-Content -LiteralPath $path -Value $text -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }
}

$taskName = 'BrinkResume_' + ($Sid -replace '[^\w\-]', '_')

# Project gone at fire time? Nothing to resume into - clean up and bail
# (previously Set-Location failed non-terminating and claude ran in System32).
if (-not ($Proj -and (Test-Path -LiteralPath $Proj))) {
  try { & node (Join-Path $PSScriptRoot 'notify.js') "Brink: resume skipped - project folder missing" | Out-Null } catch { }
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  return
}
Set-Location -LiteralPath $Proj    # scheduled tasks start in System32 otherwise

# Brink's state/flag directory. Defined here (rather than at the weekly-cap precheck
# below, where it used to live) because the escape-hatch gate immediately after needs it.
$brinkDir = if ($env:BRINK_DIR) { $env:BRINK_DIR } else { Join-Path $env:USERPROFILE '.claude\brink' }

# ---- escape-hatch gate (code review 2026-08-05, finding 3) ----
# resume-dispatch.ps1 gates on these too, but this script is a SEPARATE entry point: a
# scheduled task registered before the dispatcher existed points straight here, so the
# check has to live in both places or a legacy task walks around the kill switch.
# Artifacts are preserved (the user disabled the resume, not the handoff); the one-shot
# task is unregistered because it has already fired.
$hatchOnce = ''
if (Test-Path -LiteralPath (Join-Path $brinkDir 'DISABLED')) { $hatchOnce = 'brink off (global kill switch)' }
elseif (Test-Path -LiteralPath (Join-Path $brinkDir ('released_' + ($Sid -replace '[^\w.-]', '_')))) { $hatchOnce = "brink release $Sid (per-session)" }
if ($hatchOnce) {
  try { & node (Join-Path $PSScriptRoot 'notify.js') "Brink: auto-resume skipped for this session ($hatchOnce). Your handoff is still there." | Out-Null } catch { }
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  exit 0
}

# Weekly-cap pre-check: a 5h reset can fire while the 7-day window is still maxed -
# relaunching would just immediately re-pause. If last-known 7d usage is still at/above
# the weekly pause threshold, re-arm for the WEEKLY reset instead of relaunching now.
# (Uses the last state.json; it may be stale, but the 7d window moves slowly.)
$statePath = Join-Path $brinkDir 'state.json'
if (Test-Path $statePath) {
  try {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $weeklyPause = 95
    $cfgPath = Join-Path $brinkDir 'config.json'
    if (Test-Path $cfgPath) {
      $cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
      if ($cfg.thresholds.seven_day.pause) { $weeklyPause = [double]$cfg.thresholds.seven_day.pause }
    }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    if ($null -ne $state.week_pct -and [double]$state.week_pct -ge $weeklyPause -and
        $null -ne $state.week_reset -and [int64]$state.week_reset -gt $now) {
      # forward the user's configured buffer (previously silently reverted to 90),
      # SessionDir (so the re-armed task still knows where the handoff/log live - without
      # this, a second reset would silently drop back to the pre-Task-4 $Proj fallback),
      # and ClaudeExe (pre-launch hardening Task 8 - without this a second reset would
      # silently drop back to a bare `claude` PATH lookup even though the ORIGINAL arm
      # already resolved an absolute path).
      & (Join-Path $PSScriptRoot 'arm-resume.ps1') -ResetsAt ([string]$state.week_reset) -Sid $Sid -Proj $Proj -Buffer $Buffer -Skip $Skip -SessionDir $SessionDir -ClaudeExe $ClaudeExe
      # Sentinel exit code 42: "re-armed for a later reset, did NOT resume". Distinct from
      # the actual-resume paths below (which keep their existing exit semantics - whatever
      # $LASTEXITCODE claude itself returned) so the caller (resume-dispatch.ps1) can tell
      # a re-arm apart from a real resume attempt and skip deleting the resume-ctx/handoff
      # this re-armed weekly task will still need. 42 is arbitrary but reserved for this
      # one meaning everywhere it's checked (resume-dispatch.ps1 is the only reader) -
      # picked because it doesn't collide with PowerShell's own terminating-error code (1)
      # or any exit code claude.exe is documented to return.
      exit 42
    }
  } catch { }   # any parse issue -> fall through and just relaunch
}

# Chain accounting: brink.js reads chain_<sid> at arm time and stops re-arming at
# resume.max_chain (runaway-loop safety). Increment BEFORE launching so a crash
# mid-resume still counts toward the cap.
try {
  $chainFile = Join-Path $brinkDir ('chain_' + ($Sid -replace '[^\w.-]', '_'))
  $n = 0; if (Test-Path $chainFile) { $n = [int](Get-Content $chainFile -Raw -ErrorAction SilentlyContinue) }
  Set-Content -Path $chainFile -Value ($n + 1) -Encoding Ascii
} catch { }

if (-not (Test-Path -LiteralPath $sdir)) { New-Item -ItemType Directory -Path $sdir -Force -ErrorAction SilentlyContinue | Out-Null }
$handoffAbs = Join-Path $sdir 'HANDOFF.md'
# Absolute path, not a bare "HANDOFF.md" - the handoff no longer lives in $Proj (it's
# under the per-session Brink dir), and a bare basename would point the model at a
# file that isn't there.
$prompt = "Read $handoffAbs and continue the task from where it was paused. Do not redo finished work."
$log = Join-Path $sdir '.claude-resume.log'
# NEVER fail silently: the 13:00 no-show (2026-07-06) fired on time, errored
# ("No conversation found" - wrong project dir), self-deleted, and told no one.
# The user found out by coming back to a dead session. Toast the outcome, always.
$code = -1
# Launch record, written BEFORE claude runs. The old `*>> $log` redirect created the file
# even when claude printed nothing; a piped form does not run at all on empty output, so
# without this line a silent resume would leave NO log — the exact blind spot this file
# exists to close. It also timestamps the attempt itself, not just claude's output.
Write-LogLine $log "$((Get-Date).ToString('o')) [resume-once] launching claude --resume $Sid (skip=$Skip)"
try {
  # Build args once (splat); Skip only appends the danger flag. Two full command
  # lines diverged in review — the $log redirect had to be added to both.
  $cargs = @('--resume', $Sid, '-p', $prompt)
  if ($Skip -eq '1') { $cargs += '--dangerously-skip-permissions' }
  # Pre-launch hardening Task 8: prefer the ABSOLUTE claude path resolved by brink.js at
  # arm time (interactive-shell PATH intact) over a bare `claude` PATH lookup - the
  # scheduled Task Scheduler job running THIS script only sees the persistent HKCU/HKLM
  # registry PATH, which misses a claude installed via a version manager (fnm) / shell
  # hook / manually-edited profile. If $ClaudeExe is empty (never resolved) OR the file
  # has since moved/vanished (npm reinstall/uninstall between arm and fire), fall back to
  # the bare-name PATH lookup - but NEVER silently: log AND notify. If the bare lookup
  # then happens to succeed, the success toast below would otherwise fire and give the
  # user ZERO signal the hardened abs-path broke (the exact silent-degradation class
  # Brink exists to prevent - review fix). Keep the fallback itself (don't hard-fail).
  # Encoding contract (code review 2026-08-05, finding 7): `*>> $log` writes UTF-16LE in
  # PS 5.1 while bare `Add-Content` writes the ANSI codepage, so this ONE file used to end
  # up in two incompatible encodings — the single diagnostic artifact the whole
  # never-fail-silently design depends on was unreadable in any single decoding. Every
  # write here now goes through Add-Content -Encoding UTF8 (the merge `*>&1 |` captures
  # claude's stdout AND stderr, preserving the old redirect's coverage). This is also the
  # repo-wide UTF-8 rule for PowerShell that produces silent empty output when broken.
  if ($ClaudeExe -and (Test-Path -LiteralPath $ClaudeExe)) {
    & $ClaudeExe @cargs *>&1 | ForEach-Object { Write-LogLine $log $_ }
  } else {
    $why = if ($ClaudeExe) { "pinned claude path not found at fire time ($ClaudeExe)" } else { "no pinned claude path was resolved at arm time" }
    Write-LogLine $log "Brink: $why - falling back to bare 'claude' PATH lookup"
    try { & node (Join-Path $PSScriptRoot 'notify.js') "Brink: resume couldn't find the pinned claude path, trying PATH (headless resume may fail)" | Out-Null } catch { }
    claude @cargs *>&1 | ForEach-Object { Write-LogLine $log $_ }
  }
  $code = $LASTEXITCODE
} catch { Write-LogLine $log ($_ | Out-String) }
if ($code -eq 0) {
  try { & node (Join-Path $PSScriptRoot 'notify.js') "Brink: auto-resume finished - work continued from HANDOFF.md" | Out-Null } catch { }
} else {
  try { & node (Join-Path $PSScriptRoot 'notify.js') "Brink: auto-resume FAILED (exit $code) - see .claude-resume.log in $sdir" | Out-Null } catch { }
}

# Self-delete - but ONLY if no future trigger exists: the resumed session may have
# paused again and re-armed this same task name for the next reset; deleting it here
# would break resume chaining (review finding).
try {
  $t = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $next = [datetime]::Parse($t.Triggers[0].StartBoundary)
  if ($next -gt (Get-Date)) {
    # Re-armed during the resumed session - keep the task AND tell the dispatcher.
    # Code review 2026-08-05, finding 6: this used to `return`, which handed the
    # dispatcher whatever exit code claude produced (normally 0). The dispatcher read
    # that as "resolved" and deleted HANDOFF.md - the exact file the future trigger we
    # just preserved will point the model at when it fires. Sentinel 43 means "the
    # resume DID run, but a later trigger is armed, so the artifacts are still needed"
    # (distinct from 42 = "re-armed INSTEAD of resuming"). Both preserve; only 43 means
    # a resume actually happened.
    exit 43
  }
} catch { }
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

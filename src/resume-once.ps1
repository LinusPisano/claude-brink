# Brink - resume once (Phase 7, opt-in)
# Fires at reset: relaunches Claude headless from HANDOFF.md, then cleans up its task.
# NOTE: fresh process - continuity depends entirely on HANDOFF.md + the session id.
# SessionDir (pre-launch hardening Task 4): the per-session dir under
# ~/.claude/brink/<slug>/<sid>/ where brink.js wrote HANDOFF.md. Falls back to $Proj
# when empty (an old scheduled task registered before this upgrade fired without it) so
# a stale in-flight task doesn't hard-crash instead of resuming.
param([string]$Sid, [string]$Proj, [int]$Buffer = 90, [string]$Skip = '0', [string]$SessionDir = '', [string]$ClaudeExe = '')
$sdir = if ($SessionDir) { $SessionDir } else { $Proj }

$taskName = 'BrinkResume_' + ($Sid -replace '[^\w\-]', '_')

# Project gone at fire time? Nothing to resume into - clean up and bail
# (previously Set-Location failed non-terminating and claude ran in System32).
if (-not ($Proj -and (Test-Path -LiteralPath $Proj))) {
  try { & node (Join-Path $PSScriptRoot 'notify.js') "Brink: resume skipped - project folder missing" | Out-Null } catch { }
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  return
}
Set-Location -LiteralPath $Proj    # scheduled tasks start in System32 otherwise

# Weekly-cap pre-check: a 5h reset can fire while the 7-day window is still maxed -
# relaunching would just immediately re-pause. If last-known 7d usage is still at/above
# the weekly pause threshold, re-arm for the WEEKLY reset instead of relaunching now.
# (Uses the last state.json; it may be stale, but the 7d window moves slowly.)
$brinkDir = if ($env:BRINK_DIR) { $env:BRINK_DIR } else { Join-Path $env:USERPROFILE '.claude\brink' }
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
  if ($ClaudeExe -and (Test-Path -LiteralPath $ClaudeExe)) {
    & $ClaudeExe @cargs *>> $log
  } else {
    $why = if ($ClaudeExe) { "pinned claude path not found at fire time ($ClaudeExe)" } else { "no pinned claude path was resolved at arm time" }
    "Brink: $why - falling back to bare 'claude' PATH lookup" | Add-Content -Path $log
    try { & node (Join-Path $PSScriptRoot 'notify.js') "Brink: resume couldn't find the pinned claude path, trying PATH (headless resume may fail)" | Out-Null } catch { }
    claude @cargs *>> $log
  }
  $code = $LASTEXITCODE
} catch { $_ | Out-String | Add-Content -Path $log }
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
  if ($next -gt (Get-Date)) { return }   # re-armed during the resumed session - keep it
} catch { }
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

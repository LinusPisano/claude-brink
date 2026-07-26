# Brink - watchdog daemon (Watchdog feature, opt-in via config.json watchdog.mode).
#
# The one component of Brink that lives OUTSIDE the session: a single hidden
# PowerShell loop (installed at logon by watchdog-admin.ps1, launched flash-free
# through watchdog-launch.vbs) that scans the busy markers brink.js maintains
# (busy_<sid>.json - see core/watchdog.js for the lifecycle) and revives sessions
# whose process died while a turn was still in flight: terminal window closed
# mid-work, crash, reboot. A pause at a usage limit arms its own scheduled resume
# BEFORE the session stops; a kill fires no hook - this daemon is the only thing
# that can notice it.
#
# Revive = the proven headless path: `claude --resume <sid> -p <revive_prompt>`
# from the project root, using the ABSOLUTE claude path recorded in the marker at
# busy time (interactive PATH intact - the daemon itself only sees Task Scheduler's
# registry PATH, the exact failure Task 8 fixed for scheduled resumes).
#
# Safety rails, in scan order per dead marker:
#   1. stale (>14d)            -> delete silently; nothing left worth reviving
#   2. chain cap (chain_<sid>) -> notify + delete; mirrors brink.js's arm-time cap
#   3. usage window at pause   -> HOLD (keep marker); reviving now would insta-pause
#      threshold, unreset         and burn a chain link - the poll loop naturally
#                                 retries and proceeds once the reset epoch passes
#   4. hourly rate cap         -> HOLD; global backstop across all sids
#   5. mode 'ask'              -> notify once ("run: brink revive"), keep marker
#   6. mode 'auto'             -> notify, wait cancel_window_seconds (brink cancel
#                                 aborts), then revive
# Every revive increments chain_<sid> BEFORE launching (resume-once.ps1 pattern:
# a crash mid-revive still counts toward the cap) and appends to revive_history.
#
# Modes of this script:
#   (default)        run as the daemon: single-instance lock, scan every
#                    watchdog.poll_seconds, forever
#   -Once            one scan cycle, no lock, then exit (tests / manual debugging)
#   -Revive <x>      manual revive NOW ('newest' or a session id): skips the
#                    hold/cap gates (explicit user action) but still does chain
#                    accounting. Used by `brink revive` (ask mode's action).
#
# Config is re-read every cycle, so mode/threshold edits apply live; the DISABLED
# kill-switch file silences scanning without killing the daemon. Defaults below
# MUST mirror core/watchdog.js (the daemon can't require() a Node module).
param(
  [switch]$Once,
  [string]$Revive = ''
)

$ErrorActionPreference = 'Continue'
$brinkDir = if ($env:BRINK_DIR) { $env:BRINK_DIR } else { Join-Path $env:USERPROFILE '.claude\brink' }
$logFile  = Join-Path $brinkDir 'watchdog.log'
$lockFile = Join-Path $brinkDir 'watchdog.lock'
$cancelFile = Join-Path $brinkDir 'watchdog_cancel'
$historyFile = Join-Path $brinkDir 'revive_history'

function Log($m) {
  try {
    if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 1MB)) {
      # cheap rotation: keep the newest ~200 lines, drop the rest
      $tail = Get-Content $logFile -Tail 200
      Set-Content -Path $logFile -Value $tail -Encoding UTF8
    }
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Add-Content -Path $logFile -Encoding UTF8
  } catch { }
}
function Notify($m) { try { & node (Join-Path $PSScriptRoot 'notify.js') $m | Out-Null } catch { } }
# once-per-flag notify: same debounce pattern as brink.js's notified_ flags (and the
# same notified_ prefix, so brink.js's 14-day TTL GC sweeps these too)
function NotifyOnce($flagName, $m) {
  $flag = Join-Path $brinkDir (('notified_watchdog_' + $flagName) -replace '[^\w.-]', '_')
  if (-not (Test-Path $flag)) { New-Item -ItemType File -Path $flag -Force | Out-Null; Notify $m }
}
function Read-JsonFile($p) {
  # Get-Content -Raw sniffs the UTF-8 BOM brink.js writes (Task 7 encoding contract)
  try { return (Get-Content -LiteralPath $p -Raw -ErrorAction Stop | ConvertFrom-Json) } catch { return $null }
}
function Get-Epoch { return [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }

# Merged runtime config: watchdog block (defaults MUST mirror core/watchdog.js) plus
# the resume/threshold knobs the revive path shares with the scheduled-resume path.
function Get-Cfg {
  $c = @{
    mode = 'off'; poll_seconds = 60; cancel_window_seconds = 60; max_revives_per_hour = 3
    revive_prompt = 'This session was terminated unexpectedly while work was in progress. Review the recent conversation and continue the task - do not redo finished work.'
    max_chain = 5; skip_permissions = $false; five_pause = 93; weekly_pause = 95
  }
  $cfg = Read-JsonFile (Join-Path $brinkDir 'config.json')
  if ($cfg -and $cfg.watchdog) {
    $w = $cfg.watchdog
    if ($w.mode -in @('auto', 'ask')) { $c.mode = $w.mode }
    if ($null -ne $w.poll_seconds -and $w.poll_seconds -ge 10 -and $w.poll_seconds -le 3600) { $c.poll_seconds = [int]$w.poll_seconds }
    if ($null -ne $w.cancel_window_seconds -and $w.cancel_window_seconds -ge 0 -and $w.cancel_window_seconds -le 600) { $c.cancel_window_seconds = [int]$w.cancel_window_seconds }
    if ($null -ne $w.max_revives_per_hour -and $w.max_revives_per_hour -ge 0 -and $w.max_revives_per_hour -le 1000) { $c.max_revives_per_hour = [int]$w.max_revives_per_hour }
    # same TUI-input guard as core/watchdog.js: no leading / ! @ #, no newline
    if ($w.revive_prompt -is [string] -and $w.revive_prompt.Trim() -and $w.revive_prompt -notmatch '^[/!@#]' -and $w.revive_prompt -notmatch "`n") { $c.revive_prompt = $w.revive_prompt.Trim() }
  }
  if ($cfg -and $cfg.resume) {
    if ($null -ne $cfg.resume.max_chain -and $cfg.resume.max_chain -ge 0) { $c.max_chain = [int]$cfg.resume.max_chain }
    if ($cfg.resume.skip_permissions -eq $true) { $c.skip_permissions = $true }
  }
  if ($cfg -and $cfg.thresholds) {
    if ($null -ne $cfg.thresholds.five_hour.pause) { $c.five_pause = [double]$cfg.thresholds.five_hour.pause }
    if ($null -ne $cfg.thresholds.seven_day.pause) { $c.weekly_pause = [double]$cfg.thresholds.seven_day.pause }
  }
  return $c
}

# PID-reuse-guarded liveness: alive means "same pid AND same CreationDate" - byte-for-
# byte the resume-dispatch.ps1 check. A marker without a recorded start_time degrades
# to bare pid existence, which fails toward ALIVE on reuse - i.e. toward doing nothing,
# the safe direction for a watchdog.
function Test-SessionAlive($ProcId, $StartIso) {
  $live = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId" -ErrorAction SilentlyContinue
  if (-not $live) { return $false }
  if (-not $StartIso) { return $true }
  return (([datetime]$live.CreationDate).ToString('o') -eq $StartIso)
}

# Revive a dead session from its marker. Returns $true on a clean claude exit.
# NEVER silent (the 2026-07-06 no-show lesson): every outcome toasts + logs.
function Invoke-Revive($m, $markerFile, $c) {
  $sid = [string]$m.sid
  $proj = [string]$m.proj
  # chain accounting BEFORE launching (resume-once.ps1 pattern: a crash mid-revive
  # still counts), and the marker dies BEFORE launching so a wedged/crashed launch
  # can never re-fire on every poll cycle.
  try {
    $chainFile = Join-Path $brinkDir ('chain_' + ($sid -replace '[^\w.-]', '_'))
    $n = 0; if (Test-Path $chainFile) { $n = [int](Get-Content $chainFile -Raw -ErrorAction SilentlyContinue) }
    Set-Content -Path $chainFile -Value ($n + 1) -Encoding Ascii
  } catch { }
  try {
    Add-Content -Path $historyFile -Value (Get-Epoch)
    $lines = @(Get-Content $historyFile -ErrorAction SilentlyContinue)
    if ($lines.Count -gt 500) { Set-Content -Path $historyFile -Value ($lines | Select-Object -Last 100) }
  } catch { }
  try { Remove-Item -LiteralPath $markerFile -Force -ErrorAction SilentlyContinue } catch { }

  if (-not ($proj -and (Test-Path -LiteralPath $proj))) {
    Log "revive $sid skipped - project folder missing ($proj)"
    Notify 'Brink watchdog: revive skipped - project folder missing'
    return $false
  }
  # Revive log lives under the per-session Brink dir, never the user's repo; fall back
  # to the brink dir itself (NOT $proj) if an old marker predates session_dir.
  $sdir = if ($m.session_dir) { [string]$m.session_dir } else { $brinkDir }
  if (-not (Test-Path -LiteralPath $sdir)) { New-Item -ItemType Directory -Path $sdir -Force -ErrorAction SilentlyContinue | Out-Null }
  $rlog = Join-Path $sdir '.claude-watchdog.log'

  $cargs = @('--resume', $sid, '-p', $c.revive_prompt)
  if ($c.skip_permissions) { $cargs += '--dangerously-skip-permissions' }
  Log "reviving $sid in $proj (chain now $($n + 1))"
  $code = -1
  Push-Location -LiteralPath $proj   # `claude --resume` is project-scoped (2026-07-06 finding)
  try {
    if ($m.claude_exe -and (Test-Path -LiteralPath $m.claude_exe)) {
      & $m.claude_exe @cargs *>> $rlog
    } else {
      # Same never-silent degradation contract as resume-once.ps1: the pinned path
      # broke, we still try PATH, but the user gets a signal either way.
      $why = if ($m.claude_exe) { "pinned claude path not found ($($m.claude_exe))" } else { 'no pinned claude path in the marker' }
      "Brink watchdog: $why - falling back to bare 'claude' PATH lookup" | Add-Content -Path $rlog
      Notify 'Brink watchdog: pinned claude path missing, trying PATH (revive may fail)'
      claude @cargs *>> $rlog
    }
    $code = $LASTEXITCODE
  } catch { $_ | Out-String | Add-Content -Path $rlog } finally { Pop-Location }

  if ($code -eq 0) {
    Log "revive $sid finished ok"
    Notify 'Brink watchdog: revived the dead session - work continued'
    return $true
  }
  Log "revive $sid FAILED (exit $code) - see $rlog"
  Notify "Brink watchdog: revive FAILED (exit $code) - see .claude-watchdog.log in $sdir"
  return $false
}

function Get-DeadMarkers {
  $out = @()
  foreach ($f in @(Get-ChildItem -Path $brinkDir -Filter 'busy_*.json' -File -ErrorAction SilentlyContinue)) {
    $m = Read-JsonFile $f.FullName
    if (-not $m -or -not $m.sid -or -not $m.pid) { continue }   # unreadable/foreign - leave for TTL GC
    if (Test-SessionAlive $m.pid $m.start_time) { continue }
    $out += ,@($m, $f.FullName)
  }
  return ,$out
}

function Invoke-Scan($c) {
  foreach ($pair in (Get-DeadMarkers)) {
    $m = $pair[0]; $file = $pair[1]
    $sid = [string]$m.sid
    $now = Get-Epoch

    # 1. stale: nothing left worth reviving (mirrors brink.js's 14-day flag TTL)
    $updated = 0; if ($null -ne $m.updated) { $updated = [int64]$m.updated }
    if (($now - $updated) -gt (14 * 24 * 3600)) {
      Log "dropping stale marker $sid ($([int](($now - $updated) / 86400))d old)"
      Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
      continue
    }

    # 2. chain cap: terminal - same end state as brink.js refusing to re-arm
    if ($c.max_chain -gt 0) {
      $chainFile = Join-Path $brinkDir ('chain_' + ($sid -replace '[^\w.-]', '_'))
      $chain = 0
      if (Test-Path $chainFile) { try { $chain = [int](Get-Content $chainFile -Raw -ErrorAction SilentlyContinue) } catch { } }
      if ($chain -ge $c.max_chain) {
        Log "not reviving $sid - chain cap reached ($chain)"
        Notify "Brink watchdog: session died mid-work but the resume chain cap is reached ($chain) - resume manually"
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
        continue
      }
    }

    # 3. usage window at/above its pause threshold and not yet reset: reviving now
    #    would insta-pause and burn a chain link. HOLD - the poll loop retries, and
    #    once the reset epoch passes this gate stops matching. (state.json can be
    #    stale, but both epochs only move forward - same tolerance as resume-once.)
    $state = Read-JsonFile (Join-Path $brinkDir 'state.json')
    if ($state) {
      $capped = 0
      if ($null -ne $state.week_pct -and [double]$state.week_pct -ge $c.weekly_pause -and $null -ne $state.week_reset -and [int64]$state.week_reset -gt $now) { $capped = [int64]$state.week_reset }
      elseif ($null -ne $state.five_pct -and [double]$state.five_pct -ge $c.five_pause -and $null -ne $state.five_reset -and [int64]$state.five_reset -gt $now) { $capped = [int64]$state.five_reset }
      if ($capped -gt 0) {
        $at = [DateTimeOffset]::FromUnixTimeSeconds($capped).ToLocalTime().ToString('HH:mm')
        Log "holding revive of $sid - usage window at pause threshold until $at"
        NotifyOnce "defer_${sid}_$capped" "Brink watchdog: session died mid-work - reviving after the usage reset (~$at)"
        continue
      }
    }

    # 4. hourly rate cap: global backstop across all sids (a kill-loop between a
    #    watchdog revive and an instantly-dying claude must not spin all night)
    if ($c.max_revives_per_hour -gt 0) {
      $recent = 0
      foreach ($l in @(Get-Content $historyFile -ErrorAction SilentlyContinue)) {
        try { if (([int64]$l) -gt ($now - 3600)) { $recent++ } } catch { }
      }
      if ($recent -ge $c.max_revives_per_hour) {
        Log "holding revive of $sid - rate cap ($recent revives in the last hour)"
        NotifyOnce "rate_$([math]::Floor($now / 3600))" "Brink watchdog: revive rate cap reached ($recent/h) - holding further revives"
        continue
      }
    }

    if ($c.mode -eq 'ask') {
      NotifyOnce "ask_$sid" 'Brink watchdog: a session died mid-work - run: brink revive'
      continue
    }

    # mode 'auto': toast first, honor the cancel window, then revive
    if ($c.cancel_window_seconds -gt 0) {
      Notify "Brink watchdog: session died mid-work - auto-reviving in $($c.cancel_window_seconds)s (run: brink cancel)"
      Start-Sleep -Seconds $c.cancel_window_seconds
      if (Test-Path $cancelFile) {
        # single-use: consume it so a days-old cancel can't silently veto next week's revive
        Remove-Item -LiteralPath $cancelFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
        Log "revive of $sid canceled by user"
        Notify 'Brink watchdog: revive canceled'
        continue
      }
      if (-not (Test-Path -LiteralPath $file)) { continue }   # consumed meanwhile (manual brink revive)
    }
    Invoke-Revive $m $file $c | Out-Null
  }
}

# ---- entry ----

New-Item -ItemType Directory -Path $brinkDir -Force -ErrorAction SilentlyContinue | Out-Null

if ($Revive) {
  # Manual revive (`brink revive`): explicit user action, so the hold/cap gates are
  # skipped - chain accounting still applies inside Invoke-Revive. Console output on
  # purpose: this path runs attached to the user's terminal, not as the daemon.
  $c = Get-Cfg
  $dead = Get-DeadMarkers
  $pick = $null; $pickFile = $null
  foreach ($pair in $dead) {
    if ($Revive -ne 'newest' -and [string]$pair[0].sid -ne $Revive) { continue }
    if (-not $pick -or ([int64]$pair[0].updated) -gt ([int64]$pick.updated)) { $pick = $pair[0]; $pickFile = $pair[1] }
  }
  if (-not $pick) {
    Write-Output 'No dead mid-work session found to revive (no busy marker with a dead process).'
    exit 1
  }
  Write-Output "Reviving session $($pick.sid) in $($pick.proj) ..."
  $okRun = Invoke-Revive $pick $pickFile $c
  if ($okRun) { Write-Output 'Revive finished - the session continued headless. Check the toast / your project.' ; exit 0 }
  Write-Output 'Revive FAILED - see .claude-watchdog.log in the session dir (brink watchdog status shows it).'
  exit 1
}

if ($Once) { Invoke-Scan (Get-Cfg); exit 0 }

# Daemon mode: single instance via a pid+start lock (PID-reuse guarded, same idea as
# the session liveness check). A dead lock is simply overwritten.
$old = Read-JsonFile $lockFile
if ($old -and $old.pid -and (Test-SessionAlive $old.pid $old.start)) { exit 0 }
$self = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction SilentlyContinue
$selfStart = if ($self) { ([datetime]$self.CreationDate).ToString('o') } else { $null }
@{ pid = $PID; start = $selfStart } | ConvertTo-Json -Compress | Set-Content -Path $lockFile -Encoding UTF8
Log "watchdog daemon started (pid $PID)"

while ($true) {
  $c = Get-Cfg
  $disabled = Test-Path (Join-Path $brinkDir 'DISABLED')
  if (-not $disabled -and $c.mode -ne 'off') {
    try { Invoke-Scan $c } catch { Log "scan error: $($_.Exception.Message)" }
  }
  Start-Sleep -Seconds $c.poll_seconds
}

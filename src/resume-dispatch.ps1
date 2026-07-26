# Brink — resume dispatcher (Phase 8). At reset: try in-place injection into the live
# session; fall back to the headless resume-once.ps1 if the session is gone/uninjectable.
#
# BRINK_DISPATCH_DETECT_OVERRIDE (test-only, mirrors brink.js's BRINK_DETECT_OVERRIDE):
# a fabricated {HasWinConsole,Terminal,Confidence} JSON result, consumed INSTEAD of a
# live Detect-ClaudeTerminal call for the "still injectable?" re-detection step only.
# The PID-reuse liveness check just above it always queries live Win32_Process — that
# part is deterministic on its own (a real pid we spawned either matches or it doesn't,
# no ancestry-walk environment sensitivity) and must stay real so the guard is actually
# exercised by tests. Re-detection is the one step whose classification depends on the
# ambient terminal ancestry of whatever spawned the test process, which is why it alone
# gets the override seam. Never set in production; the real path calls Detect-ClaudeTerminal.
param(
  [Parameter(Mandatory)][string]$Sid, [string]$Proj, [int]$Buffer = 90, [string]$Skip = '0',
  [string]$CtxPath, [string]$SessionDir = '', [string]$ClaudeExe = ''
)
$here = $PSScriptRoot
function Notify($m){ try { & node (Join-Path $here 'notify.js') $m | Out-Null } catch {} }

$didInPlace = $false
if ($CtxPath -and (Test-Path -LiteralPath $CtxPath)) {
  try {
    $ctx = Get-Content -LiteralPath $CtxPath -Raw | ConvertFrom-Json
    # Re-validate the recorded session is still alive with the SAME start time (PID-reuse guard).
    $live = Get-CimInstance Win32_Process -Filter "ProcessId=$($ctx.SessionPid)" -ErrorAction SilentlyContinue
    $sameStart = $live -and $ctx.SessionStartTime -and ([datetime]$live.CreationDate).ToString('o') -eq $ctx.SessionStartTime
    if ($sameStart) {
      # Re-detect to confirm still injectable (terminal could have changed since pause).
      if ($env:BRINK_DISPATCH_DETECT_OVERRIDE) {
        try { $det = $env:BRINK_DISPATCH_DETECT_OVERRIDE | ConvertFrom-Json } catch { $det = $null }
      } else {
        . (Join-Path $here 'detect-terminal.ps1')
        $det = Detect-ClaudeTerminal -TargetPid ([int]$ctx.SessionPid)
      }
      if ($det -and $det.HasWinConsole -and ($det.Terminal -in @('WindowsTerminal','Conhost')) -and $det.Confidence -ne 'Low') {
        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'inject-continue.ps1') -TargetPid ([int]$ctx.SessionPid) -Text $ctx.continue_prompt | Out-Null
        $ok = $LASTEXITCODE -eq 0
        # Honest wording (pre-launch hardening Task 9): injector exit 0 only means the
        # keystrokes were WRITTEN to the console buffer, not that Claude actually
        # submitted them and continued the turn (write-success != submit-success) - we
        # have no signal back from the live session to confirm the turn ran.
        if ($ok) {
          $didInPlace = $true
          # Chain accounting (safety gap fix, pre-launch hardening): brink.js reads
          # chain_<sid> at arm time and stops re-arming at resume.max_chain (runaway-loop
          # safety - see the arm block in src/brink.js). resume-once.ps1 only increments
          # this counter on the HEADLESS path; without a matching increment here, a
          # session that keeps pausing and resuming IN-PLACE never advances chain_<sid>,
          # so chainAllowed() always passes and the cap never trips - the headline
          # max_chain feature would be silently uncapped for in-place resumes. Mirrors
          # resume-once.ps1 exactly: same brink-dir resolution, same filename
          # sanitization. Own try/catch and best-effort - a failure to persist this
          # counter must never undo/block the in-place resume that already succeeded.
          try {
            $brinkDir = if ($env:BRINK_DIR) { $env:BRINK_DIR } else { Join-Path $env:USERPROFILE '.claude\brink' }
            $chainFile = Join-Path $brinkDir ('chain_' + ($Sid -replace '[^\w.-]', '_'))
            $n = 0; if (Test-Path $chainFile) { $n = [int](Get-Content $chainFile -Raw -ErrorAction SilentlyContinue) }
            Set-Content -Path $chainFile -Value ($n + 1) -Encoding Ascii
          } catch { }
          Notify 'Brink: nudged your live session to continue'
        }
        else { Notify 'Brink: in-place injection failed - falling back to headless resume' }
      }
    }
  } catch { Notify "Brink: dispatch error ($($_.Exception.Message)) - falling back to headless" }
}

$resolved = $didInPlace
if (-not $didInPlace) {
  # Defensively quote the string params: this spawns powershell.exe as a native child
  # process, and PS 5.1's native-arg passing can drop/split bare (unquoted) variables -
  # most notably an empty string silently vanishing instead of arriving as "" - which
  # would shift every argument after it. Wrapping each in "$var" pins it as one token
  # even when empty (-ClaudeExe '') or when it contains spaces (a homedir path).
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'resume-once.ps1') -Sid $Sid -Proj "$Proj" -Buffer $Buffer -Skip $Skip -SessionDir "$SessionDir" -ClaudeExe "$ClaudeExe"
  # Sentinel exit code 42 (see resume-once.ps1): the headless fallback hit its weekly-cap
  # precheck and RE-ARMED for a later reset instead of actually resuming - the pause is
  # NOT resolved in that case. Any other exit code means resume-once.ps1 actually attempted
  # the resume (whatever claude itself returned), so the pause IS resolved.
  $resolved = ($LASTEXITCODE -ne 42)
}

# Cleanup: consume the resume-ctx and delete this session's handoff, but ONLY once the
# pause is actually RESOLVED - in-place injection succeeded, or the headless
# resume-once.ps1 really resumed (not just re-armed). Grouped together since both are
# "this pause is over, forget its per-session scratch files". Deferred to here (rather
# than right after the in-place attempt above) so the handoff still exists for
# resume-once.ps1's headless prompt to read when the in-place path didn't fire.
# On a re-arm (headless sentinel exit 42) both deletes are skipped on purpose: the
# re-armed weekly task still needs the ctx/handoff when it eventually fires, and deleting
# them here would force it to fall back to `claude --resume <sid>` restoring the
# transcript from scratch instead of retrying in-place - wasteful but previously silent
# (this replaces the prior unconditional-delete gap).
if ($resolved) {
  if ($CtxPath) { try { Remove-Item -LiteralPath $CtxPath -Force -ErrorAction SilentlyContinue } catch {} }
  if ($SessionDir) { try { Remove-Item -LiteralPath (Join-Path $SessionDir 'HANDOFF.md') -Force -ErrorAction SilentlyContinue } catch {} }
}

# Self-clean the task (reuse resume-once's guard: keep if a future trigger was re-armed
# during whichever path just ran - e.g. resume-once's own weekly-cap re-arm).
$taskName = 'BrinkResume_' + ($Sid -replace '[^\w\-]', '_')
try {
  $t = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $next = [datetime]::Parse($t.Triggers[0].StartBoundary)
  if ($next -gt (Get-Date)) { return }
} catch {}
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

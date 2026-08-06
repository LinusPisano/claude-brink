# Brink — resume dispatcher (Phase 8). At reset: try in-place injection into the live
# session; fall back to the headless resume-once.ps1 if the session is gone/uninjectable.
#
# Concurrent-resume hardening (report 2026-07-27): injector exit 0 only proves the
# keystrokes were WRITTEN to a console buffer — with two concurrent sessions in one
# project, nothing tied that buffer to THIS session, so a dispatcher could inject into
# the wrong window, report success, and delete the paused session's recovery artifacts.
# Now:
#   1. In-place success is VERIFIED against the session's own transcript file (the one
#      artifact reliably bound to the sid): if it doesn't grow after injection, the
#      keystrokes landed somewhere else and we fall back to headless.
#   2. HANDOFF.md is NEVER deleted on the in-place path — only a headless resume that
#      actually ran consumes it. The 14-day session-dir GC is its end of life otherwise.
#   3. Every step logs to the session's .claude-resume.log — three consecutive silent
#      failures went unnoticed as a pattern precisely because this path wrote no record.
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
#
# BRINK_DISPATCH_VERIFY_SECS (test-only): shortens the transcript-verification window
# (default 60s) so the unverified-injection fallback case doesn't stall the suite.
param(
  [Parameter(Mandatory)][string]$Sid, [string]$Proj, [int]$Buffer = 90, [string]$Skip = '0',
  [string]$CtxPath, [string]$SessionDir = '', [string]$ClaudeExe = ''
)
$here = $PSScriptRoot
function Notify($m){ try { & node (Join-Path $here 'notify.js') $m | Out-Null } catch {} }

# Forensic log (report 2026-07-27 defect B): the in-place path used to write NO record
# at all — when it "succeeded" without the session advancing, diagnosing that took a
# filesystem forensics pass instead of reading a log. Same file resume-once.ps1 uses.
function Log($m){
  if (-not $SessionDir) { return }
  try {
    if (-not (Test-Path -LiteralPath $SessionDir)) { New-Item -ItemType Directory -Path $SessionDir -Force -ErrorAction SilentlyContinue | Out-Null }
    # -Encoding UTF8: this file is shared with resume-once.ps1, which now writes UTF-8
    # too (code review 2026-08-05, finding 7 — it used to be part cp1252, part UTF-16LE).
    ((Get-Date).ToString('o') + ' [dispatch] ' + $m) | Add-Content -Path (Join-Path $SessionDir '.claude-resume.log') -Encoding UTF8 -ErrorAction SilentlyContinue
  } catch {}
}
Log "dispatcher fired for sid=$Sid (ctx=$([bool]($CtxPath -and (Test-Path -LiteralPath $CtxPath))))"

# ---- escape-hatch gate (code review 2026-08-05, finding 3) ----
# Both hatches were checked ONLY on the pause path in brink.js, never here. An armed
# scheduled resume therefore ignored them completely: `brink off` told the user "Hooks
# stay installed but do nothing" while this dispatcher would still inject a continue
# prompt into their live session at reset, and `brink release <sid>` — the per-session
# opt-out — did not release the one thing a released session most needs releasing from.
#   DISABLED        global kill switch (`brink off`)
#   released_<sid>  per-session opt-out (`brink release <sid>`)
# Both are honoured at FIRE time, not arm time, so flipping either one after a pause has
# already armed still works — which is the whole point of a kill switch.
#
# The pause's recovery artifacts (HANDOFF.md, resume-ctx.json) are deliberately PRESERVED:
# the user disabled the auto-resume, not the handoff, and they still need it to pick the
# work back up by hand. The one-shot task IS unregistered — it has fired and will never
# fire again, so leaving it would just orphan a scheduler entry.
$brinkDirDisp = if ($env:BRINK_DIR) { $env:BRINK_DIR } else { Join-Path $env:USERPROFILE '.claude\brink' }
$sidFlagDisp = 'released_' + ($Sid -replace '[^\w.-]', '_')
$hatchDisp = ''
if (Test-Path -LiteralPath (Join-Path $brinkDirDisp 'DISABLED')) { $hatchDisp = 'brink off (global kill switch)' }
elseif (Test-Path -LiteralPath (Join-Path $brinkDirDisp $sidFlagDisp)) { $hatchDisp = "brink release $Sid (per-session)" }
if ($hatchDisp) {
  Log "resume SKIPPED - $hatchDisp is active. Handoff + resume-ctx preserved; one-shot task unregistered."
  Notify "Brink: auto-resume skipped for this session ($hatchDisp). Your handoff is still there."
  $taskNameDisp = 'BrinkResume_' + ($Sid -replace '[^\w\-]', '_')
  Unregister-ScheduledTask -TaskName $taskNameDisp -Confirm:$false -ErrorAction SilentlyContinue
  exit 0
}

$didInPlace = $false
if ($CtxPath -and (Test-Path -LiteralPath $CtxPath)) {
  try {
    $ctx = Get-Content -LiteralPath $CtxPath -Raw | ConvertFrom-Json
    # Re-validate the recorded session is still alive with the SAME start time (PID-reuse guard).
    $live = Get-CimInstance Win32_Process -Filter "ProcessId=$($ctx.SessionPid)" -ErrorAction SilentlyContinue
    $sameStart = $live -and $ctx.SessionStartTime -and ([datetime]$live.CreationDate).ToString('o') -eq $ctx.SessionStartTime
    Log "in-place candidate: SessionPid=$($ctx.SessionPid) aliveWithSameStart=$([bool]$sameStart)"
    if ($sameStart) {
      # Re-detect to confirm still injectable (terminal could have changed since pause).
      if ($env:BRINK_DISPATCH_DETECT_OVERRIDE) {
        try { $det = $env:BRINK_DISPATCH_DETECT_OVERRIDE | ConvertFrom-Json } catch { $det = $null }
      } else {
        . (Join-Path $here 'detect-terminal.ps1')
        $det = Detect-ClaudeTerminal -TargetPid ([int]$ctx.SessionPid)
      }
      if ($det -and $det.HasWinConsole -and ($det.Terminal -in @('WindowsTerminal','Conhost')) -and $det.Confidence -ne 'Low') {
        # Snapshot the transcript BEFORE injecting — growth afterwards is the only
        # signal we have that the injected prompt reached THIS session (the transcript
        # is per-sid; a wrong-window injection can't grow it).
        $tp = ''
        try { if ($ctx.transcript_path) { $tp = [string]$ctx.transcript_path } } catch {}
        $size0 = -1
        if ($tp -and (Test-Path -LiteralPath $tp)) { try { $size0 = (Get-Item -LiteralPath $tp).Length } catch {} }

        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'inject-continue.ps1') -TargetPid ([int]$ctx.SessionPid) -Text $ctx.continue_prompt | Out-Null
        $ok = $LASTEXITCODE -eq 0
        Log "injection exit=$LASTEXITCODE (0 = keystrokes written to a console buffer, not proof of submit)"
        # Honest wording (pre-launch hardening Task 9): injector exit 0 only means the
        # keystrokes were WRITTEN to the console buffer, not that Claude actually
        # submitted them and continued the turn (write-success != submit-success). The
        # transcript watch below is the closest thing to that missing signal.
        if ($ok) {
          $verified = $false
          if ($tp) {
            $verifySecs = 60
            if ($env:BRINK_DISPATCH_VERIFY_SECS) { try { $verifySecs = [int]$env:BRINK_DISPATCH_VERIFY_SECS } catch {} }
            $polls = [Math]::Max(1, [Math]::Ceiling($verifySecs / 3))
            for ($i = 0; $i -lt $polls -and -not $verified; $i++) {
              Start-Sleep -Seconds 3
              if (Test-Path -LiteralPath $tp) {
                $sz = -1; try { $sz = (Get-Item -LiteralPath $tp).Length } catch {}
                if ($sz -gt $size0) { $verified = $true; Log "VERIFIED: transcript grew $size0 -> $sz bytes - the session received input" }
              }
            }
            if (-not $verified) {
              Log "NOT verified: transcript unchanged after ${verifySecs}s - the keystrokes likely landed in another window; falling back to headless"
              Notify 'Brink: in-place nudge was not received by the paused session - falling back to headless resume'
            }
          } else {
            # Legacy ctx (armed by a pre-1.1 pause, no transcript_path): unverifiable.
            # Keep the old resolution semantics rather than risking a double-resume via
            # the headless fallback — but the handoff is preserved either way now.
            $verified = $true
            Log "legacy ctx without transcript_path - treating injection write as resolved (UNVERIFIED)"
          }
          if ($verified) {
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
        }
        else { Notify 'Brink: in-place injection failed - falling back to headless resume' }
      } else {
        Log "re-detect: not injectable (Terminal=$(if ($det) { $det.Terminal } else { 'n/a' }) Confidence=$(if ($det) { $det.Confidence } else { 'n/a' })) - falling back to headless"
      }
    }
  } catch { Log "dispatch error: $($_.Exception.Message)"; Notify "Brink: dispatch error ($($_.Exception.Message)) - falling back to headless" }
}

$resolved = $didInPlace
if (-not $didInPlace) {
  Log 'headless fallback: invoking resume-once.ps1'
  # Code review 2026-08-05 finding 2: PS 5.1's native-arg passing DROPS an empty string
  # when spawning a child process - "$ClaudeExe" does NOT pin it as "", it vanishes,
  # shifting every following named argument and making resume-once.ps1 fail parameter
  # binding before its own body (which already has an empty-ClaudeExe fallback to a bare
  # `claude` PATH lookup, resume-once.ps1:95-101) ever ran. An empty -ClaudeExe/-SessionDir
  # is the DESIGNED normal case (arm-resume.ps1 writes -ClaudeExe "" whenever claude-exe.js
  # never resolved a path), not an edge case. Build the argument list as an array (splat)
  # and OMIT an empty switch entirely instead of passing it as "" - that sidesteps the
  # native-boundary drop altogether; both params already default to '' in resume-once.ps1.
  $onceArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'resume-once.ps1'),
    '-Sid', $Sid, '-Proj', $Proj, '-Buffer', $Buffer, '-Skip', $Skip)
  if ($SessionDir) { $onceArgs += @('-SessionDir', $SessionDir) }
  if ($ClaudeExe)  { $onceArgs += @('-ClaudeExe', $ClaudeExe) }
  $launchFailed = $false
  try { & powershell @onceArgs } catch { $launchFailed = $true; Log "headless fallback failed to launch: $($_.Exception.Message)" }
  # Sentinel exit codes from resume-once.ps1 — both mean "a future trigger is armed, so
  # the ctx/handoff are still needed", and neither may consume the recovery artifacts:
  #   42  weekly-cap precheck re-armed INSTEAD of resuming (no resume happened)
  #   43  the resume RAN, but re-armed again inside the resumed session (finding 6:
  #       treating this as resolved deleted the very HANDOFF.md the preserved task
  #       points at)
  # A launch failure (the child never ran at all — e.g. powershell.exe could not start,
  # or parameter binding failed) is also NOT resolved. Anything else means resume-once.ps1
  # ran to completion with no future trigger, so the pause really is done.
  $resolved = (-not $launchFailed) -and ($LASTEXITCODE -ne 42) -and ($LASTEXITCODE -ne 43)
  Log "headless fallback exit=$LASTEXITCODE (42 = re-armed instead of resuming, 43 = resumed then re-armed; both preserve ctx+handoff)"
}

# Cleanup (report 2026-07-27 defect A: "the deletion is the damaging part"):
#  - resume-ctx.json is consumed whenever this pause is RESOLVED (verified in-place, or
#    a headless run that really resumed rather than re-armed) - it describes a moment
#    that has passed either way.
#  - HANDOFF.md is deleted ONLY when the headless path genuinely ran: that path consumed
#    it (the resume prompt reads it). A verified in-place resume continues from the live
#    session's own context and never needs the handoff - but it costs nothing to keep,
#    and deleting the recovery artifact on anything short of certainty is how a
#    recoverable miss became an unrecoverable one on 2026-07-27. The session-dir GC
#    (brink.js, 14 days) is its natural end of life.
# On a re-arm (headless sentinel exit 42) both deletes are skipped on purpose: the
# re-armed weekly task still needs the ctx/handoff when it eventually fires.
if ($resolved) {
  if ($CtxPath) { try { Remove-Item -LiteralPath $CtxPath -Force -ErrorAction SilentlyContinue } catch {} }
  if (-not $didInPlace -and $SessionDir) { try { Remove-Item -LiteralPath (Join-Path $SessionDir 'HANDOFF.md') -Force -ErrorAction SilentlyContinue } catch {} }
  Log "cleanup: ctx consumed$(if (-not $didInPlace) { ', handoff consumed by headless resume' } else { ', handoff PRESERVED (in-place resume never reads it; 14-day GC cleans it)' })"
} else {
  Log 'cleanup skipped: pause not resolved (ctx + handoff preserved for the re-armed task)'
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

# Brink - watchdog admin (install/uninstall/start/stop/status for the daemon).
# Invoked by `brink watchdog on|off|status` (cli.js); safe to run by hand too.
#
# install   register the BrinkWatchdog logon task (wscript -> watchdog-launch.vbs ->
#           hidden powershell watchdog.ps1) and start the daemon now. Idempotent.
#           -ExecutionTimeLimit 0 (PT0S = unlimited): the default 3-day limit would
#           silently kill a daemon whose whole job is to run forever.
# uninstall stop the daemon + unregister the task.
# start     start the daemon now if it isn't running (via the task, so the daemon
#           always runs in the same context it would get at logon).
# stop      kill the daemon (lock-file pid, PID-reuse guarded) + clear the lock.
# status    machine-readable-ish lines consumed by `brink watchdog status`.
param(
  [Parameter(Mandatory)][ValidateSet('install', 'uninstall', 'start', 'stop', 'status')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'
$taskName = 'BrinkWatchdog'
$brinkDir = if ($env:BRINK_DIR) { $env:BRINK_DIR } else { Join-Path $env:USERPROFILE '.claude\brink' }
$lockFile = Join-Path $brinkDir 'watchdog.lock'
$watchdog = Join-Path $PSScriptRoot 'watchdog.ps1'
$vbs      = Join-Path $PSScriptRoot 'watchdog-launch.vbs'

function Read-JsonFile($p) {
  try { return (Get-Content -LiteralPath $p -Raw -ErrorAction Stop | ConvertFrom-Json) } catch { return $null }
}
function Get-DaemonPid {
  # PID-reuse guarded, same contract as watchdog.ps1's own lock check
  $lock = Read-JsonFile $lockFile
  if (-not $lock -or -not $lock.pid) { return 0 }
  $live = Get-CimInstance Win32_Process -Filter "ProcessId=$($lock.pid)" -ErrorAction SilentlyContinue
  if (-not $live) { return 0 }
  if ($lock.start -and (([datetime]$live.CreationDate).ToString('o') -ne [string]$lock.start)) { return 0 }
  return [int]$lock.pid
}
function Stop-Daemon {
  $dpid = Get-DaemonPid
  if ($dpid) { try { Stop-Process -Id $dpid -Force -Confirm:$false -ErrorAction SilentlyContinue } catch { } }
  try { Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue } catch { }
  return [bool]$dpid
}

switch ($Action) {
  'install' {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    $arg = "`"$vbs`" `"$watchdog`""
    Register-ScheduledTask -TaskName $taskName -RunLevel Limited `
      -Action  (New-ScheduledTaskAction -Execute 'wscript.exe' -Argument $arg) `
      -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME) `
      -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                 -ExecutionTimeLimit ([TimeSpan]::Zero)) | Out-Null
    Write-Output "task: registered ($taskName, at logon)"
    if (Get-DaemonPid) { Write-Output 'daemon: already running' }
    else { Start-ScheduledTask -TaskName $taskName; Start-Sleep -Seconds 2
           if (Get-DaemonPid) { Write-Output "daemon: started (pid $(Get-DaemonPid))" } else { Write-Output 'daemon: start requested - verify shortly with: brink watchdog status' } }
  }
  'uninstall' {
    $was = Stop-Daemon
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "task: unregistered; daemon: $(if ($was) { 'stopped' } else { 'was not running' })"
  }
  'start' {
    if (Get-DaemonPid) { Write-Output "daemon: already running (pid $(Get-DaemonPid))"; break }
    $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $t) { Write-Output 'task: NOT registered - run: brink watchdog on'; exit 1 }
    Start-ScheduledTask -TaskName $taskName; Start-Sleep -Seconds 2
    if (Get-DaemonPid) { Write-Output "daemon: started (pid $(Get-DaemonPid))" } else { Write-Output 'daemon: start requested - verify shortly with: brink watchdog status' }
  }
  'stop' {
    if (Stop-Daemon) { Write-Output 'daemon: stopped' } else { Write-Output 'daemon: was not running' }
  }
  'status' {
    $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Write-Output "task: $(if ($t) { 'registered (' + $t.State + ')' } else { 'NOT registered' })"
    $dpid = Get-DaemonPid
    Write-Output "daemon: $(if ($dpid) { 'running (pid ' + $dpid + ')' } else { 'NOT running' })"
    $markers = @(Get-ChildItem -Path $brinkDir -Filter 'busy_*.json' -File -ErrorAction SilentlyContinue)
    Write-Output "busy markers: $($markers.Count)"
    foreach ($f in $markers) {
      $m = Read-JsonFile $f.FullName
      if ($m) { Write-Output "  - sid $($m.sid) pid $($m.pid) proj $($m.proj)" }
    }
  }
}

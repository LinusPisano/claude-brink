#requires -Version 5.1
<#
  detect-synthetic.ps1
  Fabricated Win32_Process maps -> Detect-ClaudeTerminal, asserting Terminal /
  HasWinConsole / Confidence / InjectionMethod per branch. Zero live CIM calls
  (every branch passes -Map and, where relevant, -Siblings so the detector
  never touches the real process table) -> fully deterministic, safe to run
  anywhere, never spawns/kills/attaches to any real process.

  Adapted from the research prototype's manual Format-List spot checks into
  scripted pass/fail assertions.

  Prints "  ok:   ..." / "  FAIL: ..." lines. Exit 0 if all pass, exit 1 if
  any fail (tests/detect.test.js checks this exit code).
#>

. (Join-Path $PSScriptRoot '..\src\detect-terminal.ps1')

$script:FailCount = 0

function Assert-Eq($actual, $expected, $label) {
    if ("$actual" -eq "$expected") {
        Write-Output "  ok:   $label = $expected"
    } else {
        Write-Output "  FAIL: $label expected '$expected' got '$actual'"
        $script:FailCount++
    }
}

function Assert-Match($actual, $pattern, $label) {
    if ("$actual" -match $pattern) {
        Write-Output "  ok:   $label matches /$pattern/"
    } else {
        Write-Output "  FAIL: $label expected to match /$pattern/ got '$actual'"
        $script:FailCount++
    }
}

function Node($pid0, $ppid, $name) {
    [pscustomobject]@{ Pid = [int]$pid0; ParentPid = [int]$ppid; Name = $name; Path = $null; CreateTime = $null }
}
function FakeMap($nodes) {
    $m = @{}
    foreach ($n in $nodes) { $m[$n.Pid] = $n }
    return $m
}
function Sib($pid0, $name) {
    [pscustomobject]@{ ProcessId = [int]$pid0; Name = $name }
}

Write-Output "=== WindowsTerminal ==="
$wt = FakeMap @(
    (Node 9001 9002 'claude.exe'),
    (Node 9002 9003 'powershell.exe'),
    (Node 9003 9004 'WindowsTerminal.exe'),
    (Node 9004 0    'explorer.exe')
)
$r = Detect-ClaudeTerminal -TargetPid 9001 -Map $wt -Siblings @{}
Assert-Eq $r.Terminal 'WindowsTerminal' 'WT: Terminal'
Assert-Eq $r.HasWinConsole $true 'WT: HasWinConsole'
Assert-Eq $r.Confidence 'High' 'WT: Confidence'
Assert-Eq $r.InjectionMethod 'WriteConsoleInput_or_UIA' 'WT: InjectionMethod'
Assert-Eq $r.ShellPid 9002 'WT: ShellPid (nearest shell in chain)'

Write-Output "=== Conhost ==="
# No GUI emulator ancestor; a fabricated conhost.exe child hangs off cmd.exe (9202).
# Root (launcher.exe, 9203) terminates the walk at ParentPid=0 -> not in map ->
# rootParentAlive=false -> Medium confidence (the walk only ever sees an "alive"
# root parent via the PID-reuse-guard break, exercised separately below).
$conhostMap = FakeMap @(
    (Node 9201 9202 'claude.exe'),
    (Node 9202 9203 'cmd.exe'),
    (Node 9203 0    'launcher.exe')
)
$conhostSiblings = @{ 9202 = @( (Sib 9299 'conhost.exe') ) }
$r = Detect-ClaudeTerminal -TargetPid 9201 -Map $conhostMap -Siblings $conhostSiblings
Assert-Eq $r.Terminal 'Conhost' 'Conhost: Terminal'
Assert-Eq $r.HasWinConsole $true 'Conhost: HasWinConsole'
Assert-Eq $r.Confidence 'Medium' 'Conhost: Confidence'
Assert-Eq $r.InjectionMethod 'AttachConsole_WriteConsoleInput' 'Conhost: InjectionMethod'
Assert-Eq $r.HostPid 9299 'Conhost: HostPid (fabricated conhost pid)'

Write-Output "=== VSCode ==="
$vscode = FakeMap @(
    (Node 9301 9302 'claude.exe'),
    (Node 9302 9303 'pwsh.exe'),
    (Node 9303 9304 'Code.exe'),
    (Node 9304 9305 'Code.exe'),
    (Node 9305 0    'explorer.exe')
)
$r = Detect-ClaudeTerminal -TargetPid 9301 -Map $vscode -Siblings @{}
Assert-Eq $r.Terminal 'VSCode' 'VSCode: Terminal'
Assert-Eq $r.HasWinConsole $true 'VSCode: HasWinConsole'
Assert-Eq $r.Confidence 'High' 'VSCode: Confidence'
Assert-Eq $r.InjectionMethod 'VSCode_TerminalAPI' 'VSCode: InjectionMethod'

Write-Output "=== Mintty (Git Bash) ==="
$mintty = FakeMap @(
    (Node 9401 9402 'claude.exe'),
    (Node 9402 9403 'bash.exe'),
    (Node 9403 9404 'mintty.exe'),
    (Node 9404 0    'explorer.exe')
)
$r = Detect-ClaudeTerminal -TargetPid 9401 -Map $mintty -Siblings @{}
Assert-Eq $r.Terminal 'Mintty' 'Mintty: Terminal'
Assert-Eq $r.HasWinConsole $false 'Mintty: HasWinConsole'
Assert-Eq $r.Confidence 'High' 'Mintty: Confidence'
Assert-Eq $r.InjectionMethod 'WriteToPtyMaster_or_SendInput' 'Mintty: InjectionMethod'

Write-Output "=== Detached (root parent gone, no conhost -> Injectable=false) ==="
# No GUI emulator, no conhost sibling anywhere in the chain, and the root
# ancestor's own parent (9599) is NOT in the map -> backgrounded/dead launcher.
$detached = FakeMap @(
    (Node 9501 9502 'claude.exe'),
    (Node 9502 9503 'node.exe'),
    (Node 9503 9599 'launcher.exe')
)
$r = Detect-ClaudeTerminal -TargetPid 9501 -Map $detached -Siblings @{}
Assert-Eq $r.Terminal 'Unknown' 'Detached: Terminal'
Assert-Eq $r.HasWinConsole $false 'Detached: HasWinConsole'
Assert-Eq $r.Confidence 'Low' 'Detached: Confidence'
Assert-Match $r.Evidence 'detached/headless' 'Detached: Evidence mentions dead-ended launcher'
$injectable = $r.HasWinConsole -and ($r.Terminal -in @('WindowsTerminal', 'Conhost')) -and ($r.Confidence -ne 'Low')
Assert-Eq $injectable $false 'Detached: Injectable formula'

Write-Output "=== Unknown (headless/redirected, root parent alive via PID-reuse-guard break) ==="
# Same "no emulator, no conhost" shape as Detached, but here the walk stops via the
# PID-reuse guard (sshd's parent slot was recycled to a NEWER process) rather than
# running off the top of the tree -> rootParentAlive=true -> distinct evidence text
# ("redirected/piped stdio") even though Confidence/HasWinConsole are the same (Low/false).
$ssh = FakeMap @(
    [pscustomobject]@{ Pid = 9601; ParentPid = 9602; Name = 'claude.exe'; Path = $null; CreateTime = (Get-Date '2026-01-01 12:00:00') },
    [pscustomobject]@{ Pid = 9602; ParentPid = 9603; Name = 'bash';       Path = $null; CreateTime = (Get-Date '2026-01-01 11:59:00') },
    [pscustomobject]@{ Pid = 9603; ParentPid = 9604; Name = 'sshd.exe';  Path = $null; CreateTime = (Get-Date '2026-01-01 11:58:00') },
    [pscustomobject]@{ Pid = 9604; ParentPid = 0;    Name = 'services.exe'; Path = $null; CreateTime = (Get-Date '2026-01-01 12:30:00') }
)
$r = Detect-ClaudeTerminal -TargetPid 9601 -Map $ssh -Siblings @{}
Assert-Eq $r.Terminal 'Unknown' 'Unknown: Terminal'
Assert-Eq $r.HasWinConsole $false 'Unknown: HasWinConsole'
Assert-Eq $r.Confidence 'Low' 'Unknown: Confidence'
Assert-Match $r.Evidence 'redirected' 'Unknown: Evidence mentions redirected/piped stdio'
$injectable = $r.HasWinConsole -and ($r.Terminal -in @('WindowsTerminal', 'Conhost')) -and ($r.Confidence -ne 'Low')
Assert-Eq $injectable $false 'Unknown: Injectable formula'

Write-Output "=== Resolve-BrinkTarget (hook is node.exe -> must skip itself, resolve claude ancestor) ==="
# Real deployment shape: brink.js hook runs as a bare node.exe whose ANCESTRY contains the
# persistent claude.exe session. The resolver must NOT return the ephemeral hook pid
# (chain[0]) - it must skip index 0 and prefer the nearest 'claude' ancestor.
$rbt = FakeMap @(
    (Node 9801 9802 'node.exe'),            # the hook itself (ephemeral)
    (Node 9802 9803 'claude.exe'),          # the persistent interactive session
    (Node 9803 9804 'powershell.exe'),
    (Node 9804 0    'WindowsTerminal.exe')
)
$r = Resolve-BrinkTarget -HookPid 9801 -Map $rbt -Siblings @{}
Assert-Eq $r.SessionPid 9802 'RBT: SessionPid = claude session pid (NOT the node hook pid)'
Assert-Eq $r.Terminal 'WindowsTerminal' 'RBT: Terminal'
Assert-Eq $r.Injectable $true 'RBT: Injectable'
Assert-Eq $r.InjectionMethod 'WriteConsoleInput_or_UIA' 'RBT: InjectionMethod'
if ($r.SessionPid -eq 9801) {
    Write-Output "  FAIL: RBT: resolver returned the ephemeral hook pid itself"
    $script:FailCount++
} else {
    Write-Output "  ok:   RBT: resolver did not latch the ephemeral hook pid"
}

Write-Output "=== Resolve-BrinkTarget fallbacks (no claude in chain) ==="
# No 'claude' ancestor: nearest 'node'/'claude' at index >= 1 wins (9812).
$rbtNode = FakeMap @(
    (Node 9811 9812 'node.exe'),            # hook
    (Node 9812 9813 'node.exe'),            # session running as node.exe
    (Node 9813 9814 'powershell.exe'),
    (Node 9814 0    'WindowsTerminal.exe')
)
$r = Resolve-BrinkTarget -HookPid 9811 -Map $rbtNode -Siblings @{}
Assert-Eq $r.SessionPid 9812 'RBT-fallback: nearest node ancestor at index >= 1'
# No claude/node ancestor at all: chain[1] (the immediate parent) is the fallback.
$rbtShell = FakeMap @(
    (Node 9821 9822 'node.exe'),            # hook
    (Node 9822 9823 'powershell.exe'),
    (Node 9823 0    'WindowsTerminal.exe')
)
$r = Resolve-BrinkTarget -HookPid 9821 -Map $rbtShell -Siblings @{}
Assert-Eq $r.SessionPid 9822 'RBT-fallback: chain[1] when no claude/node ancestor'
# Chain of one (nothing above the hook): chain[0] is the last resort.
$rbtLone = FakeMap @(
    (Node 9831 9999 'node.exe')             # parent 9999 not in map -> chain length 1
)
$r = Resolve-BrinkTarget -HookPid 9831 -Map $rbtLone -Siblings @{}
Assert-Eq $r.SessionPid 9831 'RBT-fallback: chain[0] when chain has only the hook'

Write-Output "=== PID-reuse guard (stale parent link is not followed) ==="
# Node 9701's ParentPid (9702) exists in the map but was CREATED AFTER 9701 ->
# the link is stale (PID got reused) -> ancestry walk must stop at 9701.
$reuse = FakeMap @(
    [pscustomobject]@{ Pid = 9701; ParentPid = 9702; Name = 'claude.exe'; Path = $null; CreateTime = (Get-Date '2026-01-01') },
    [pscustomobject]@{ Pid = 9702; ParentPid = 0;    Name = 'WindowsTerminal.exe'; Path = $null; CreateTime = (Get-Date '2026-01-02') }
)
$r = Detect-ClaudeTerminal -TargetPid 9701 -Map $reuse -Siblings @{}
Assert-Eq $r.Terminal 'Unknown' 'PID-reuse guard: stale parent not followed -> Unknown, not WindowsTerminal'

if ($script:FailCount -gt 0) {
    Write-Output ""
    Write-Output "$script:FailCount assertion(s) FAILED"
    exit 1
} else {
    Write-Output ""
    Write-Output "all assertions passed"
    exit 0
}

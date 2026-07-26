#requires -Version 5.1
<#
  Brink - detect-terminal.ps1 (production)
  Given a PID (typically claude.exe/node.exe), determine which terminal hosts it and
  which input-injection strategy applies. Base ancestry-walk logic is copied from the
  proven research prototype (CIM Win32_Process snapshot -> parent-chain walk with a
  CreationDate PID-reuse guard).

  Two additions over the prototype:
    1. Get-ChildProcesses testability seam - the prototype's conhost.exe / OpenConsole.exe
       sibling lookups hit live CIM directly, which cannot be exercised deterministically
       from a synthetic (fabricated) process map. Detect-ClaudeTerminal now takes an
       optional -Siblings hashtable; when supplied (tests/detect-synthetic.ps1 only) it is
       consulted instead of live CIM, giving zero-live-query, fully deterministic tests.
       When -Siblings is NOT supplied (every real caller, including Resolve-BrinkTarget),
       behavior is byte-for-byte identical to the prototype (live Get-CimInstance).
    2. Resolve-BrinkTarget - given the pid of the (short-lived) hook process, walks its
       ANCESTORS (skipping the hook itself, which is a bare node.exe that dies right
       after the hook returns) to the persistent interactive session process - nearest
       'claude' ancestor first, then nearest 'claude'/'node', then the hook's parent -
       and classifies that pid's terminal, producing the {SessionPid, SessionStartTime,
       Terminal, Injectable, InjectionMethod} object later tasks (brink.js at pause,
       resume-dispatch.ps1 at reset) consume.

  Detection is READ-ONLY: CIM queries and (in test mode) fabricated-map lookups only.
  Never spawns, injects into, attaches to, or kills any process.

  Detect-ClaudeTerminal output object:
    TargetPid      - the pid you asked about
    Terminal       - WindowsTerminal | Conhost | VSCode | Mintty | OtherPty | Unknown
    HostPid        - pid of the process that owns the visible window / console host
    HostName       - image name of HostPid
    ShellPid       - pid of the console-owning shell in the chain (attach target)
    ShellName      - image name of ShellPid
    InjectionMethod- symbolic strategy id (see EmulatorTable / Conhost / Unknown below)
    HasWinConsole  - $true if a Win32 console (conhost/OpenConsole) backs it -> WriteConsoleInput viable
    Confidence     - High | Medium | Low
    Evidence       - human-readable notes
    Chain          - ordered ancestry (index 0 = target)

  Resolve-BrinkTarget output object:
    SessionPid       - the persistent session process: nearest 'claude' ancestor of the
                       hook (never the hook itself); fallbacks: nearest claude/node
                       ancestor, then the hook's parent, then the hook
    SessionStartTime - that process's CreationDate as an ISO 'o' string (or $null)
    Terminal         - as classified by Detect-ClaudeTerminal for SessionPid
    Injectable       - bool; see formula in Resolve-BrinkTarget below
    InjectionMethod  - as classified by Detect-ClaudeTerminal for SessionPid

  If invoked as a script with -HookPid, prints Resolve-BrinkTarget's result as
  compressed JSON on stdout so brink.js (Node) can parse it, e.g.:
    powershell -NoProfile -ExecutionPolicy Bypass -File src/detect-terminal.ps1 -HookPid 12345
#>
param(
    [int]$HookPid = 0
)

function Get-ProcessMap {
    # One CIM snapshot -> hashtable keyed by pid for O(1) parent walks.
    $map = @{}
    foreach ($p in Get-CimInstance Win32_Process -ErrorAction Stop) {
        $map[[int]$p.ProcessId] = [pscustomobject]@{
            Pid        = [int]$p.ProcessId
            ParentPid  = [int]$p.ParentProcessId
            Name       = $p.Name
            Path       = $p.ExecutablePath
            CreateTime = $p.CreationDate   # used to reject PID reuse on the parent link
        }
    }
    return $map
}

function Get-Ancestry {
    param([int]$Pid0, [hashtable]$Map)
    $chain = @()
    $cur = $Pid0
    $depth = 0
    $seen = @{}
    while ($cur -and $Map.ContainsKey($cur) -and -not $seen.ContainsKey($cur) -and $depth -lt 40) {
        $seen[$cur] = $true
        $node = $Map[$cur]
        $chain += $node
        $parent = $node.ParentPid
        if ($parent -eq 0) { break }
        # PID-reuse guard: parent must exist AND have been created at/before the child.
        if ($Map.ContainsKey($parent) -and $node.CreateTime -and $Map[$parent].CreateTime) {
            if ($Map[$parent].CreateTime -gt $node.CreateTime) { break } # stale parent link
        }
        $cur = $parent
        $depth++
    }
    return ,$chain
}

function Normalize([string]$name) {
    if (-not $name) { return "" }
    return ($name -replace '\.exe$','').ToLowerInvariant()
}

function Get-ChildProcesses {
    # Testability seam (see file header). A SUPPLIED $Siblings map is AUTHORITATIVE -
    # even an empty one - and must NEVER fall through to live CIM (otherwise a real
    # process happening to occupy a fabricated 9001-9999 pid with a conhost/OpenConsole
    # child could flip a synthetic classification nondeterministically). Live CIM fires
    # ONLY on the production path, where no caller supplied -Siblings.
    #
    # "Supplied-ness" is carried as null-vs-non-null: $Siblings defaults to $null, and
    # the production call chain (Detect-ClaudeTerminal / Resolve-BrinkTarget without
    # -Siblings) passes that $null straight through -> live CIM. A test passing
    # -Siblings @{} sends a NON-null (though empty) hashtable -> authoritative, returns
    # @() when the exact ParentPid key is absent. NOTE: an empty @{} is TRUTHY in
    # PowerShell, so `if ($Siblings)` would be the wrong test here - use `$null -ne`.
    param(
        [int]$ParentPid,
        [string]$Name,
        [hashtable]$Siblings = $null
    )
    if ($null -ne $Siblings) {
        if ($Siblings.ContainsKey($ParentPid)) {
            return @($Siblings[$ParentPid] | Where-Object { $_.Name -eq $Name })
        }
        return @()   # supplied map is authoritative; no live CIM fallback
    }
    return @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentPid AND Name='$Name'" -ErrorAction SilentlyContinue)
}

# terminal-emulator image names -> canonical terminal + method
# (checked against every node in the ancestry, nearest-to-target wins)
$script:EmulatorTable = @{
    'windowsterminal' = @{ Terminal='WindowsTerminal'; Method='WriteConsoleInput_or_UIA'; WinConsole=$true }
    'code'            = @{ Terminal='VSCode';           Method='VSCode_TerminalAPI';       WinConsole=$true }
    'code - insiders' = @{ Terminal='VSCode';           Method='VSCode_TerminalAPI';       WinConsole=$true }
    'mintty'          = @{ Terminal='Mintty';           Method='WriteToPtyMaster_or_SendInput'; WinConsole=$false }
    'alacritty'       = @{ Terminal='OtherPty';         Method='WriteToPtyMaster_or_SendInput'; WinConsole=$false }
    'wezterm-gui'     = @{ Terminal='OtherPty';         Method='WriteToPtyMaster_or_SendInput'; WinConsole=$false }
    'hyper'           = @{ Terminal='OtherPty';         Method='WriteToPtyMaster_or_SendInput'; WinConsole=$false }
    'conemu64'        = @{ Terminal='OtherPty';         Method='ConEmu_GuiMacro';          WinConsole=$true }
    'conemu'          = @{ Terminal='OtherPty';         Method='ConEmu_GuiMacro';          WinConsole=$true }
}

$script:ShellNames = @('powershell','pwsh','cmd','bash','sh','zsh','fish','wsl','wslhost','nu')

function Detect-ClaudeTerminal {
    param(
        [Parameter(Mandatory)][int]$TargetPid,
        [hashtable]$Map,
        [hashtable]$Siblings
    )
    if (-not $Map) { $Map = Get-ProcessMap }
    if (-not $Map.ContainsKey($TargetPid)) {
        return [pscustomobject]@{ TargetPid=$TargetPid; Terminal='Unknown'; HostPid=$null; HostName=$null;
            ShellPid=$null; ShellName=$null; InjectionMethod='none'; HasWinConsole=$false;
            Confidence='Low'; Evidence="pid $TargetPid not found"; Chain=@() }
    }

    $chain = Get-Ancestry -Pid0 $TargetPid -Map $Map
    $evidence = @()

    # 1) Nearest emulator ancestor decides the terminal.
    $hit = $null; $hitNode = $null
    foreach ($node in $chain) {
        $n = Normalize $node.Name
        if ($script:EmulatorTable.ContainsKey($n)) { $hit = $script:EmulatorTable[$n]; $hitNode = $node; break }
    }

    # 2) Shell = the shell process closest to the target (its console owner / attach point).
    $shellNode = $null
    foreach ($node in $chain) {
        if ($script:ShellNames -contains (Normalize $node.Name)) { $shellNode = $node; break }
    }

    if ($hit) {
        $terminal = $hit.Terminal
        $method   = $hit.Method
        $hostPid  = $hitNode.Pid
        $hostName = $hitNode.Name
        $winCon   = $hit.WinConsole
        $conf     = 'High'
        $evidence += "ancestry contains $($hitNode.Name) (pid $($hitNode.Pid))"
        if ($terminal -eq 'WindowsTerminal') {
            # OpenConsole.exe is a SIBLING of the shell (child of WindowsTerminal), never in this chain.
            $oc = @(Get-ChildProcesses -ParentPid $hostPid -Name 'OpenConsole.exe' -Siblings $Siblings)
            if ($oc.Count) { $evidence += "OpenConsole PTY host(s): $($oc.ProcessId -join ',') (siblings, not ancestors)" }
        }
    }
    else {
        # 3) No GUI emulator in chain -> classic conhost, OR a detached/headless console.
        #    conhost.exe is a CHILD of the console-owning process, not an ancestor.
        $conhost = $null
        foreach ($node in $chain) {
            $c = @(Get-ChildProcesses -ParentPid $node.Pid -Name 'conhost.exe' -Siblings $Siblings)
            if ($c.Count) { $conhost = $c[0]; break }
        }
        # Detect a broken/detached chain: root ancestor's parent is gone (backgrounded launcher).
        $root = $chain[-1]
        $rootParentAlive = $Map.ContainsKey($root.ParentPid)
        if ($conhost) {
            $terminal = 'Conhost'
            $method   = 'AttachConsole_WriteConsoleInput'
            $hostPid  = [int]$conhost.ProcessId
            $hostName = 'conhost.exe'
            $winCon   = $true
            $conf     = if ($rootParentAlive) { 'High' } else { 'Medium' }
            $evidence += "no GUI emulator in ancestry; conhost.exe pid $hostPid attached to console group"
            if (-not $rootParentAlive) { $evidence += "chain dead-ends at $($root.Name) pid $($root.Pid) (launcher parent $($root.ParentPid) gone) -> likely detached/headless, may have NO visible window" }
        }
        else {
            $terminal = 'Unknown'
            $method   = 'none'
            $hostPid  = $null
            $hostName = $null
            $winCon   = $false
            $conf     = 'Low'
            if (-not $rootParentAlive) {
                $evidence += "no GUI emulator and no conhost found; chain dead-ends at $($root.Name) pid $($root.Pid) (launcher parent $($root.ParentPid) gone) -> likely detached/headless"
            } else {
                $evidence += "no GUI emulator and no conhost found; possibly fully redirected/piped stdio (headless) or SSH/WSL"
            }
        }
    }

    return [pscustomobject]@{
        TargetPid       = $TargetPid
        Terminal        = $terminal
        HostPid         = $hostPid
        HostName        = $hostName
        ShellPid        = if ($shellNode) { $shellNode.Pid } else { $null }
        ShellName       = if ($shellNode) { $shellNode.Name } else { $null }
        InjectionMethod = $method
        HasWinConsole   = $winCon
        Confidence      = $conf
        Evidence        = ($evidence -join ' | ')
        Chain           = ($chain | ForEach-Object { "$($_.Name)($($_.Pid))" }) -join ' -> '
    }
}

function Resolve-BrinkTarget {
    param(
        [Parameter(Mandatory)][int]$HookPid,
        [hashtable]$Map,       # optional synthetic map (tests); default = live CIM snapshot
        [hashtable]$Siblings   # optional synthetic sibling map (tests); see Get-ChildProcesses
    )
    if (-not $Map) { $Map = Get-ProcessMap }
    $chain = Get-Ancestry -Pid0 $HookPid -Map $Map
    # chain[0] is the hook process ITSELF - a bare node.exe that dies as soon as the hook
    # returns. It must NEVER be picked as the session (it would be a dead pid by resume
    # time), so the search starts at index 1. Resolution order:
    #   1. nearest ANCESTOR (index >= 1) named 'claude'  -> the persistent session process
    #   2. else nearest ancestor (index >= 1) named 'claude'/'node'
    #   3. else chain[1] (the hook's immediate parent) if it exists
    #   4. else chain[0] (last resort: the hook itself, e.g. an orphaned one-node chain)
    $session = $null
    for ($i = 1; $i -lt $chain.Count; $i++) {
        if ((Normalize $chain[$i].Name) -eq 'claude') { $session = $chain[$i]; break }
    }
    if (-not $session) {
        for ($i = 1; $i -lt $chain.Count; $i++) {
            if ((Normalize $chain[$i].Name) -in @('claude','node')) { $session = $chain[$i]; break }
        }
    }
    if (-not $session) {
        $session = if ($chain.Count -gt 1) { $chain[1] } else { $chain[0] }
    }
    $det = Detect-ClaudeTerminal -TargetPid $session.Pid -Map $Map -Siblings $Siblings
    $injectable = $det.HasWinConsole -and ($det.Terminal -in @('WindowsTerminal','Conhost')) -and ($det.Confidence -ne 'Low')
    [pscustomobject]@{
        SessionPid       = $session.Pid
        SessionStartTime = if ($session.CreateTime) { $session.CreateTime.ToString('o') } else { $null }
        Terminal         = $det.Terminal
        Injectable       = [bool]$injectable
        InjectionMethod  = $det.InjectionMethod
    }
}

if ($HookPid -gt 0) {
    $result = Resolve-BrinkTarget -HookPid $HookPid
    $result | ConvertTo-Json -Compress
}

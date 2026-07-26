# Brink - resume-in-place console-input injector (production)
# Types -Text into TargetPid's console input buffer, then submits with a DISCRETE
# Enter injected as a SEPARATE attach->write->free cycle ~800ms later.
#
# PROVEN FINDING (Task 1 gate, 2026-07-10): an Enter batched into the same
# WriteConsoleInput burst as the text is treated as a paste and does NOT submit
# Claude's TUI. The submit Enter must land in its own WriteConsoleInput call.
# Base mechanism (FreeConsole -> AttachConsole -> CreateFileW(CONIN$) ->
# WriteConsoleInputW -> FreeConsole) proven by a standalone research prototype.
param(
  [Parameter(Mandatory=$true)][int]$TargetPid,
  [Parameter(Mandatory=$true)][string]$Text,
  [string]$LogFile = $null
)

$ErrorActionPreference = 'Continue'
$lines = New-Object System.Collections.Generic.List[string]
function L($m) {
  if (-not $LogFile) { return }
  $lines.Add(("[{0}] {1}" -f (Get-Date -Format HH:mm:ss.fff), $m))
  [System.IO.File]::WriteAllLines($LogFile, $lines)
}

L "INJECTOR START pid=$PID targetPid=$TargetPid text='$Text'"

$src = @"
using System;
using System.Runtime.InteropServices;
public static class ConInj {
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint dwProcessId);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetStdHandle(int nStdHandle);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode,
        IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] buf, uint len, out uint written);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool GetNumberOfConsoleInputEvents(IntPtr h, out uint n);

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUT_RECORD {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public KEY_EVENT_RECORD Key;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEY_EVENT_RECORD {
        public int bKeyDown;
        public ushort wRepeatCount;
        public ushort wVirtualKeyCode;
        public ushort wVirtualScanCode;
        public ushort UnicodeChar;
        public uint dwControlKeyState;
    }
    public const int STD_INPUT_HANDLE = -10;
    public const ushort KEY_EVENT = 0x0001;
    public const uint GENERIC_READ = 0x80000000;
    public const uint GENERIC_WRITE = 0x40000000;
    public const uint FILE_SHARE_READ = 0x1;
    public const uint FILE_SHARE_WRITE = 0x2;
    public const uint OPEN_EXISTING = 3;

    public static int LastErr() { return Marshal.GetLastWin32Error(); }

    public static INPUT_RECORD MakeKey(char c, ushort vk, bool down) {
        INPUT_RECORD r = new INPUT_RECORD();
        r.EventType = KEY_EVENT;
        r.Key.bKeyDown = down ? 1 : 0;
        r.Key.wRepeatCount = 1;
        r.Key.wVirtualKeyCode = vk;
        r.Key.wVirtualScanCode = 0;
        r.Key.UnicodeChar = (ushort)c;
        r.Key.dwControlKeyState = 0;
        return r;
    }
}
"@
try {
  Add-Type -TypeDefinition $src -ErrorAction Stop
  L "Add-Type OK"
} catch {
  L "Add-Type FAILED: $($_.Exception.Message)"
  Write-Output (@{ attached = $false; written = 0; expected = 0; ok = $false } | ConvertTo-Json -Compress)
  exit 1
}

# Send a batch of INPUT_RECORDs to $tgtPid via FreeConsole(own) -> AttachConsole(target)
# -> CreateFileW(CONIN$) -> WriteConsoleInputW -> FreeConsole. Each cycle is self-contained
# so cycle 1 (text) and cycle 2 (the discrete Enter) never share a WriteConsoleInput call.
function Send-Records($tgtPid, $records) {
  $result = @{ attached = $false; written = 0; expected = $records.Length }

  $fc1 = [ConInj]::FreeConsole(); $e = [ConInj]::LastErr()
  L "FreeConsole(own) => $fc1 (err=$e)"

  $ac = [ConInj]::AttachConsole([uint32]$tgtPid); $e = [ConInj]::LastErr()
  L "AttachConsole($tgtPid) => $ac (err=$e)"

  if (-not $ac) {
    L "ATTACH FAILED - cannot proceed for this cycle"
    [void][ConInj]::FreeConsole()
    return $result
  }
  $result.attached = $true

  $INVALID = [IntPtr](-1)
  $h = [ConInj]::CreateFileW("CONIN$", ([ConInj]::GENERIC_READ -bor [ConInj]::GENERIC_WRITE),
        ([ConInj]::FILE_SHARE_READ -bor [ConInj]::FILE_SHARE_WRITE), [IntPtr]::Zero,
        [ConInj]::OPEN_EXISTING, 0, [IntPtr]::Zero); $e = [ConInj]::LastErr()
  L "CreateFile(CONIN\$) => handle=$h (err=$e)"

  if ($h -eq $INVALID) {
    L "CONIN\$ open failed; trying GetStdHandle(STD_INPUT_HANDLE)"
    $h = [ConInj]::GetStdHandle([ConInj]::STD_INPUT_HANDLE); $e = [ConInj]::LastErr()
    L "GetStdHandle => handle=$h (err=$e)"
  }

  $written = 0
  if ($records.Length -gt 0) {
    $ok = [ConInj]::WriteConsoleInputW($h, $records, [uint32]$records.Length, [ref]$written); $e = [ConInj]::LastErr()
    L "WriteConsoleInput => ok=$ok written=$written (err=$e)"
  } else {
    L "WriteConsoleInput skipped (0 records)"
  }
  $result.written = $written

  [void][ConInj]::FreeConsole(); $e = [ConInj]::LastErr()
  L "FreeConsole(cycle) (err=$e)"

  return $result
}

# Cycle 1: text only, no trailing Enter.
$textRecs = New-Object System.Collections.Generic.List[object]
foreach ($ch in $Text.ToCharArray()) {
  $textRecs.Add([ConInj]::MakeKey($ch, 0, $true))
  $textRecs.Add([ConInj]::MakeKey($ch, 0, $false))
}
L "Built $($textRecs.Count) text INPUT_RECORDs"
$c1 = Send-Records $TargetPid $textRecs.ToArray()
L "Cycle 1 (text) => attached=$($c1.attached) written=$($c1.written) expected=$($c1.expected)"

Start-Sleep -Milliseconds 800

# Cycle 2: a lone, discrete Enter - submits the input (see PROVEN FINDING above).
$enterRecs = @(
  [ConInj]::MakeKey([char]13, 0x0D, $true),
  [ConInj]::MakeKey([char]13, 0x0D, $false)
)
$c2 = Send-Records $TargetPid $enterRecs
L "Cycle 2 (Enter) => attached=$($c2.attached) written=$($c2.written) expected=$($c2.expected)"

$ok = $c1.attached -and $c2.attached -and ($c1.written -eq $c1.expected) -and ($c2.written -eq $c2.expected)
Write-Output (@{ attached = ($c1.attached -and $c2.attached); written = ($c1.written + $c2.written); expected = ($c1.expected + $c2.expected); ok = [bool]$ok } | ConvertTo-Json -Compress)
L "INJECTOR END ok=$ok"
if ($ok) { exit 0 } else { exit 1 }

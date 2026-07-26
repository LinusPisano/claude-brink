' Brink - zero-flash launcher for watchdog.ps1.
' Task Scheduler runs THIS (wscript.exe) instead of powershell.exe directly because a
' scheduled interactive powershell -WindowStyle Hidden still flashes a console frame
' for a moment at logon; WScript.Shell.Run with window style 0 never shows one.
' Argument 1 = full path to watchdog.ps1. Fire-and-forget (bWaitOnReturn = False):
' wscript exits immediately, the hidden daemon keeps running on its own.
If WScript.Arguments.Count < 1 Then WScript.Quit 1
Dim sh: Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & WScript.Arguments(0) & """", 0, False

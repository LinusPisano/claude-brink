#!/usr/bin/env node
// Brink — inject-continue.ps1 integration test. Spawns a throwaway ReadLine target
// in its OWN console, injects, asserts the flag file received the text. Never touches
// the live session (own throwaway pid only).
//
// Hardened (flake fix): the target script gets a per-run UNIQUE filename (random
// token), the pid lookup matches that token (never the bare basename, which could
// latch a stale/leaked target from a previous interrupted run) and excludes the
// finder's own pid (its command line contains the token too). Cleanup of the exact
// spawned pid runs on EVERY exit path so a target can never leak.
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs'); const os = require('os'); const path = require('path');
let fail = 0;
const ok = (m) => console.log('  ok:   ' + m);
const bad = (m) => { console.log('  FAIL: ' + m); fail = 1; };
if (os.platform() !== 'win32') { console.log('  skip: inject test is win32-only'); process.exit(0); }

const token = crypto.randomBytes(8).toString('hex');           // per-run unique marker
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-inj-'));
const flag = path.join(tmp, 'flag.txt');
const targetPs = path.join(tmp, `target-${token}.ps1`);        // unique basename per run
fs.writeFileSync(targetPs, `$x=[Console]::ReadLine(); Set-Content -Path '${flag.replace(/\\/g,'\\\\')}' -Value "GOT:$x"`);

let pid = 0;
// Always-run teardown: kill the exact pid we spawned+found (or, if the pid lookup
// failed, anything whose command line carries THIS run's unique token — which can
// only ever be our own spawn), then remove the temp dir.
function cleanup() {
  try {
    if (pid) {
      spawnSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`]);
    } else {
      spawnSync('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*target-${token}.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`]);
    }
  } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
function finish() { cleanup(); console.log(''); process.exit(fail ? 1 : 0); }

// Launch the target in its OWN new console window so it has a real console to attach to.
const child = spawn('cmd', ['/c', 'start', '/min', '', 'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', targetPs], { windowsHide: false });

// Give it a moment to reach ReadLine, then find its pid by THIS run's unique token
// (excluding the finder powershell itself, whose command line also contains the token).
spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 2']);
const find = spawnSync('powershell', ['-NoProfile', '-Command',
  `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*target-${token}.ps1*' } | Select-Object -First 1 -ExpandProperty ProcessId`],
  { encoding: 'utf8' });
pid = parseInt((find.stdout || '').trim(), 10) || 0;
if (!pid) { bad('could not find throwaway target pid'); finish(); }

const inj = path.join(__dirname, '..', 'src', 'inject-continue.ps1');
const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', inj, '-TargetPid', String(pid), '-Text', 'continue'], { encoding: 'utf8' });
spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 2']);

const got = fs.existsSync(flag) ? fs.readFileSync(flag, 'utf8') : '';
if (/GOT:continue/.test(got)) ok('injected text reached the target ReadLine'); else bad('target did not receive text (got: ' + JSON.stringify(got) + '; injector: ' + (r.stdout||'').trim() + ')');

finish();

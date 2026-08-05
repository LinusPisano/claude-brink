#!/usr/bin/env node
// Brink — resume-dispatch.ps1 integration test (Task 7). Win32-only.
//
// Case A (in-place): a throwaway ReadLine console target we spawn OURSELVES (never a
// real claude/terminal) is recorded as the resume-ctx SessionPid/SessionStartTime.
// Re-detection is deterministic via BRINK_DISPATCH_DETECT_OVERRIDE (mirrors brink.js's
// BRINK_DETECT_OVERRIDE seam) so the test never depends on the ambient terminal
// ancestry the test runner happens to be launched under. Asserts the target's flag
// file received the injected text and that the headless `claude` shim was NOT invoked.
//
// Case B (fallback): a ctx whose SessionPid can never match (pid 4 = the Windows
// "System" process, always alive, whose real CreationDate can never equal our
// fabricated SessionStartTime) forces the PID-reuse guard to fail closed, routing to
// the headless resume-once.ps1 path. Also exercises pre-launch hardening Task 8
// (-ClaudeExe threading): TWO stubs are used — one at an absolute path passed via
// -ClaudeExe (asserted to run), and a SEPARATE one only reachable via a bare `claude`
// PATH lookup (asserted to NOT run, proving -ClaudeExe took precedence over PATH). The
// PATH stub also doubles as a safety net: if resume-once.ps1 ever ignored -ClaudeExe,
// it would hit that fake stub instead of a real claude.exe.
//
// Safety: only pids THIS test spawns are ever targeted/killed. No real claude.exe,
// WindowsTerminal.exe, or OpenConsole.exe is touched.
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs'); const os = require('os'); const path = require('path');

let fail = 0;
const ok = (m) => console.log('  ok:   ' + m);
const bad = (m) => { console.log('  FAIL: ' + m); fail = 1; };
if (os.platform() !== 'win32') { console.log('  skip: dispatch test is win32-only'); process.exit(0); }

const dispatchPs = path.join(__dirname, '..', 'src', 'resume-dispatch.ps1');

function psQuery(cmd) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });
  return (r.stdout || '').trim();
}

// ---------------------------------------------------------------------------
// Case A — in-place injection
// ---------------------------------------------------------------------------
console.log('Case A — injectable ctx => in-place inject, no headless fallback:');
{
  const token = crypto.randomBytes(8).toString('hex');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispA-'));
  const flag = path.join(tmp, 'flag.txt');
  const targetPs = path.join(tmp, `target-${token}.ps1`);
  fs.writeFileSync(targetPs, `$x=[Console]::ReadLine(); Set-Content -Path '${flag.replace(/\\/g, '\\\\')}' -Value "GOT:$x"`);

  // Shim dir: if the dispatcher mistakenly fell back to headless resume-once.ps1, this
  // sentinel would appear — Case A asserts it does NOT.
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispA-shim-'));
  const sentinel = path.join(shimDir, 'sentinel.txt');
  fs.writeFileSync(path.join(shimDir, 'claude.cmd'), `@echo off\r\necho SENTINEL>"${sentinel}"\r\nexit /b 0\r\n`);

  let pid = 0;
  function cleanup() {
    try { if (pid) spawnSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`]); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch {}
  }

  // Launch the target in its OWN new console window (same proven pattern as inject.test.js).
  spawn('cmd', ['/c', 'start', '/min', '', 'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', targetPs], { windowsHide: false });
  spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 2']);

  const find = spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*target-${token}.ps1*' } | Select-Object -First 1 -ExpandProperty ProcessId`],
    { encoding: 'utf8' });
  pid = parseInt((find.stdout || '').trim(), 10) || 0;

  if (!pid) {
    bad('could not find throwaway target pid');
  } else {
    const startTime = psQuery(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToString('o')`);
    if (!startTime) {
      bad('could not read throwaway target CreationDate');
    } else {
      const ctxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispA-ctx-'));
      const ctxPath = path.join(ctxDir, 'resume-ctx.json');
      const ctx = {
        SessionPid: pid, SessionStartTime: startTime, Terminal: 'Conhost',
        Injectable: true, InjectionMethod: 'AttachConsole_WriteConsoleInput',
        sid: 'dispatchA', proj: ctxDir, continue_prompt: 'continue',
      };
      fs.writeFileSync(ctxPath, JSON.stringify(ctx));

      // Safety-gap regression (max_chain must cover in-place resumes too): seed an
      // existing chain_<sid> counter as if 2 prior auto-resumes already happened, so
      // this run proves the dispatcher READS and increments an existing value (not just
      // creates a fresh one at 1). BRINK_DIR below is ctxDir, so this is where
      // resume-dispatch.ps1 must look.
      const chainPath = path.join(ctxDir, 'chain_dispatchA');
      fs.writeFileSync(chainPath, '2');

      // Pre-launch hardening Task 4: SessionDir is the per-session dir (separate from
      // ctxDir/proj) where brink.js would have written HANDOFF.md. Seed a placeholder so
      // this test can assert the dispatcher deletes it once the pause is resolved.
      const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispA-sdir-'));
      const handoffPath = path.join(sessionDir, 'HANDOFF.md');
      fs.writeFileSync(handoffPath, '# HANDOFF - paused by Brink\nplaceholder for dispatch Case A');

      const env = {
        ...process.env,
        PATH: shimDir + path.delimiter + (process.env.PATH || ''),
        Path: shimDir + path.delimiter + (process.env.Path || process.env.PATH || ''),
        BRINK_SILENT: '1',
        BRINK_DIR: ctxDir,
        BRINK_DISPATCH_DETECT_OVERRIDE: JSON.stringify({ HasWinConsole: true, Terminal: 'Conhost', Confidence: 'High' }),
      };
      const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', dispatchPs,
        '-Sid', 'dispatchA', '-Proj', ctxDir, '-CtxPath', ctxPath, '-SessionDir', sessionDir], { encoding: 'utf8', env, timeout: 30000 });

      spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 2']);

      const got = fs.existsSync(flag) ? fs.readFileSync(flag, 'utf8') : '';
      if (/GOT:continue/.test(got)) ok('injected continue_prompt reached the live-session target');
      else bad('target did not receive injected text (got: ' + JSON.stringify(got) + '; dispatcher stdout: ' + (r.stdout || '').slice(0, 300) + '; stderr: ' + (r.stderr || '').slice(0, 300) + ')');

      if (!fs.existsSync(sentinel)) ok('headless claude shim NOT invoked (stayed in-place)');
      else bad('headless claude shim WAS invoked — dispatcher fell back despite an injectable ctx');

      if (!fs.existsSync(ctxPath)) ok('resume-ctx file consumed (removed) after dispatch');
      else bad('resume-ctx file left behind after dispatch');

      // Report 2026-07-27 fix 1: the handoff is the RECOVERY artifact — an in-place
      // resume (verified or legacy-unverifiable, as here: ctx has no transcript_path)
      // must never delete it. Only a headless resume that actually consumed it may.
      if (fs.existsSync(handoffPath)) ok('session handoff (HANDOFF.md) PRESERVED after in-place resume (only headless consumes it)');
      else bad('session handoff (HANDOFF.md) was deleted on the in-place path - the 2026-07-27 unrecoverable-miss regression');

      // Report 2026-07-27 fix 3: the in-place path must leave a forensic record.
      const dispLog = path.join(sessionDir, '.claude-resume.log');
      const dispLogTxt = fs.existsSync(dispLog) ? fs.readFileSync(dispLog, 'utf8') : '';
      if (/\[dispatch\]/.test(dispLogTxt) && /legacy ctx without transcript_path/.test(dispLogTxt)) ok('in-place path logged to .claude-resume.log (incl. legacy-ctx note)');
      else bad('in-place path left no dispatch log (got: ' + JSON.stringify(dispLogTxt.slice(0, 200)) + ')');

      // The safety-gap fix under test: in-place resumes must increment chain_<sid> just
      // like resume-once.ps1 does for the headless path, or brink.js's max_chain arm-time
      // cap (src/brink.js, chainAllowed()) never trips for a runaway in-place loop.
      const chainSeen = fs.existsSync(chainPath) ? fs.readFileSync(chainPath, 'utf8').trim() : null;
      if (chainSeen === '3') ok('chain_<sid> incremented (seeded 2 -> 3) after in-place resume - now counts toward max_chain cap');
      else bad('chain_<sid> not incremented correctly after in-place resume (expected "3", got: ' + JSON.stringify(chainSeen) + ')');

      try { fs.rmSync(ctxDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
    }
  }
  cleanup();
}

// ---------------------------------------------------------------------------
// Case D — in-place injection VERIFIED via transcript growth (report 2026-07-27 fix 2)
// ---------------------------------------------------------------------------
console.log('Case D — ctx with transcript_path, transcript grows => verified in-place, no fallback:');
{
  const token = crypto.randomBytes(8).toString('hex');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispD-'));
  const flag = path.join(tmp, 'flag.txt');
  const transcript = path.join(tmp, 'transcript.jsonl');
  fs.writeFileSync(transcript, '{"seed":true}\n'); // exists before injection, must GROW after
  const targetPs = path.join(tmp, `target-${token}.ps1`);
  // The throwaway target plays the paused session: on receiving the injected line it
  // appends to ITS transcript — exactly the signal a real submit produces.
  fs.writeFileSync(targetPs,
    `$x=[Console]::ReadLine(); Set-Content -Path '${flag.replace(/\\/g, '\\\\')}' -Value "GOT:$x"; Add-Content -Path '${transcript.replace(/\\/g, '\\\\')}' -Value '{"role":"user"}'`);

  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispD-shim-'));
  const sentinel = path.join(shimDir, 'sentinel.txt');
  fs.writeFileSync(path.join(shimDir, 'claude.cmd'), `@echo off\r\necho SENTINEL>"${sentinel}"\r\nexit /b 0\r\n`);

  let pid = 0;
  spawn('cmd', ['/c', 'start', '/min', '', 'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', targetPs], { windowsHide: false });
  spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 2']);
  const find = spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*target-${token}.ps1*' } | Select-Object -First 1 -ExpandProperty ProcessId`],
    { encoding: 'utf8' });
  pid = parseInt((find.stdout || '').trim(), 10) || 0;

  if (!pid) {
    bad('could not find throwaway target pid (Case D)');
  } else {
    const startTime = psQuery(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToString('o')`);
    if (!startTime) {
      bad('could not read throwaway target CreationDate (Case D)');
    } else {
      const ctxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispD-ctx-'));
      const ctxPath = path.join(ctxDir, 'resume-ctx.json');
      fs.writeFileSync(ctxPath, JSON.stringify({
        SessionPid: pid, SessionStartTime: startTime, Terminal: 'Conhost',
        Injectable: true, InjectionMethod: 'AttachConsole_WriteConsoleInput',
        sid: 'dispatchD', proj: ctxDir, continue_prompt: 'continue', transcript_path: transcript,
      }));
      const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispD-sdir-'));
      const handoffPath = path.join(sessionDir, 'HANDOFF.md');
      fs.writeFileSync(handoffPath, '# HANDOFF - paused by Brink\nplaceholder for dispatch Case D');

      const env = {
        ...process.env,
        PATH: shimDir + path.delimiter + (process.env.PATH || ''),
        Path: shimDir + path.delimiter + (process.env.Path || process.env.PATH || ''),
        BRINK_SILENT: '1',
        BRINK_DIR: ctxDir,
        BRINK_DISPATCH_VERIFY_SECS: '15',
        BRINK_DISPATCH_DETECT_OVERRIDE: JSON.stringify({ HasWinConsole: true, Terminal: 'Conhost', Confidence: 'High' }),
      };
      const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', dispatchPs,
        '-Sid', 'dispatchD', '-Proj', ctxDir, '-CtxPath', ctxPath, '-SessionDir', sessionDir], { encoding: 'utf8', env, timeout: 60000 });

      if (!fs.existsSync(sentinel)) ok('verified in-place: headless shim NOT invoked');
      else bad('headless shim invoked despite transcript growth - verification failed to detect the advance');
      if (!fs.existsSync(ctxPath)) ok('resume-ctx consumed after verified in-place');
      else bad('resume-ctx left behind after verified in-place');
      if (fs.existsSync(handoffPath)) ok('handoff PRESERVED after verified in-place');
      else bad('handoff deleted after verified in-place');
      const logTxt = fs.existsSync(path.join(sessionDir, '.claude-resume.log')) ? fs.readFileSync(path.join(sessionDir, '.claude-resume.log'), 'utf8') : '';
      if (/VERIFIED: transcript grew/.test(logTxt)) ok('dispatch log records transcript verification');
      else bad('dispatch log missing VERIFIED line (got: ' + JSON.stringify(logTxt.slice(0, 300)) + '; stdout: ' + (r.stdout || '').slice(0, 200) + ')');

      try { fs.rmSync(ctxDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
    }
  }
  try { if (pid) spawnSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`]); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// Case E — injection lands but transcript does NOT grow => headless fallback
// (the 2026-07-27 wrong-window scenario: write-success is not session-success)
// ---------------------------------------------------------------------------
console.log('Case E — ctx with transcript_path, transcript static => falls back to headless:');
{
  const token = crypto.randomBytes(8).toString('hex');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispE-'));
  const flag = path.join(tmp, 'flag.txt');
  const transcript = path.join(tmp, 'transcript.jsonl');
  fs.writeFileSync(transcript, '{"seed":true}\n'); // never grows: the "wrong window" got the keystrokes
  const targetPs = path.join(tmp, `target-${token}.ps1`);
  fs.writeFileSync(targetPs, `$x=[Console]::ReadLine(); Set-Content -Path '${flag.replace(/\\/g, '\\\\')}' -Value "GOT:$x"`);

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispE-proj-'));
  const absExeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispE-absexe-'));
  const absClaudeExe = path.join(absExeDir, 'claude.cmd');
  const absSentinel = path.join(absExeDir, 'sentinel.txt');
  fs.writeFileSync(absClaudeExe, `@echo off\r\necho ABS_SENTINEL>"${absSentinel}"\r\nexit /b 0\r\n`);

  let pid = 0;
  spawn('cmd', ['/c', 'start', '/min', '', 'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', targetPs], { windowsHide: false });
  spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 2']);
  const find = spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*target-${token}.ps1*' } | Select-Object -First 1 -ExpandProperty ProcessId`],
    { encoding: 'utf8' });
  pid = parseInt((find.stdout || '').trim(), 10) || 0;

  if (!pid) {
    bad('could not find throwaway target pid (Case E)');
  } else {
    const startTime = psQuery(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToString('o')`);
    if (!startTime) {
      bad('could not read throwaway target CreationDate (Case E)');
    } else {
      const ctxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispE-ctx-'));
      const ctxPath = path.join(ctxDir, 'resume-ctx.json');
      fs.writeFileSync(ctxPath, JSON.stringify({
        SessionPid: pid, SessionStartTime: startTime, Terminal: 'Conhost',
        Injectable: true, InjectionMethod: 'AttachConsole_WriteConsoleInput',
        sid: 'dispatchE', proj: projDir, continue_prompt: 'continue', transcript_path: transcript,
      }));
      const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispE-sdir-'));
      const handoffPath = path.join(sessionDir, 'HANDOFF.md');
      fs.writeFileSync(handoffPath, '# HANDOFF - paused by Brink\nplaceholder for dispatch Case E');

      const env = {
        ...process.env,
        BRINK_SILENT: '1',
        BRINK_DIR: ctxDir,            // fresh, no state.json => weekly precheck skips
        BRINK_NO_SCHEDULE: '1',
        BRINK_DISPATCH_VERIFY_SECS: '6',
        BRINK_DISPATCH_DETECT_OVERRIDE: JSON.stringify({ HasWinConsole: true, Terminal: 'Conhost', Confidence: 'High' }),
      };
      const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', dispatchPs,
        '-Sid', 'dispatchE', '-Proj', projDir, '-CtxPath', ctxPath, '-SessionDir', sessionDir,
        '-ClaudeExe', absClaudeExe], { encoding: 'utf8', env, timeout: 90000 });

      if (fs.existsSync(absSentinel)) ok('unverified injection fell back to headless resume');
      else bad('headless fallback did NOT fire after unverified injection (stdout: ' + (r.stdout || '').slice(0, 300) + '; stderr: ' + (r.stderr || '').slice(0, 300) + ')');
      const logTxt = fs.existsSync(path.join(sessionDir, '.claude-resume.log')) ? fs.readFileSync(path.join(sessionDir, '.claude-resume.log'), 'utf8') : '';
      if (/NOT verified: transcript unchanged/.test(logTxt)) ok('dispatch log records the failed verification');
      else bad('dispatch log missing NOT-verified line (got: ' + JSON.stringify(logTxt.slice(0, 300)) + ')');
      // Headless path genuinely ran (stub exit 0) => pause resolved => both consumed.
      if (!fs.existsSync(ctxPath)) ok('resume-ctx consumed after headless fallback resolved the pause');
      else bad('resume-ctx left behind after headless fallback');
      if (!fs.existsSync(handoffPath)) ok('handoff consumed by the headless resume (the one path allowed to delete it)');
      else bad('handoff still present after a real headless resume consumed it');

      try { fs.rmSync(ctxDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
    }
  }
  try { if (pid) spawnSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`]); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(absExeDir, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// Case B — fallback to headless resume
// ---------------------------------------------------------------------------
console.log('Case B — unmatched SessionPid => falls back to headless resume-once.ps1:');
{
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispB-proj-'));
  const ctxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispB-ctx-'));
  const brinkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispB-dir-'));
  // shimDir stays on PATH but is NOT what -ClaudeExe points at — it's a safety net only:
  // if resume-once.ps1 ever ignored -ClaudeExe and fell through to a bare `claude` PATH
  // lookup, THIS stub (not a real claude.exe) would be what got found and run.
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispB-shim-'));
  // absExeDir is deliberately NOT added to PATH — the only way resume-once.ps1 can reach
  // its stub is via the explicit -ClaudeExe absolute path (pre-launch hardening Task 8),
  // which is what proves the abs-path invocation actually happened, not a PATH lookup
  // that happened to land on an identically-named shim.
  const absExeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispB-absexe-'));
  // Pre-launch hardening Task 4: SessionDir is separate from projDir — resume-once.ps1's
  // log AND the resume prompt's handoff reference must both point here, not at $Proj.
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispB-sdir-'));
  const handoffPath = path.join(sessionDir, 'HANDOFF.md');
  fs.writeFileSync(handoffPath, '# HANDOFF - paused by Brink\nplaceholder for dispatch Case B');

  const pathSentinel = path.join(shimDir, 'sentinel.txt');
  fs.writeFileSync(path.join(shimDir, 'claude.cmd'), `@echo off\r\necho PATH_SENTINEL>"${pathSentinel}"\r\nexit /b 0\r\n`);

  const absClaudeExe = path.join(absExeDir, 'claude.cmd');
  const absSentinel = path.join(absExeDir, 'sentinel.txt');
  const absArgsFile = path.join(absExeDir, 'args.txt');
  // Also capture the full argument line the stub was invoked with (%*) so the test can
  // assert the resume prompt referenced the handoff by its ABSOLUTE session-dir path,
  // not a bare "HANDOFF.md" that wouldn't resolve once claude's cwd is $Proj.
  fs.writeFileSync(absClaudeExe, `@echo off\r\necho ABS_SENTINEL>"${absSentinel}"\r\necho %*>"${absArgsFile}"\r\nexit /b 0\r\n`);

  const ctxPath = path.join(ctxDir, 'resume-ctx.json');
  // Pid 4 = Windows "System", always alive, whose real (very old, boot-time) CreationDate
  // can never equal this fabricated SessionStartTime — the PID-reuse guard fails closed
  // regardless of whether pid 4 exists, so this is deterministic without needing to
  // guarantee a truly-dead pid (which would otherwise race with OS pid reuse).
  const ctx = {
    SessionPid: 4, SessionStartTime: '1999-01-01T00:00:00.000Z', Terminal: 'Conhost',
    Injectable: true, InjectionMethod: 'AttachConsole_WriteConsoleInput',
    sid: 'dispatchB', proj: projDir, continue_prompt: 'continue',
  };
  fs.writeFileSync(ctxPath, JSON.stringify(ctx));

  const env = {
    ...process.env,
    PATH: shimDir + path.delimiter + (process.env.PATH || ''),
    Path: shimDir + path.delimiter + (process.env.Path || process.env.PATH || ''),
    BRINK_SILENT: '1',
    BRINK_DIR: brinkDir,          // fresh, no state.json => resume-once's weekly precheck skips
    BRINK_NO_SCHEDULE: '1',       // belt-and-suspenders; dispatcher itself never registers tasks
  };
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', dispatchPs,
    '-Sid', 'dispatchB', '-Proj', projDir, '-CtxPath', ctxPath, '-SessionDir', sessionDir,
    '-ClaudeExe', absClaudeExe], { encoding: 'utf8', env, timeout: 30000 });

  if (fs.existsSync(absSentinel)) ok('claude WAS invoked via the absolute -ClaudeExe path (fell back to headless resume correctly)');
  else bad('abs-path claude stub NOT invoked — headless fallback did not fire (dispatcher stdout: ' + (r.stdout || '').slice(0, 300) + '; stderr: ' + (r.stderr || '').slice(0, 300) + ')');

  if (!fs.existsSync(pathSentinel)) ok('bare `claude` PATH lookup was NOT used (abs -ClaudeExe took precedence)');
  else bad('bare `claude` PATH-lookup stub was invoked — resume-once.ps1 ignored -ClaudeExe');

  const log = path.join(sessionDir, '.claude-resume.log');
  if (fs.existsSync(log)) ok('.claude-resume.log written to the SESSION dir (not $Proj)');
  else bad('.claude-resume.log missing from session dir — resume-once.ps1 did not run to completion or wrote it to the old $Proj location');

  const oldLog = path.join(projDir, '.claude-resume.log');
  if (!fs.existsSync(oldLog)) ok('.claude-resume.log NOT written to the old $Proj location');
  else bad('.claude-resume.log still written to the old $Proj location');

  const argsSeen = fs.existsSync(absArgsFile) ? fs.readFileSync(absArgsFile, 'utf8') : '';
  if (argsSeen.includes(handoffPath)) ok('resume prompt referenced the ABSOLUTE handoff path');
  else bad('resume prompt did not reference the absolute handoff path (args seen: ' + JSON.stringify(argsSeen.slice(0, 300)) + ')');

  // Chain accounting on the headless fallback path is unchanged by this fix: it's still
  // owned entirely by resume-once.ps1 (BRINK_DIR here is brinkDir), and the dispatcher's
  // own in-place chain-increment code never runs for Case B (the PID-reuse guard fails
  // closed before reaching the $ok branch that increments) - so the counter must land at
  // exactly 1, not 2 (which would indicate a double-count from both scripts).
  const chainPathB = path.join(brinkDir, 'chain_dispatchB');
  const chainSeenB = fs.existsSync(chainPathB) ? fs.readFileSync(chainPathB, 'utf8').trim() : null;
  if (chainSeenB === '1') ok('chain_<sid> incremented exactly once by resume-once.ps1 on the headless path (no double-count)');
  else bad('chain_<sid> unexpected on headless path (expected "1", got: ' + JSON.stringify(chainSeenB) + ')');

  try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(ctxDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(brinkDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(absExeDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// Case C — headless fallback RE-ARMS (weekly cap still maxed) => ctx + handoff PRESERVED
// ---------------------------------------------------------------------------
console.log('Case C — headless fallback re-arms for weekly reset => handoff + ctx kept, not deleted:');
{
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispC-proj-'));
  const ctxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispC-ctx-'));
  const brinkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispC-dir-'));
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispC-shim-'));
  const absExeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispC-absexe-'));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispC-sdir-'));
  const handoffPath = path.join(sessionDir, 'HANDOFF.md');
  fs.writeFileSync(handoffPath, '# HANDOFF - paused by Brink\nplaceholder for dispatch Case C');

  // resume-once.ps1's weekly-cap precheck reads BRINK_DIR/state.json: week_pct still at/
  // above the (default 95) weekly-pause threshold AND week_reset still in the future =>
  // it must re-arm (call arm-resume.ps1) and exit with the sentinel code instead of
  // relaunching claude.
  const weekReset = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  fs.writeFileSync(path.join(brinkDir, 'state.json'), JSON.stringify({ week_pct: 96, week_reset: weekReset }));

  const pathSentinel = path.join(shimDir, 'sentinel.txt');
  fs.writeFileSync(path.join(shimDir, 'claude.cmd'), `@echo off\r\necho PATH_SENTINEL>"${pathSentinel}"\r\nexit /b 0\r\n`);

  const absClaudeExe = path.join(absExeDir, 'claude.cmd');
  const absSentinel = path.join(absExeDir, 'sentinel.txt');
  fs.writeFileSync(absClaudeExe, `@echo off\r\necho ABS_SENTINEL>"${absSentinel}"\r\nexit /b 0\r\n`);

  const ctxPath = path.join(ctxDir, 'resume-ctx.json');
  // Same PID-reuse-guard-fails-closed trick as Case B: forces the in-place attempt to
  // fail and fall through to the headless resume-once.ps1 path, where the weekly-cap
  // precheck under test lives.
  const ctx = {
    SessionPid: 4, SessionStartTime: '1999-01-01T00:00:00.000Z', Terminal: 'Conhost',
    Injectable: true, InjectionMethod: 'AttachConsole_WriteConsoleInput',
    sid: 'dispatchC', proj: projDir, continue_prompt: 'continue',
  };
  fs.writeFileSync(ctxPath, JSON.stringify(ctx));

  const env = {
    ...process.env,
    PATH: shimDir + path.delimiter + (process.env.PATH || ''),
    Path: shimDir + path.delimiter + (process.env.Path || process.env.PATH || ''),
    BRINK_SILENT: '1',
    BRINK_DIR: brinkDir,          // seeded state.json => resume-once's weekly precheck fires
    BRINK_NO_SCHEDULE: '1',       // re-arm's arm-resume.ps1 must not touch the real Task Scheduler
  };
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', dispatchPs,
    '-Sid', 'dispatchC', '-Proj', projDir, '-CtxPath', ctxPath, '-SessionDir', sessionDir,
    '-ClaudeExe', absClaudeExe], { encoding: 'utf8', env, timeout: 30000 });

  if (!fs.existsSync(absSentinel)) ok('claude was NOT relaunched (weekly-cap precheck re-armed instead)');
  else bad('claude WAS invoked despite the weekly cap still being maxed - precheck did not re-arm (dispatcher stdout: ' + (r.stdout || '').slice(0, 300) + '; stderr: ' + (r.stderr || '').slice(0, 300) + ')');

  if (fs.existsSync(ctxPath)) ok('resume-ctx file PRESERVED (re-arm did not resolve the pause)');
  else bad('resume-ctx file was deleted despite the headless fallback only re-arming, not resuming');

  if (fs.existsSync(handoffPath)) ok('session handoff (HANDOFF.md) PRESERVED (re-arm did not resolve the pause)');
  else bad('session handoff (HANDOFF.md) was deleted despite the headless fallback only re-arming, not resuming');

  try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(ctxDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(brinkDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(absExeDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// Case F — headless fallback with an EMPTY -ClaudeExe (code review 2026-08-05, finding 2):
// PS 5.1's native-arg passing drops an unquoted-then-dropped empty string across the
// powershell.exe child-process boundary, so resume-once.ps1 used to fail parameter
// binding before its own script body (which already has a documented empty-ClaudeExe
// fallback to a bare `claude` PATH lookup, resume-once.ps1:95-101) ever ran. Regression
// signal: the PATH-lookup stub being invoked at all, and chain_<sid> being written — both
// only happen from INSIDE resume-once.ps1's own body. (.claude-resume.log is NOT a valid
// signal here: resume-dispatch.ps1 itself writes to that file before ever spawning the
// child, so it exists either way.) Under the bug, PowerShell's own "Missing an argument for
// parameter 'ClaudeExe'" killed the child before its body ran, yet resume-dispatch.ps1 still
// read the child's exit code as "resolved" and deleted resume-ctx.json + HANDOFF.md —
// silently losing the recovery artifact for a resume that never happened.
// ---------------------------------------------------------------------------
console.log('Case F — empty -ClaudeExe => headless fallback still binds params and runs (does not lose the handoff):');
{
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispF-proj-'));
  const ctxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispF-ctx-'));
  const brinkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispF-dir-'));
  // Now the ONLY way claude gets invoked, since -ClaudeExe is empty and resume-once.ps1
  // must fall back to a bare `claude` PATH lookup (resume-once.ps1:95-101).
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispF-shim-'));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-dispF-sdir-'));
  const handoffPath = path.join(sessionDir, 'HANDOFF.md');
  fs.writeFileSync(handoffPath, '# HANDOFF - paused by Brink\nplaceholder for dispatch Case F');

  const pathSentinel = path.join(shimDir, 'sentinel.txt');
  fs.writeFileSync(path.join(shimDir, 'claude.cmd'), `@echo off\r\necho PATH_SENTINEL>"${pathSentinel}"\r\nexit /b 0\r\n`);

  const ctxPath = path.join(ctxDir, 'resume-ctx.json');
  // Same PID-reuse trick as Case B: pid 4 ("System") can never match this fabricated
  // SessionStartTime, so the PID-reuse guard fails closed and routes to headless.
  const ctx = {
    SessionPid: 4, SessionStartTime: '1999-01-01T00:00:00.000Z', Terminal: 'Conhost',
    Injectable: true, InjectionMethod: 'AttachConsole_WriteConsoleInput',
    sid: 'dispatchF', proj: projDir, continue_prompt: 'continue',
  };
  fs.writeFileSync(ctxPath, JSON.stringify(ctx));

  const env = {
    ...process.env,
    PATH: shimDir + path.delimiter + (process.env.PATH || ''),
    Path: shimDir + path.delimiter + (process.env.Path || process.env.PATH || ''),
    BRINK_SILENT: '1',
    BRINK_DIR: brinkDir,          // fresh, no state.json => resume-once's weekly precheck skips
    BRINK_NO_SCHEDULE: '1',
  };
  // Deliberately NO -ClaudeExe flag at all — resume-dispatch.ps1's own param default ('')
  // is exactly the value arm-resume.ps1 writes when claude-exe.js never resolved a path.
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', dispatchPs,
    '-Sid', 'dispatchF', '-Proj', projDir, '-CtxPath', ctxPath, '-SessionDir', sessionDir],
    { encoding: 'utf8', env, timeout: 30000 });

  if (fs.existsSync(pathSentinel)) ok('bare `claude` PATH lookup was invoked (resume-once.ps1 started and reached its own empty-ClaudeExe fallback)');
  else bad('bare `claude` PATH-lookup stub was NOT invoked — resume-once.ps1 did not reach its own fallback branch');

  if (!fs.existsSync(ctxPath)) ok('resume-ctx.json consumed (pause genuinely resolved)');
  else bad('resume-ctx.json still present — dispatcher did not resolve the pause');

  if (!fs.existsSync(handoffPath)) ok('HANDOFF.md consumed by a headless resume that actually ran');
  else bad('HANDOFF.md still present — dispatcher treated the pause as unresolved');

  const chainPathF = path.join(brinkDir, 'chain_dispatchF');
  const chainSeenF = fs.existsSync(chainPathF) ? fs.readFileSync(chainPathF, 'utf8').trim() : null;
  if (chainSeenF === '1') ok('chain_<sid> incremented by resume-once.ps1 (its own body ran, not just the dispatcher)');
  else bad('chain_<sid> unexpected (expected "1", got: ' + JSON.stringify(chainSeenF) + ') — resume-once.ps1 likely never reached its own logic');

  try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(ctxDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(brinkDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
}

console.log(''); process.exit(fail ? 1 : 0);

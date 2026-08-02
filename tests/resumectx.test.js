#!/usr/bin/env node
// Brink — resume-in-place: brink.js must record the live-session target at pause
// (resume-ctx-<sid>.json), so the reset-time dispatcher (Task 7) can inject
// "continue" into it. Win32-only (in-place is Windows-only, per shouldArm).
//
// Deterministic seam: BRINK_DETECT_OVERRIDE (test-only, honored by brink.js) feeds a
// fabricated Resolve-BrinkTarget result so the ctx-write path is exercised the SAME way
// every run, independent of the ambient process ancestry (which under `npm test`
// dead-ends at an exited shell and resolves Injectable=false — that made a prior version
// of this test degrade to a vacuous skip).
// Sandbox: BRINK_DIR is a temp dir; BRINK_NO_SCHEDULE suppresses the real Task Scheduler
// registration so this never touches the live scheduler.
const { spawnSync } = require('child_process'); const fs=require('fs'); const os=require('os'); const path=require('path');
const paths = require('../src/core/paths');
let fail=0; const ok=(m)=>console.log('  ok:   '+m); const bad=(m)=>{console.log('  FAIL: '+m);fail=1;};
if (os.platform() !== 'win32') { console.log('  skip: resume-ctx test is win32-only'); process.exit(0); }

const brink = path.join(__dirname, '..', 'src', 'brink.js');
const future = Math.floor(Date.now()/1000)+3600;

// Run one brink.js pause in a fresh sandbox with the given detect override; return
// { sb, ctxPath, stdout, stderr, handoff }.
// NOTE (pre-launch hardening Task 3): HANDOFF.md and resume-ctx.json no longer land
// flat in the brink dir (sb) — they nest under core/paths.sessionDir(sb, cwd, sid).
// Here BRINK_DIR (sb) and the hook's cwd are the SAME temp dir (by construction of
// this sandbox), so both paths are still deterministic via BRINK_DETECT_OVERRIDE.
function pauseWith(detectOverride) {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(),'brink-ctx-'));
  const projCwd = sb.replace(/\\/g,'/');
  fs.writeFileSync(path.join(sb,'state.json'), JSON.stringify({ five_pct:99, week_pct:10, five_reset:future, week_reset:future+500000, session_id:'ctxsid', cwd: projCwd }));
  fs.writeFileSync(path.join(sb,'config.json'), JSON.stringify({ resume: { enabled:true, in_place:true } }));
  const env = { ...process.env, BRINK_DIR: sb, BRINK_SILENT:'1', BRINK_NO_SCHEDULE:'1', BRINK_DETECT_OVERRIDE: detectOverride };
  const r = spawnSync('node', [brink,'claude','pause'], { encoding:'utf8', env, input: JSON.stringify({ cwd: projCwd, session_id:'ctxsid', transcript_path: projCwd + '/t.jsonl' }), timeout: 20000 });
  return {
    sb,
    ctxPath: paths.ctxPath(sb, projCwd, 'ctxsid'),
    stdout: r.stdout || '', stderr: r.stderr || '',
    handoff: paths.handoffPath(sb, projCwd, 'ctxsid'),
  };
}

// --- Case A: an INJECTABLE target must be recorded, with all fields ---
console.log('Case A — injectable target => ctx written:');
{
  const INJ = JSON.stringify({ SessionPid:4321, SessionStartTime:'2026-07-10T00:00:00.000Z', Terminal:'WindowsTerminal', Injectable:true, InjectionMethod:'WriteConsoleInput_or_UIA' });
  const a = pauseWith(INJ);
  if (fs.existsSync(a.ctxPath)) {
    ok('resume-ctx-<sid>.json written at pause');
    // UTF-8 BOM (pre-launch hardening Task 7): brink.js writes this file WITH a leading
    // UTF-8 BOM (EF BB BF) so PowerShell 5.1's Get-Content -Raw sniffs the encoding
    // correctly instead of falling back to ANSI and mangling a non-ASCII continue_prompt.
    const rawBytes = fs.readFileSync(a.ctxPath);
    if (rawBytes[0] === 0xEF && rawBytes[1] === 0xBB && rawBytes[2] === 0xBF) ok('ctx file starts with the UTF-8 BOM bytes (EF BB BF)');
    else bad('ctx file missing the UTF-8 BOM bytes: ' + Buffer.from(rawBytes.slice(0,3)).toString('hex'));
    // Node's utf8 decode does NOT strip a leading BOM char (U+FEFF) and JSON.parse
    // rejects it, so strip it here the same way any real consumer must.
    let ctx = null; try { ctx = JSON.parse(fs.readFileSync(a.ctxPath, 'utf8').replace(/^﻿/, '')); } catch {}
    if (ctx) ok('ctx file still JSON.parses once the BOM is stripped');
    else bad('ctx file failed to JSON.parse after stripping the BOM');
    if (ctx && ctx.SessionPid === 4321) ok('ctx.SessionPid === 4321 (from detect result)');
    else bad('ctx.SessionPid !== 4321: ' + JSON.stringify(ctx && ctx.SessionPid));
    if (ctx && ctx.SessionStartTime === '2026-07-10T00:00:00.000Z') ok('ctx.SessionStartTime carried through');
    else bad('ctx.SessionStartTime wrong: ' + JSON.stringify(ctx && ctx.SessionStartTime));
    if (ctx && ctx.Injectable === true) ok('ctx.Injectable === true');
    else bad('ctx.Injectable !== true');
    if (ctx && ctx.InjectionMethod === 'WriteConsoleInput_or_UIA') ok('ctx.InjectionMethod carried through');
    else bad('ctx.InjectionMethod wrong');
    if (ctx && ctx.sid === 'ctxsid') ok('ctx.sid === hook session_id (ctxsid)');
    else bad('ctx.sid wrong: ' + JSON.stringify(ctx && ctx.sid));
    if (ctx && typeof ctx.continue_prompt === 'string' && ctx.continue_prompt.length > 0) ok('ctx.continue_prompt present (non-empty string)');
    else bad('ctx.continue_prompt missing/empty');
    if (ctx && ctx.proj === a.sb.replace(/\\/g,'/')) ok('ctx.proj === sandbox cwd');
    else bad('ctx.proj wrong: ' + JSON.stringify(ctx && ctx.proj));
    // Report 2026-07-27 fix 2: the transcript path is what binds the dispatcher's
    // success verification to THIS session — it must be recorded at pause time.
    if (ctx && ctx.transcript_path === a.sb.replace(/\\/g,'/') + '/t.jsonl') ok('ctx.transcript_path recorded from the hook payload');
    else bad('ctx.transcript_path wrong: ' + JSON.stringify(ctx && ctx.transcript_path));
  } else {
    bad('resume-ctx not written for an injectable target');
    console.log('  stdout: ' + a.stdout.slice(0,300));
    console.log('  stderr: ' + a.stderr.slice(0,300));
  }
  // Existing pause flow must be undisturbed by the ctx write.
  if (a.stdout.includes('"permissionDecision":"deny"')) ok('pause deny still fires');
  else bad('pause deny missing');
  if (fs.existsSync(a.handoff)) ok('HANDOFF.md still written (existing flow undisturbed)');
  else bad('HANDOFF.md missing');
  // Pre-launch hardening Task 3: HANDOFF must live under the per-session dir, never
  // flat in the brink dir root (the pre-Task-3 <cwd>/HANDOFF.md location).
  if (!fs.existsSync(path.join(a.sb, 'HANDOFF.md'))) ok('HANDOFF.md NOT written flat at brink-dir root (session dir only)');
  else bad('HANDOFF.md leaked into the flat brink-dir root — session-dir nesting broken');
  // The deny reason must point at the handoff's REAL absolute location, not a bare
  // "HANDOFF.md" basename (which would send the paused model to a repo file that isn't
  // there). Parse the JSON so the check sees the unescaped path.
  let reasonA = ''; try { reasonA = JSON.parse(a.stdout).hookSpecificOutput.permissionDecisionReason; } catch {}
  if (reasonA.includes(a.handoff) && a.handoff !== path.basename(a.handoff)) ok('deny reason names the handoff ABSOLUTE path (not a bare basename)');
  else bad('deny reason missing the handoff absolute path (' + JSON.stringify(a.handoff) + '): ' + JSON.stringify(reasonA.slice(0, 200)));
  try { fs.rmSync(a.sb,{recursive:true,force:true}); } catch {}
}

// --- Case B: a NON-injectable target must NOT be recorded (the gate) ---
console.log('Case B — non-injectable target => ctx withheld:');
{
  const NOTINJ = JSON.stringify({ SessionPid:4321, SessionStartTime:'2026-07-10T00:00:00.000Z', Terminal:'Unknown', Injectable:false, InjectionMethod:'none' });
  const b = pauseWith(NOTINJ);
  if (!fs.existsSync(b.ctxPath)) ok('resume-ctx NOT written when Injectable=false (gate holds)');
  else bad('resume-ctx written despite Injectable=false — gate broken');
  if (b.stdout.includes('"permissionDecision":"deny"')) ok('pause deny still fires (non-injectable path)');
  else bad('pause deny missing (non-injectable path)');
  if (fs.existsSync(b.handoff)) ok('HANDOFF.md still written (non-injectable path)');
  else bad('HANDOFF.md missing (non-injectable path)');
  try { fs.rmSync(b.sb,{recursive:true,force:true}); } catch {}
}

console.log(''); process.exit(fail?1:0);

#!/usr/bin/env node
// Brink core driver. Usage: node brink.js <claude|codex> <warn|pause|busy|idle|end>
// Reads usage via the adapter, decides via the shared threshold engine, then:
//   warn  -> fires a debounced notification (once per window/band/reset-block)
//   pause -> Brink WRITES HANDOFF.md itself, then emits the adapter's native deny with a
//            short, credible, non-contradictory reason (see Phase 5 / live-test findings).
//   busy/idle/end -> watchdog busy-marker upkeep (opt-in, config watchdog.mode; see
//            core/watchdog.js for the lifecycle). These run BEFORE the usage read —
//            marker upkeep must work even when the sensor has no data yet.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { decide, projectionCfg, projectedDecision } = require('./core/thresholds');
const { readHistory } = require('./core/sensor-record');
const { writeHandoff } = require('./core/handoff');
const { shouldArm, armArgs, chainAllowed, pauseReason, resumeCfg } = require('./core/resume');
const { serializeCtx } = require('./core/target');
const paths = require('./core/paths');
const { resolveClaudeExe } = require('./core/claude-exe');
const { watchdogCfg, busyMarkerPath } = require('./core/watchdog');

const DIR = process.env.BRINK_DIR || path.join(os.homedir(), '.claude', 'brink');
const HATCH = path.join(DIR, 'DISABLED');
const FLAG_TTL_MS = 14 * 24 * 3600 * 1000; // GC debounce/armed flags older than 14 days

const DEFAULT_CFG = {
  five_hour: { warn: [75, 85], pause: Number(process.env.BRINK_PAUSE || 93) },
  seven_day: { warn: [80, 90], pause: Number(process.env.BRINK_WEEKLY_PAUSE || 95) },
};

function loadRawCfg() {
  try {
    const raw = fs.readFileSync(path.join(DIR, 'config.json'), 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch { return {}; }
}
// Deep-merge per window so a partial override ({five_hour:{pause:97}}) cannot
// silently drop the warn bands or the other window's pause (review finding).
function mergeThresholds(user) {
  const out = {};
  for (const w of ['five_hour', 'seven_day']) {
    const d = DEFAULT_CFG[w];
    const u = (user && typeof user[w] === 'object' && user[w]) || {};
    out[w] = {
      warn: Array.isArray(u.warn) && u.warn.every((n) => typeof n === 'number') ? u.warn : d.warn,
      pause: typeof u.pause === 'number' ? u.pause : d.pause,
    };
  }
  return out;
}
function loadAdapter(name) {
  if (name === 'claude') return require('./adapters/claude');
  if (name === 'codex') return require('./adapters/codex');
  throw new Error('unknown adapter: ' + name);
}
function notify(msg) {
  try {
    // stdio must INHERIT the child's stderr (not 'ignore' -> /dev/null): notify.js's
    // never-invisible fallback writes the message to ITS stderr when the desktop
    // notifier is unsupported/fails, and this is the ONLY visibility a WARN has (a warn
    // is notify()+exit(0), no deny output). Claude Code surfaces hook stderr, so the
    // fallback lands in the terminal. stdin/stdout stay ignored; still detached+unref
    // for fire-and-forget (the child self-times-out).
    const c = spawn('node', [path.join(__dirname, 'notify.js'), msg],
      { detached: true, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
    c.on('error', () => {}); // async spawn failure must never crash the hook
    c.unref();
  } catch {}
}
// Pre-launch hardening Task 8: resolve claude's ABSOLUTE path HERE, at arm time, inside
// the interactive hook process whose PATH is intact. The scheduled Task Scheduler job
// that eventually runs resume-once.ps1 only sees the persistent HKCU/HKLM registry PATH
// a non-interactive scheduled task gets - it never sees a version manager (fnm) shim, a
// shell-hook injection, or a manually-edited profile PATH entry, so a bare `claude`
// lookup inside the scheduled job can fail to find a claude that resolves fine right
// now. Threaded through arm-resume.ps1 -> resume-dispatch.ps1 -> resume-once.ps1 as
// -ClaudeExe; an empty return here just means resume-once.ps1 falls back to its
// pre-existing bare `claude` PATH lookup (doctor flags an empty resolution loudly,
// Task 11 - resolveClaudeExe now lives in core/claude-exe.js, shared with cli.js so
// both use the exact same resolution strategy).
function resetText(epoch) {
  if (typeof epoch !== 'number') return '';
  const d = new Date(epoch * 1000);
  if (isNaN(d.getTime())) return '';
  // A weekly reset can be days out — "resets at 02:30" alone would mislead.
  const far = epoch * 1000 - Date.now() > 20 * 3600 * 1000;
  return far
    ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
// A window whose resets_at is in the past has ROLLED — its stored pct is stale.
// Without this gate a resumed headless session (no statusline running yet) reads
// the pre-pause 99% and denies its own first tool call (review finding: the
// Phase 7 resume would self-block). 60s slack absorbs clock skew.
function dropStaleWindows(usage) {
  const now = Math.floor(Date.now() / 1000);
  if (typeof usage.five_reset === 'number' && usage.five_reset < now - 60) usage.five_pct = null;
  if (typeof usage.week_reset === 'number' && usage.week_reset < now - 60) usage.week_pct = null;
  return usage;
}
// A subdir only counts as a Brink session dir (core/paths.sessionDir) if it holds
// at least one of the artifacts that module actually writes there. This is the
// entire safety net against ever deleting something we didn't create ourselves —
// any other directory a user or another tool drops under DIR is left untouched.
const SESSION_DIR_MARKERS = new Set(['HANDOFF.md', '.claude-resume.log', 'resume-ctx.json', '.claude-watchdog.log']);

// Pre-launch hardening Task 5: session dirs (DIR/<project-slug>/<sid>/) are the new
// nested home for HANDOFF.md/.claude-resume.log/resume-ctx.json (core/paths.js) and
// aren't covered by the flat-file sweep above — without this they'd accumulate one
// per paused session forever. Every fs call here is individually try/caught: a GC
// bug must never crash the pause hook (this runs on the hot path before any deny).
function gcSessionDirs(cutoff) {
  let slugEntries;
  try { slugEntries = fs.readdirSync(DIR, { withFileTypes: true }); } catch { return; }
  for (const slugEnt of slugEntries) {
    // config.json/state.json/DISABLED/settings.json.brink-bak and the flat
    // notified_/armed_/chain_/resume-ctx-* flags are all plain FILES at DIR's root —
    // this isDirectory() gate alone already keeps this whole function away from them.
    if (!slugEnt.isDirectory()) continue;
    const slugDir = path.join(DIR, slugEnt.name);
    try {
      const sidEntries = fs.readdirSync(slugDir, { withFileTypes: true });
      for (const sidEnt of sidEntries) {
        if (!sidEnt.isDirectory()) continue;
        const sidDir = path.join(slugDir, sidEnt.name);
        try {
          // A SUCCESSFUL in-place resume deletes HANDOFF.md + resume-ctx.json and never
          // writes .claude-resume.log, leaving the session dir EMPTY. An empty dir has no
          // marker file, so the marker gate below (files.some) would skip it forever and
          // empty dirs would pile up one per in-place resume (review finding). Nothing to
          // lose in an empty dir, so drop it unconditionally, ahead of the marker/mtime logic.
          if (fs.readdirSync(sidDir).length === 0) { try { fs.rmdirSync(sidDir); } catch {} continue; }
          const files = fs.readdirSync(sidDir, { withFileTypes: true }).filter((e) => e.isFile());
          const looksLikeSessionDir = files.some((e) => SESSION_DIR_MARKERS.has(e.name));
          if (!looksLikeSessionDir) continue; // not recognizably ours — never touch it
          let newest = -Infinity;
          for (const f of files) {
            try {
              const m = fs.statSync(path.join(sidDir, f.name)).mtimeMs;
              if (m > newest) newest = m;
            } catch {}
          }
          if (newest < cutoff) fs.rmSync(sidDir, { recursive: true, force: true });
        } catch {}
      }
      // Best-effort: drop the now-possibly-empty project-slug dir. Only fires when
      // every session dir under it is gone (or it was already empty) — a non-empty
      // readdir here just means readdirSync().length !== 0 and we leave it alone.
      try { if (fs.readdirSync(slugDir).length === 0) fs.rmdirSync(slugDir); } catch {}
    } catch {}
  }
}

function gcFlags() {
  try {
    const cutoff = Date.now() - FLAG_TTL_MS;
    for (const f of fs.readdirSync(DIR)) {
      // resume-ctx-<sid>.json (written by the resume-in-place block below) is a
      // per-session artifact just like notified_/armed_/chain_ — without this it
      // leaks one file per pause forever on Windows resume-in-place users (review
      // finding). Hyphen-separated prefix, unlike the underscore-separated others.
      // busy_<sid>.json (watchdog markers) normally die via the idle/end hooks or
      // the daemon itself; the TTL sweep only catches strays (e.g. a reboot with
      // the watchdog off) — 14 days stale means nothing left worth reviving.
      if (!/^(notified|armed|chain|busy)_/.test(f) && !/^resume-ctx-/.test(f)) continue;
      const p = path.join(DIR, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch {}
    }
    gcSessionDirs(cutoff);
  } catch {}
}
// Only the pause path needs the hook payload (transcript_path/cwd). Read stdin lazily.
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let s = ''; let done = false;
    const fin = () => { if (done) return; done = true; try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } };
    process.stdin.on('data', (d) => { s += d; });
    process.stdin.on('end', fin);
    process.stdin.on('error', () => resolve({}));
    setTimeout(fin, 800); // fallback so a hook never hangs waiting on stdin
  });
}

// Watchdog busy-marker upkeep (see core/watchdog.js for the lifecycle contract).
// busy  (UserPromptSubmit): write/refresh busy_<sid>.json — "a turn is in flight".
// idle  (Stop):             delete it — the turn finished cleanly.
// end   (SessionEnd):       delete it, EXCEPT reason 'other': the named reasons
//        (clear/logout/prompt_input_exit/...) are deliberate teardowns, so even a
//        mid-turn quit through them means "the user wanted this dead — stay dead".
//        'other' is the unclassified bucket abnormal teardown lands in when the
//        hook gets to run at all; keeping the marker there is what lets the daemon
//        revive a window-close that happened to deliver a SessionEnd.
// Everything is best-effort: marker upkeep must NEVER break a session or block a
// prompt longer than its one detection spawn (below).
async function markTurn(mode) {
  const rawCfg = loadRawCfg();
  if (watchdogCfg(rawCfg).mode === 'off') return; // gated: zero disk/spawn cost until opted in
  const hook = await readStdin();
  const sid = hook.session_id;
  if (!sid) return; // never guess the session (multi-window finding — same rule as pause)
  const marker = busyMarkerPath(DIR, sid);

  if (mode === 'idle' || mode === 'end') {
    if (mode === 'end' && hook.reason === 'other') return;
    try { fs.unlinkSync(marker); } catch {}
    return;
  }

  // mode === 'busy'
  const cwd = process.env.CLAUDE_PROJECT_DIR || hook.cwd || process.cwd();
  const now = Math.floor(Date.now() / 1000);
  // Cheap refresh path: pid/start-time were detected on this session's FIRST prompt —
  // every later prompt just bumps the timestamp (no CIM snapshot, no PS spawn).
  try {
    const raw = fs.readFileSync(marker, 'utf8');
    const m = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    if (m && m.pid) {
      m.updated = now;
      m.proj = cwd;
      fs.writeFileSync(marker, '﻿' + JSON.stringify(m));
      return;
    }
  } catch {} // missing/corrupt -> full record below

  // First prompt of the session: resolve the persistent claude process SYNCHRONOUSLY.
  // Async-detached would cost nothing at the prompt, but the ancestry walk starts at
  // THIS hook process's pid — by the time a detached child snapshots CIM, this hook is
  // gone and the chain resolves to nothing (the same reason the pause path detects
  // synchronously). ~1-2s, once per session, at UserPromptSubmit.
  let tgt = null;
  if (process.env.BRINK_BUSY_OVERRIDE) {
    // Test-only seam, mirroring BRINK_DETECT_OVERRIDE: a fabricated
    // {SessionPid,SessionStartTime} consumed instead of a live ancestry walk so
    // tests/watchdog.test.js can assert the marker write deterministically.
    try { tgt = JSON.parse(process.env.BRINK_BUSY_OVERRIDE); } catch {}
  } else if (os.platform() === 'win32') { // watchdog is win32-only in v1, like resume
    const det = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'detect-terminal.ps1'), '-HookPid', String(process.pid)],
      { encoding: 'utf8', timeout: 15000 });
    try { tgt = JSON.parse((det.stdout || '').trim()); } catch {}
  }
  if (!tgt || !tgt.SessionPid) return; // never write a marker the daemon can't liveness-check
  fs.mkdirSync(DIR, { recursive: true });
  const m = {
    sid,
    pid: tgt.SessionPid,
    start_time: tgt.SessionStartTime || null, // PID-reuse guard input (resume-dispatch pattern)
    proj: cwd,
    session_dir: paths.sessionDir(DIR, cwd, sid), // where the daemon's revive log goes
    // Resolved HERE (interactive PATH intact) for the same reason arm-time resolves it
    // (Task 8): the daemon runs under Task Scheduler's registry-only PATH and a bare
    // `claude` lookup there can fail for version-manager/profile-PATH installs.
    claude_exe: resolveClaudeExe(),
    created: now,
    updated: now,
  };
  // UTF-8 WITH BOM: the daemon reads this via PS 5.1 Get-Content -Raw (BOM-sniffing,
  // ANSI fallback without one) — same encoding contract as resume-ctx.json (Task 7).
  fs.writeFileSync(marker, '﻿' + JSON.stringify(m));
}

async function main() {
  const [adapterName, mode = 'pause'] = process.argv.slice(2);
  const adapter = loadAdapter(adapterName);

  if (fs.existsSync(HATCH)) process.exit(0);           // kill switch

  // Watchdog marker modes run before the usage read: they must work when the
  // sensor has no data yet (first prompt of a session) and must never be blocked
  // by a usage-file problem. Guarded exit-0 like every other hook path.
  if (mode === 'busy' || mode === 'idle' || mode === 'end') {
    try { await markTurn(mode); } catch { /* marker upkeep must never break a session */ }
    process.exit(0);
  }
  const usage = adapter.readUsage();
  if (!usage) process.exit(0);                          // no data => never act blind
  dropStaleWindows(usage);

  const rawCfg = loadRawCfg();
  const cfg = mergeThresholds(rawCfg.thresholds);
  let d = decide(usage, cfg);
  if (d.action !== 'pause' && mode === 'pause') {
    // Burn-rate projection (burn-in F1): below the pause threshold (allow OR warn
    // band — the projection headroom always overlaps the warn bands) but climbing
    // fast toward it -> pause pre-emptively, before a long tool call can blow
    // through it mid-flight (where no check runs and no pause is possible).
    try {
      const proj = projectionCfg(rawCfg);
      if (proj.enabled) {
        const p = projectedDecision(usage, readHistory(DIR, 80), cfg, proj, Math.floor(Date.now() / 1000));
        if (p) d = p;
      }
    } catch { /* projection is an enhancement — never let it break the gate */ }
  }
  if (d.action === 'allow') process.exit(0);

  fs.mkdirSync(DIR, { recursive: true });
  gcFlags();
  const flag = path.join(DIR, `notified_${adapterName}_${d.windowKey}_${d.band}_${d.reset}`.replace(/[^\w.-]/g, '_'));
  const once = (msg) => { if (!fs.existsSync(flag)) { fs.writeFileSync(flag, ''); notify(msg); } };

  if (mode === 'warn' && d.action === 'warn') {
    once(`Brink: ${d.window} usage at ${Math.round(d.pct)}%`);
    process.exit(0);
  }

  if (mode === 'pause' && d.action === 'pause') {
    const hook = await readStdin();
    // Project ROOT, not shell cwd: hook.cwd drifts with mid-session `cd`s, and
    // `claude --resume` is project-scoped — a resume launched from the drifted dir
    // finds no conversation (burn-in finding 2026-07-06). CLAUDE_PROJECT_DIR is the
    // hook env's stable anchor; verified it stays on the session root while cwd drifts.
    const cwd = process.env.CLAUDE_PROJECT_DIR || hook.cwd || usage.cwd || process.cwd();
    const rt = resetText(d.reset);

    // Prefer the hook's own session_id — the shared state.json may hold another
    // concurrent session's id (multi-window finding). Computed BEFORE the handoff
    // write (moved up in pre-launch hardening Task 3) because every Brink file for
    // this pause — HANDOFF.md, resume-ctx.json, the arm-resume session dir — now
    // nests under this sid, out of the user's repo entirely:
    // ~/.claude/brink/<project-slug>/<sid>/.
    const ctx_sid = hook.session_id || usage.session_id;

    // Every Brink file for this pause nests under ONE per-session dir (core/paths),
    // out of the user's repo entirely: ~/.claude/brink/<project-slug>/<sid>/. Computed
    // once here and reused for the handoff, the resume-ctx, and the -SessionDir arg
    // handed to arm-resume.ps1 below (the basenames mirror core/paths.handoffPath/ctxPath).
    const sdir = paths.sessionDir(DIR, cwd, ctx_sid);

    // Brink writes the handoff itself — robust even if the model won't cooperate.
    const isGit = fs.existsSync(path.join(cwd, '.git'));
    const outPath = path.join(sdir, 'HANDOFF.md');
    const handoffPath = writeHandoff({ transcriptPath: hook.transcript_path, outPath, pct: d.pct, window: d.window, resetText: rt, isGit });
    once(`Brink: paused${d.projected ? ' pre-emptively' : ''} - ${d.window} at ${Math.round(d.pct)}% - disable: brink off`);

    // Resume-in-place (Phase 8, opt-in): record the live session's PID/terminal so the
    // reset-time dispatcher (resume-dispatch.ps1, Task 7) can inject "continue" into the
    // SAME window instead of forking a headless resume. Best-effort and synchronous like
    // the arming call below (Windows-only) — any failure here must never block the
    // deny/handoff path; the headless fallback still arms independently.
    let resumeCtxPath = '';
    try {
      const rc = resumeCfg(rawCfg);
      // in_place defaults TRUE but enabled defaults FALSE — gating on in_place alone
      // meant resume-OFF users spawned detect-terminal.ps1 (a full CIM enumeration) on
      // every Windows pause and leaked ctx files nothing consumed (review finding).
      // in_place is a sub-option of resume; it only matters once resume itself is on.
      if (rc.enabled && rc.in_place && os.platform() === 'win32') {
        // BRINK_DETECT_OVERRIDE (test-only): a fabricated Resolve-BrinkTarget JSON result.
        // Lets the resume-ctx test assert the write deterministically without depending on
        // the ambient process ancestry (which under `npm test` dead-ends at an exited shell
        // and resolves Injectable=false). Never set in production; the real path spawns
        // detect-terminal.ps1 as before.
        let tgt = null;
        if (process.env.BRINK_DETECT_OVERRIDE) {
          try { tgt = JSON.parse(process.env.BRINK_DETECT_OVERRIDE); } catch {}
        } else {
          const det = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            path.join(__dirname, 'detect-terminal.ps1'), '-HookPid', String(process.pid)],
            { encoding: 'utf8', timeout: 15000 });
          try { tgt = JSON.parse((det.stdout || '').trim()); } catch {}
        }
        if (tgt && tgt.Injectable) {
          const resumeCtx = { ...tgt, sid: ctx_sid, proj: cwd, continue_prompt: rc.continue_prompt };
          // Nested under the same per-session dir as HANDOFF.md, not a flat DIR-root
          // file — out of the user's repo (pre-launch Task 3).
          resumeCtxPath = path.join(sdir, 'resume-ctx.json');
          fs.mkdirSync(sdir, { recursive: true });
          // UTF-8 WITH BOM (pre-launch hardening Task 7): resume-dispatch.ps1 reads this
          // file via PowerShell 5.1's `Get-Content -Raw`, which sniffs encoding from a
          // BOM and falls back to ANSI without one — silently mangling any non-ASCII
          // continue_prompt (e.g. an em-dash) before it's injected into the resumed
          // session. Prepending U+FEFF makes Node's utf8 writer emit the 3-byte UTF-8
          // BOM (EF BB BF); empirically confirmed PS 5.1's Get-Content -Raw sniffs it and
          // strips it before ConvertFrom-Json, so no PS-side stripping is needed.
          fs.writeFileSync(resumeCtxPath, '﻿' + serializeCtx(resumeCtx));
        }
      }
    } catch { /* best-effort; headless fallback still arms */ }

    // Resume (Phase 7, opt-in): register a one-shot scheduler job for the reset time.
    // SYNCHRONOUS on purpose — live-fire testing proved PowerShell 5.1 dies when
    // spawned detached (DETACHED_PROCESS = no console) and dies with the parent's
    // console when attached, so fire-and-forget silently never registers the task.
    // A pause is a terminal event; blocking ~1-2s here is correct. The armed flag is
    // written only AFTER the scheduler confirms, so a failure can retry next call.
    // ctx_sid (same session-id var the resume-ctx write above uses) keeps both records
    // pinned to the SAME session.
    const ctx = { session_id: ctx_sid, reset: d.reset, proj: cwd };
    let armed = false; // the deny reason below must reflect what ACTUALLY got scheduled
    // Chain cap: resume-once.ps1 increments chain_<sid> on every auto-resume it fires.
    // At/above resume.max_chain we stop re-arming and say so — an unattended loop must
    // not burn every window for days (safety revisit 2026-07-06). 0 = unlimited.
    if (shouldArm(rawCfg, ctx, os.platform())) {
      let chainCount = 0;
      try { chainCount = parseInt(fs.readFileSync(path.join(DIR, `chain_${ctx.session_id}`.replace(/[^\w.-]/g, '_')), 'utf8'), 10) || 0; } catch {}
      if (!chainAllowed(rawCfg, chainCount)) {
        notify(`Brink: resume chain cap reached (${chainCount}) - not re-arming; resume manually`);
      } else {
        const armFlag = path.join(DIR, `armed_${ctx.session_id}_${ctx.reset}`.replace(/[^\w.-]/g, '_'));
        if (fs.existsSync(armFlag)) {
          armed = true; // an earlier pause in this same block already registered the job
        } else {
          try {
            const ps = path.join(__dirname, 'arm-resume.ps1');
            // Resolved here (not hoisted earlier): only spend the extra powershell/
            // where.exe round-trip when we're actually about to register the task, not
            // on every pause (e.g. resume disabled, or already armed above).
            const claudeExe = resolveClaudeExe();
            // -SessionDir (the hoisted sdir): forward reference (Task 4 wires
            // arm-resume.ps1/resume-once.ps1 to actually read it; today's arm-resume.ps1
            // silently ignores an unknown named param under `-File`, confirmed harmless).
            // Already the NEW core/paths session dir so Task 4 has nothing left to compute.
            const psArgs = armArgs(rawCfg, { ...ctx, claude_exe: claudeExe })
              .concat(['-SessionDir', sdir])
              .concat(resumeCtxPath ? ['-CtxPath', resumeCtxPath] : []);
            const r = spawnSync('powershell',
              ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps, ...psArgs],
              { stdio: 'ignore', windowsHide: true, timeout: 20000 });
            if (r.status === 0) { fs.writeFileSync(armFlag, ''); armed = true; }
            else notify('Brink: resume arming FAILED - will not auto-resume');
          } catch { /* arming is best-effort; never block the pause */ }
        }
      }
    }

    // The deny reason is the paused session's ONLY clue to where its handoff went, so
    // it must carry the ABSOLUTE path — the handoff no longer lives in the repo, and a
    // bare "HANDOFF.md" basename would point the model at a file that isn't there.
    // (A friendlier "run: brink handoff" phrasing can replace this once Task 6 lands.)
    const file = handoffPath || '';
    const reason = pauseReason({ pct: d.pct, window: d.window, resetText: rt, file, armed, projected: d.projected });
    const out = adapter.denyOutput(reason);
    if (out.stdout) process.stdout.write(out.stdout);
    if (out.stderr) process.stderr.write(out.stderr);
    process.exit(out.exitCode || 0);
  }

  process.exit(0);
}
main();

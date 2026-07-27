#!/usr/bin/env node
// Brink — burn-rate projection tests (burn-in finding F1, 2026-07-16).
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { projectionCfg, projectedDecision, stalenessCfg, stalenessCheck, STALE_DEFAULT } = require('../src/core/thresholds');
const { pauseReason } = require('../src/core/resume');

let fail = 0;
const ok = (m) => console.log('  ok:   ' + m);
const bad = (m) => { console.log('  FAIL: ' + m); fail = 1; };
const eq = (n, a, e) => (JSON.stringify(a) === JSON.stringify(e)
  ? ok(`${n} = ${JSON.stringify(e)}`)
  : bad(`${n} expected ${JSON.stringify(e)} got ${JSON.stringify(a)}`));
const truthy = (n, v) => (v ? ok(n) : bad(n + ' (was falsey)'));

console.log('projectionCfg:');
const dflt = projectionCfg({});
eq('default enabled', dflt.enabled, true);
eq('default lookahead', dflt.lookahead_min, 10);
eq('default headroom', dflt.headroom, 12);
eq('enabled:false honored', projectionCfg({ projection: { enabled: false } }).enabled, false);
eq('garbage clamps to default', projectionCfg({ projection: { lookahead_min: -5, headroom: 999 } }).lookahead_min, 10);
eq('garbage headroom clamps', projectionCfg({ projection: { headroom: 999 } }).headroom, 12);
eq('valid override kept', projectionCfg({ projection: { lookahead_min: 5 } }).lookahead_min, 5);

console.log('projectedDecision:');
const CFG = { five_hour: { warn: [75, 85], pause: 93 }, seven_day: { warn: [80, 90], pause: 95 } };
const PROJ = projectionCfg({});
const NOW = 3000000000;
const R5 = NOW + 3000; const R7 = NOW + 500000;
const usage = (f, w) => ({ five_pct: f, week_pct: w, five_reset: R5, week_reset: R7 });
const sample = (ago, f, w, over) => ({ t: NOW - ago, five_pct: f, week_pct: w, five_reset: R5, week_reset: R7, ...over });

// fast burn inside headroom -> pre-emptive pause (85 now, 75 five min ago = 2%/min -> 105 in 10 min)
const p1 = projectedDecision(usage(85, 20), [sample(300, 75, 20)], CFG, PROJ, NOW);
truthy('fast burn fires', p1);
eq('fires as pause', p1 && p1.action, 'pause');
eq('window five_hour', p1 && p1.windowKey, 'five_hour');
eq('pct is the CURRENT reading', p1 && p1.pct, 85);
eq('rate ~2/min', p1 && p1.projected.rate_per_min, 2);
eq('threshold recorded', p1 && p1.projected.threshold, 93);
eq('reset passed through', p1 && p1.reset, R5);

// slow burn -> projection stays quiet (85 -> 84 five min ago = 0.2%/min -> 87 in 10 min)
eq('slow burn stays quiet', projectedDecision(usage(85, 20), [sample(300, 84, 20)], CFG, PROJ, NOW), null);
// far from the threshold -> never projects, however fast
eq('below headroom => null', projectedDecision(usage(70, 20), [sample(300, 50, 20)], CFG, PROJ, NOW), null);
// not enough span -> one hot minute is not a trend
eq('span < min_span_sec => null', projectedDecision(usage(85, 20), [sample(60, 80, 20)], CFG, PROJ, NOW), null);
// samples from another window (rolled epoch) don't count
eq('cross-window samples => null',
  projectedDecision(usage(85, 20), [sample(300, 75, 20, { five_reset: R5 - 18000 })], CFG, PROJ, NOW), null);
// at/over the threshold decide() owns it — projection must NOT double-claim
eq('cur >= pause => null (decide owns it)', projectedDecision(usage(94, 20), [sample(300, 75, 20)], CFG, PROJ, NOW), null);
// negative rate (window rolled back? weird data) -> quiet
eq('negative rate => null', projectedDecision(usage(85, 20), [sample(300, 90, 20)], CFG, PROJ, NOW), null);
// stale samples outside window_sec are ignored
eq('stale samples => null', projectedDecision(usage(85, 20), [sample(2000, 75, 20)], CFG, PROJ, NOW), null);
// disabled kills it
eq('disabled => null',
  projectedDecision(usage(85, 20), [sample(300, 75, 20)], CFG, projectionCfg({ projection: { enabled: false } }), NOW), null);
// weekly window projects too
const pw = projectedDecision(usage(20, 88), [sample(300, 20, 78)], CFG, PROJ, NOW);
eq('weekly projects', pw && pw.windowKey, 'seven_day');
// both eligible -> the more urgent (bigger overshoot) wins
const pb = projectedDecision(usage(85, 90), [sample(300, 80, 78)], CFG, PROJ, NOW);
// five: 85 + 1*10 = 95 vs 93 (+2); weekly: 90 + 2.4*10 = 114 vs 95 (+19) -> weekly
eq('urgency picks weekly', pb && pb.windowKey, 'seven_day');
// empty history -> null
eq('no samples => null', projectedDecision(usage(85, 20), [], CFG, PROJ, NOW), null);

console.log('pauseReason (projected):');
const projMsg = pauseReason({ pct: 85, window: '5h', resetText: '14:10', file: 'C:/x/HANDOFF.md', armed: true,
  projected: { rate_per_min: 2, lookahead_min: 10, threshold: 93 } });
truthy('says pre-emptive', /pre-emptive/.test(projMsg));
truthy('shows the rate', /~2%\/min/.test(projMsg));
truthy('shows the threshold', /93% pause threshold/.test(projMsg));
truthy('still shows the off-switch', /brink off/.test(projMsg));
const plainMsg = pauseReason({ pct: 99, window: '5h', resetText: '14:10', file: '', armed: false });
truthy('non-projected message unchanged', /^Paused by Brink: you are at 99%/.test(plainMsg));
truthy('non-projected has no rate clause', !/pre-emptive|%\/min/.test(plainMsg));

console.log('end-to-end through brink.js (sandboxed):');
const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-proj-'));
const sbCwd = sb.replace(/\\/g, '/');
const nowSec = Math.floor(Date.now() / 1000);
const r5 = nowSec + 3000; const r7 = nowSec + 500000;
// current reading: 87% five-hour (below 93 pause, inside headroom 12)
fs.writeFileSync(path.join(sb, 'state.json'),
  JSON.stringify({ five_pct: 87, week_pct: 10, five_reset: r5, week_reset: r7, session_id: 'proj', cwd: sbCwd, updated_at: nowSec }));
// history: 77% five minutes ago -> 2%/min -> projected 107 >= 93
fs.writeFileSync(path.join(sb, 'usage-history.jsonl'),
  JSON.stringify({ t: nowSec - 300, five_pct: 77, week_pct: 10, five_reset: r5, week_reset: r7, sid: 'proj' }) + '\n');
const env = { ...process.env, BRINK_DIR: sb, BRINK_SILENT: '1', CLAUDE_PROJECT_DIR: sbCwd };
const out = execFileSync('node', [path.join(__dirname, '..', 'src', 'brink.js'), 'claude', 'pause'],
  { encoding: 'utf8', env, input: JSON.stringify({ cwd: sbCwd }), timeout: 15000 });
truthy('projected deny fires', out.includes('"permissionDecision":"deny"'));
truthy('deny reason says pre-emptive', /pre-emptive/.test(out));
// without history -> same reading must ALLOW (proves the deny above came from projection)
fs.unlinkSync(path.join(sb, 'usage-history.jsonl'));
const out2 = execFileSync('node', [path.join(__dirname, '..', 'src', 'brink.js'), 'claude', 'pause'],
  { encoding: 'utf8', env, input: JSON.stringify({ cwd: sbCwd }), timeout: 15000 });
eq('no history => allow (empty stdout)', out2.trim(), '');
// projection.enabled:false -> allow even with hot history
fs.writeFileSync(path.join(sb, 'usage-history.jsonl'),
  JSON.stringify({ t: nowSec - 300, five_pct: 77, week_pct: 10, five_reset: r5, week_reset: r7, sid: 'proj' }) + '\n');
fs.writeFileSync(path.join(sb, 'config.json'), JSON.stringify({ projection: { enabled: false } }));
const out3 = execFileSync('node', [path.join(__dirname, '..', 'src', 'brink.js'), 'claude', 'pause'],
  { encoding: 'utf8', env, input: JSON.stringify({ cwd: sbCwd }), timeout: 15000 });
eq('projection disabled => allow', out3.trim(), '');
fs.rmSync(sb, { recursive: true, force: true });

// --- Staleness guard (blind-spot report 2026-07-22, revised after the 07-27 hook test) ---
// The 07-22 burn: a background fan-out spent ~5M tokens while the main session sat idle.
// The 07-27 test proved subagent tool calls DO reach the gate, so brink.js WAS invoked
// throughout — it just kept reading a state.json frozen before the burn began. A frozen
// low reading is indistinguishable from a genuinely low one unless we look at its age.
// The guard reports; it must never pause on age alone (we cannot know the real number).
console.log('stalenessCfg:');
eq('empty => defaults', stalenessCfg({}), STALE_DEFAULT);
eq('enabled coerced to bool', stalenessCfg({ staleness: { enabled: 'yes' } }).enabled, true);
eq('explicit false honored', stalenessCfg({ staleness: { enabled: false } }).enabled, false);
eq('max_age floored', stalenessCfg({ staleness: { max_age_sec: 90.7 } }).max_age_sec, 90);
eq('zero/negative max_age clamps to default', stalenessCfg({ staleness: { max_age_sec: 0 } }).max_age_sec, STALE_DEFAULT.max_age_sec);

console.log('stalenessCheck:');
const SCFG = STALE_DEFAULT;
const SNOW = 1_800_000_000;
eq('fresh reading => null', stalenessCheck({ updated_at: SNOW - 10 }, SCFG, SNOW), null);
eq('exactly at max_age is NOT stale', stalenessCheck({ updated_at: SNOW - SCFG.max_age_sec }, SCFG, SNOW), null);
truthy('older than max_age => reports', !!stalenessCheck({ updated_at: SNOW - SCFG.max_age_sec - 1 }, SCFG, SNOW));
eq('reports the actual age', stalenessCheck({ updated_at: SNOW - 900 }, SCFG, SNOW).age_sec, 900);
eq('disabled => null even when very stale', stalenessCheck({ updated_at: SNOW - 99999 }, { ...SCFG, enabled: false }, SNOW), null);
// Never cry wolf on data we cannot judge: pre-`updated_at` state files, and clocks
// that skew forward (a future stamp is not evidence of a stale read).
eq('missing updated_at => null (cannot judge)', stalenessCheck({}, SCFG, SNOW), null);
eq('future timestamp (clock skew) => null', stalenessCheck({ updated_at: SNOW + 120 }, SCFG, SNOW), null);
// The guard is advisory only — pausing on age would pause on no evidence at all.
truthy('never returns a pause action', !('action' in (stalenessCheck({ updated_at: SNOW - 900 }, SCFG, SNOW) || {})));

// Wiring, not just units. The projection shipped with green unit tests and a dead
// trigger because it was gated on `action === 'allow'` while the headroom zone always
// sits inside a WARN band. Staleness has the mirror-image trap: a frozen reading is
// almost always LOW, so the gate decides `allow` and exits — a guard placed after that
// exit can never fire. These run the real brink.js and assert the on-disk side effect.
console.log('staleness wiring through brink.js (sandboxed):');
const ssb = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-stale-'));
const ssbCwd = ssb.replace(/\\/g, '/');
const sNow = Math.floor(Date.now() / 1000);
const staleFlags = () => fs.readdirSync(ssb).filter((f) => /^stale/i.test(f));
const writeState = (updatedAt) => fs.writeFileSync(path.join(ssb, 'state.json'), JSON.stringify({
  five_pct: 8, week_pct: 10, five_reset: sNow + 3000, week_reset: sNow + 500000,
  session_id: 'stale', cwd: ssbCwd, updated_at: updatedAt,
}));
const runGate = () => execFileSync('node', [path.join(__dirname, '..', 'src', 'brink.js'), 'claude', 'pause'],
  { encoding: 'utf8', env: { ...process.env, BRINK_DIR: ssb, BRINK_SILENT: '1', CLAUDE_PROJECT_DIR: ssbCwd },
    input: JSON.stringify({ cwd: ssbCwd }), timeout: 15000 });

// 20 minutes stale at 8% — exactly the 07-22 shape: a low number nobody should trust.
writeState(sNow - 1200);
const staleOut = runGate();
eq('stale reading still ALLOWS (never pause on age alone)', staleOut.trim(), '');
truthy('stale reading fires the guard (flag on disk)', staleFlags().length === 1);

// Same frozen stamp must not re-notify on every subsequent tool call.
runGate();
truthy('debounced while the stamp stays frozen', staleFlags().length === 1);

// Control: a fresh reading must leave no trace — proves the flag above came from age.
fs.rmSync(ssb, { recursive: true, force: true }); fs.mkdirSync(ssb, { recursive: true });
writeState(sNow);
runGate();
truthy('fresh reading fires nothing', staleFlags().length === 0);

// Control: opt-out honored.
fs.writeFileSync(path.join(ssb, 'config.json'), JSON.stringify({ staleness: { enabled: false } }));
writeState(sNow - 1200);
runGate();
truthy('staleness disabled => silent', staleFlags().length === 0);

// Every per-freeze flag is a file. Without a GC prefix they accumulate forever — the
// same leak the resume-ctx sweep was added to stop. Old flags must age out like the rest.
fs.rmSync(path.join(ssb, 'config.json'), { force: true });
const oldFlag = path.join(ssb, 'stale_claude_1700000000');
fs.writeFileSync(oldFlag, '');
const old = Date.now() - 15 * 24 * 3600 * 1000; // 15 days > FLAG_TTL_MS (14d)
fs.utimesSync(oldFlag, old / 1000, old / 1000);
// gcFlags() only runs past the allow-exit, so drive a real WARN (80% = warn band).
fs.writeFileSync(path.join(ssb, 'state.json'), JSON.stringify({
  five_pct: 80, week_pct: 10, five_reset: sNow + 3000, week_reset: sNow + 500000,
  session_id: 'stale', cwd: ssbCwd, updated_at: sNow,
}));
runGate();
truthy('stale flags older than the TTL are swept', !fs.existsSync(oldFlag));
fs.rmSync(ssb, { recursive: true, force: true });

console.log('');
if (fail) { console.log('SOME FAILED'); process.exit(1); } else { console.log('ALL PASS'); }

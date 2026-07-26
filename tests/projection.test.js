#!/usr/bin/env node
// Brink — burn-rate projection tests (burn-in finding F1, 2026-07-16).
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { projectionCfg, projectedDecision } = require('../src/core/thresholds');
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

console.log('');
if (fail) { console.log('SOME FAILED'); process.exit(1); } else { console.log('ALL PASS'); }

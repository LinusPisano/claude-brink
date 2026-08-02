#!/usr/bin/env node
// Brink — sensor-record tests (burn-in fixes 2026-07-16). Node-only, isolated temp dirs.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { recordUsage, detectMeterDrops, readHistory, HISTORY_FILE } = require('../src/core/sensor-record');

let fail = 0;
const ok = (m) => console.log('  ok:   ' + m);
const bad = (m) => { console.log('  FAIL: ' + m); fail = 1; };
const eq = (n, a, e) => (JSON.stringify(a) === JSON.stringify(e)
  ? ok(`${n} = ${JSON.stringify(e)}`)
  : bad(`${n} expected ${JSON.stringify(e)} got ${JSON.stringify(a)}`));
const truthy = (n, v) => (v ? ok(n) : bad(n + ' (was falsey)'));

const E = 2000000000; // a reset epoch
const CFG = { reset_ping: { five_hour: { enabled: false, floor: 75 }, seven_day: { enabled: true, floor: 80 } } };

console.log('detectMeterDrops:');
// The 2026-07-16 incident shape: weekly 95 -> 4, reset epoch unchanged.
const drop = detectMeterDrops({ week_pct: 95, week_reset: E }, { week_pct: 4, week_reset: E });
eq('big same-window drop fires', drop.length, 1);
eq('drop window', drop[0] && drop[0].windowKey, 'seven_day');
truthy('drop message shows 95% -> 4%', drop[0] && /dropped 95% -> 4%/.test(drop[0].message));
// A rollover is reset.js territory, never a "drop".
eq('rolled window => no drop',
  detectMeterDrops({ week_pct: 95, week_reset: E }, { week_pct: 4, week_reset: E + 7 * 86400 }).length, 0);
// Small wobble / low height = noise.
eq('small drop => none', detectMeterDrops({ week_pct: 85, week_reset: E }, { week_pct: 80, week_reset: E }).length, 0);
eq('low prev => none', detectMeterDrops({ week_pct: 40, week_reset: E }, { week_pct: 5, week_reset: E }).length, 0);
// Missing data never fires.
eq('null pct => none', detectMeterDrops({ week_pct: null, week_reset: E }, { week_pct: 4, week_reset: E }).length, 0);
eq('null reset => none', detectMeterDrops({ week_pct: 95, week_reset: null }, { week_pct: 4, week_reset: null }).length, 0);
eq('no prev => none', detectMeterDrops(null, { week_pct: 4, week_reset: E }).length, 0);
// 5h window drops detect too.
eq('5h drop fires', detectMeterDrops({ five_pct: 90, five_reset: E }, { five_pct: 10, five_reset: E }).length, 1);

console.log('recordUsage:');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-sr-'));
const mk = (over) => ({ five_pct: 50, week_pct: 20, five_reset: E, week_reset: E + 500, session_id: 'sr-1', cwd: '/p', ...over });
const now = Math.floor(Date.now() / 1000);

const r1 = recordUsage(dir, mk({}), CFG);
const written = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
eq('state five_pct persisted', written.five_pct, 50);
eq('state session_id persisted', written.session_id, 'sr-1');
truthy('state stamped with updated_at (~now)', typeof written.updated_at === 'number' && Math.abs(written.updated_at - now) <= 5);
eq('first run: no events (no prev)', r1.events.length, 0);
truthy('history file created', fs.existsSync(path.join(dir, HISTORY_FILE)));

const r2 = recordUsage(dir, mk({ week_pct: 96 }), CFG);
eq('second run: still no events', r2.events.length, 0);
const h2 = readHistory(dir);
eq('history has 2 entries', h2.length, 2);
eq('history entry has t', typeof h2[0].t, 'number');
eq('history newest week_pct', h2[1].week_pct, 96);

// weekly reset event passes through (prev 96 + epoch advance + weekly ping enabled)
const r3 = recordUsage(dir, mk({ week_pct: 2, week_reset: E + 500 + 7 * 86400 }), CFG);
eq('reset event passes through', r3.events.length, 1);
truthy('reset message', /weekly limit reset/.test(r3.events[0].message));

// meter drop event surfaces (rebuild the high reading first, same epoch)
recordUsage(dir, mk({ week_pct: 95, week_reset: E + 500 + 7 * 86400 }), CFG);
const r4 = recordUsage(dir, mk({ week_pct: 4, week_reset: E + 500 + 7 * 86400 }), CFG);
eq('drop event surfaces', r4.events.length, 1);
truthy('drop message via recordUsage', /dropped 95% -> 4%/.test(r4.events[0].message));

console.log('history prune:');
// Seed an oversized history, then one recordUsage must prune it to the keep-window.
const junk = JSON.stringify({ t: now, five_pct: 1, week_pct: 1, five_reset: E, week_reset: E, sid: 'x' });
const lines = new Array(Math.ceil((300 * 1024) / (junk.length + 1))).fill(junk);
fs.writeFileSync(path.join(dir, HISTORY_FILE), lines.join('\n') + '\n');
recordUsage(dir, mk({}), CFG);
const pruned = readHistory(dir);
truthy(`pruned to <= 501 lines (got ${pruned.length})`, pruned.length <= 501);
truthy('newest entry survived the prune', pruned[pruned.length - 1].sid === 'sr-1');

console.log('readHistory:');
eq('missing file => []', readHistory(fs.mkdtempSync(path.join(os.tmpdir(), 'brink-sr-none-'))).length, 0);
fs.appendFileSync(path.join(dir, HISTORY_FILE), 'not json\n');
truthy('malformed lines dropped', readHistory(dir).every((e) => typeof e.t === 'number'));
// limit slices LINES then drops malformed ones — the junk line above eats one slot,
// so <= limit (never more) is the contract, not exactly-limit.
const limited = readHistory(dir, 3);
truthy(`limit is an upper bound (got ${limited.length} <= 3)`, limited.length <= 3 && limited.length >= 2);

console.log('statusline integration (sensor writes updated_at + history):');
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-sr-sl-'));
const script = path.join(__dirname, '..', 'src', 'statusline-brink.js');
const env = { ...process.env, BRINK_DIR: tmp2, BRINK_NO_RESET_PING: '1' };
const out = execFileSync('node', [script], {
  input: JSON.stringify({ session_id: 's-sl', workspace: { current_dir: '/p' },
    model: { id: 'claude-fable-5', display_name: 'Fable' },
    rate_limits: { five_hour: { used_percentage: 42, resets_at: E }, seven_day: { used_percentage: 7, resets_at: E + 500 },
      fable_weekly: { used_percentage: 12 } } }),
  env, encoding: 'utf8',
});
truthy('statusline renders', /5h:42%/.test(out));
const sst = JSON.parse(fs.readFileSync(path.join(tmp2, 'state.json'), 'utf8'));
truthy('statusline state has updated_at', typeof sst.updated_at === 'number');
// Report 2026-07-31 defect 1: the pause decision's inputs must carry the model
// dimension, and any rate-limit buckets beyond the two we read must at least be NAMED
// (the per-model-bucket probe) instead of silently dropped.
eq('statusline state records the session model', sst.model, 'claude-fable-5');
eq('statusline state names extra rate-limit buckets', sst.rl_extra, ['fable_weekly']);
eq('statusline history written', readHistory(tmp2).length, 1);
eq('history line carries the model', readHistory(tmp2)[0].model, 'claude-fable-5');
eq('history line carries rl_extra', readHistory(tmp2)[0].rl_extra, ['fable_weekly']);
// drop through the statusline: seed high, feed low, must not crash (ping suppressed by env)
fs.writeFileSync(path.join(tmp2, 'state.json'),
  JSON.stringify({ five_pct: 50, week_pct: 95, five_reset: E, week_reset: E + 500, session_id: 's-sl', cwd: '/p' }));
execFileSync('node', [script], {
  input: JSON.stringify({ session_id: 's-sl', workspace: { current_dir: '/p' },
    rate_limits: { five_hour: { used_percentage: 50, resets_at: E }, seven_day: { used_percentage: 4, resets_at: E + 500 } } }),
  env, encoding: 'utf8',
});
ok('statusline survives a meter-drop reading');

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(tmp2, { recursive: true, force: true });
console.log('');
if (fail) { console.log('SOME FAILED'); process.exit(1); } else { console.log('ALL PASS'); }

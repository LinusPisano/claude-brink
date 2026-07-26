#!/usr/bin/env node
// Brink — reset-ping detector tests (Phase 6). Node-only, isolated temp dirs.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectResets } = require('../src/core/reset');

let fail = 0;
const ok = (m) => console.log('  ok:   ' + m);
const bad = (m) => { console.log('  FAIL: ' + m); fail = 1; };
const eq = (n, a, e) => (JSON.stringify(a) === JSON.stringify(e)
  ? ok(`${n} = ${JSON.stringify(e)}`)
  : bad(`${n} expected ${JSON.stringify(e)} got ${JSON.stringify(a)}`));
const truthy = (n, v) => (v ? ok(n) : bad(n + ' (was falsey)'));

// default config: weekly ON (floor 80), 5h OFF (floor 75)
const CFG = { reset_ping: { five_hour: { enabled: false, floor: 75 }, seven_day: { enabled: true, floor: 80 } } };
const E1 = 1000000000;          // a reset epoch
const E2 = E1 + 7 * 86400;      // rolled over a week later

console.log('detectResets:');

// no prior state -> never ping (fresh install / first refresh)
eq('no prev => []', detectResets(null, { week_reset: E2, week_pct: 5 }, CFG).length, 0);

// weekly rolled over from high usage -> 1 ping
const a = detectResets({ week_reset: E1, week_pct: 96 }, { week_reset: E2, week_pct: 3 }, CFG);
eq('weekly reset count', a.length, 1);
eq('weekly reset window', a[0] && a[0].windowKey, 'seven_day');
truthy('message says weekly', a[0] && /weekly limit reset/.test(a[0].message));
truthy('message shows prior pct', a[0] && /was 96%/.test(a[0].message));

// weekly rolled over but you were never near the limit -> noise, stays silent
eq('weekly reset below floor => []',
  detectResets({ week_reset: E1, week_pct: 12 }, { week_reset: E2, week_pct: 3 }, CFG).length, 0);

// 5h rolled over but disabled by default -> no ping
eq('5h disabled => []',
  detectResets({ five_reset: E1, five_pct: 99 }, { five_reset: E1 + 5 * 3600, five_pct: 2 }, CFG).length, 0);

// 5h enabled via config + above floor -> pings
const cfg5 = { reset_ping: { five_hour: { enabled: true, floor: 75 }, seven_day: { enabled: true, floor: 80 } } };
const b = detectResets({ five_reset: E1, five_pct: 95 }, { five_reset: E1 + 5 * 3600, five_pct: 1 }, cfg5);
eq('5h enabled reset count', b.length, 1);
eq('5h reset window', b[0] && b[0].windowKey, 'five_hour');

// same epoch (no rollover) -> nothing
eq('no advance => []',
  detectResets({ week_reset: E1, week_pct: 96 }, { week_reset: E1, week_pct: 96 }, CFG).length, 0);

// epoch went backwards (weird data) -> nothing
eq('backwards epoch => []',
  detectResets({ week_reset: E2, week_pct: 96 }, { week_reset: E1, week_pct: 96 }, CFG).length, 0);

// sub-GUARD jitter -> nothing (kills float wobble)
eq('jitter within guard => []',
  detectResets({ week_reset: E1, week_pct: 96 }, { week_reset: E1 + 30, week_pct: 96 }, CFG).length, 0);

// null epochs -> nothing
eq('null epochs => []',
  detectResets({ week_reset: null, week_pct: 96 }, { week_reset: null, week_pct: 3 }, CFG).length, 0);

// unknown prior pct (null) -> can't gate, fire anyway (lenient, no false-silence)
eq('null prevPct still fires',
  detectResets({ week_reset: E1, week_pct: null }, { week_reset: E2, week_pct: 3 }, CFG).length, 1);

// both windows reset at once, both enabled -> 2 events
const both = detectResets(
  { five_reset: E1, five_pct: 95, week_reset: E1, week_pct: 96 },
  { five_reset: E1 + 5 * 3600, five_pct: 1, week_reset: E2, week_pct: 2 }, cfg5);
eq('both windows reset count', both.length, 2);

console.log('statusline integration (Phase 6 wiring, no crash + state still written):');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-r-'));
const script = path.join(__dirname, '..', 'src', 'statusline-brink.js');
// BRINK_NO_RESET_PING avoids spawning a detached notifier during the test
const env = { ...process.env, BRINK_DIR: tmp, BRINK_NO_RESET_PING: '1' };
// seed a prior state at 96% weekly with an old reset epoch
fs.writeFileSync(path.join(tmp, 'state.json'),
  JSON.stringify({ five_pct: 50, week_pct: 96, five_reset: E1, week_reset: E1, session_id: 's', cwd: '/p' }));
const out = execFileSync('node', [script], {
  input: JSON.stringify({ session_id: 's2', workspace: { current_dir: '/p' },
    rate_limits: { five_hour: { used_percentage: 50, resets_at: E1 }, seven_day: { used_percentage: 3, resets_at: E2 } } }),
  env, encoding: 'utf8',
});
truthy('statusline still renders', /7d:3%/.test(out));
const st = JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'), 'utf8'));
eq('new state has rolled weekly epoch', st.week_reset, E2);
eq('new state weekly pct dropped', st.week_pct, 3);
fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
if (fail) { console.log('SOME FAILED'); process.exit(1); } else { console.log('ALL PASS'); }

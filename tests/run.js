#!/usr/bin/env node
// Brink — Phase 1 test: the statusline renders AND writes a valid state.json.
// Runs in an isolated temp BRINK_DIR — never touches the live ~/.claude.
// Zero deps (Node only). Run:  node tests/run.js

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const script = path.join(__dirname, '..', 'src', 'statusline-brink.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-'));
const env = { ...process.env, BRINK_DIR: tmp };
const statePath = path.join(tmp, 'state.json');

let fail = 0;
const ok  = (m) => console.log('  ok:   ' + m);
const bad = (m) => { console.log('  FAIL: ' + m); fail = 1; };
const eq  = (n, a, e) => (a === e ? ok(`${n} = ${JSON.stringify(e)}`)
  : bad(`${n} expected ${JSON.stringify(e)} got ${JSON.stringify(a)}`));
const has = (n, s, sub) => (s.includes(sub) ? ok(`${n} contains "${sub}"`)
  : bad(`${n} missing "${sub}" (got "${s}")`));

const run = (obj) => execFileSync('node', [script], { input: JSON.stringify(obj), env, encoding: 'utf8' });
const state = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));

console.log('Case 1 - full rate_limits:');
const now = Math.floor(Date.now() / 1000);
const reset = now + 5400; // 90 min out
const out = run({
  model: { display_name: 'Opus' },
  session_id: 'sess-123',
  workspace: { current_dir: '/c/proj/foo' },
  rate_limits: {
    five_hour: { used_percentage: 78.7, resets_at: reset },
    seven_day: { used_percentage: 54.2, resets_at: reset },
  },
});
has('render', out, '5h:79%');   // 78.7 -> 79
has('render', out, '(1h');      // ~1h30m countdown
has('render', out, '7d:54%');
let s = state();
eq('five_pct', s.five_pct, 78.7);
eq('week_pct', s.week_pct, 54.2);
eq('five_reset', s.five_reset, reset);
eq('session_id', s.session_id, 'sess-123');
eq('cwd', s.cwd, '/c/proj/foo');

console.log('Case 2 - no rate_limits (early session, must NOT pause):');
run({ model: { display_name: 'Opus' }, session_id: 'sess-x', workspace: { current_dir: '/c/p' } });
s = state();
eq('five_pct null', s.five_pct, null);
eq('week_pct null', s.week_pct, null);
eq('session_id', s.session_id, 'sess-x');

console.log('Case 3 - malformed stdin (must not crash):');
try { run('not json at all'); ok('survived malformed input'); }
catch (e) { bad('crashed on malformed input: ' + e.message); }

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
if (fail) { console.log('SOME FAILED'); process.exit(1); } else { console.log('ALL PASS'); }

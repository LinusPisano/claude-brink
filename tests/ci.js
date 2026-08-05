#!/usr/bin/env node
// Brink — CI test runner. Runs every suite as its own process and AGGREGATES.
//
// Why this exists (code review 2026-08-05, finding 6): package.json's "test" script is a
// single `&&` chain, so the first failing suite stops the run and every suite after it is
// silently never executed. That is tolerable locally (you re-run) but wrong for CI, where
// a flake in an early timing-dependent suite would hide a genuine regression in a later
// one. This runner executes ALL of them, reports per-suite status, and exits non-zero if
// any failed.
//
// It also discovers suites from disk rather than a hard-coded list, so a newly added
// tests/*.test.js is picked up automatically instead of quietly never running.
//
// Modes:
//   node tests/ci.js              deterministic suites (the CI gate)
//   node tests/ci.js console      console-spawning suites only (advisory in CI)
//
// CONSOLE_SUITES spawn real console windows and write keystrokes into them
// (AttachConsole/WriteConsoleInput). They pass on an interactive Windows desktop but are
// timing-dependent and depend on a real console host, so CI runs them as a separate,
// non-blocking job rather than gating every push on them.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONSOLE_SUITES = new Set(['dispatch.test.js', 'inject.test.js']);

const discovered = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
const mode = (process.argv[2] || '').toLowerCase() === 'console' ? 'console' : 'deterministic';

// run.js is the sensor/statusline smoke suite — not named *.test.js, so it is added by hand.
const suites = mode === 'console'
  ? discovered.filter((f) => CONSOLE_SUITES.has(f))
  : ['run.js', ...discovered.filter((f) => !CONSOLE_SUITES.has(f))];

if (!suites.length) {
  console.log(`No suites found for mode "${mode}" — refusing to report success on an empty run.`);
  process.exit(1);
}

console.log(`Brink test runner — mode: ${mode}, ${suites.length} suite(s), node ${process.version} on ${process.platform}\n`);

const results = [];
for (const suite of suites) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, suite)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300000,
    // Env is passed through UNMODIFIED on purpose. Each suite sets what it needs
    // (most pin BRINK_SILENT=1 per-spawn); notify.test.js in particular EXISTS to assert
    // the notifier's non-silent stderr fallback, so a BRINK_SILENT=1 injected here would
    // fail it for a reason that has nothing to do with the code under test.
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  // spawnSync sets .status to null when the child was killed by a signal or hit the
  // timeout — treat that as a failure, never as a pass.
  const passed = r.status === 0;
  results.push({ suite, passed, secs, status: r.status, out: (r.stdout || '') + (r.stderr || '') });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${secs}s  ${suite}`);
  if (!passed) {
    const reason = r.status === null ? `killed (timeout or signal${r.signal ? ' ' + r.signal : ''})` : `exit ${r.status}`;
    console.log(`      ${reason}`);
    for (const line of ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/)) {
      if (/FAIL|Error|error:/i.test(line) && line.trim()) console.log('      | ' + line.trim());
    }
  }
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} suites passed.`);
if (failed.length) {
  console.log('Failed: ' + failed.map((r) => r.suite).join(', '));
  process.exit(1);
}
process.exit(0);

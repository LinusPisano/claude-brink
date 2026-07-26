#!/usr/bin/env node
// Brink — handoff writer tests (Phase 5). Synthetic transcript, isolated temp dir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeHandoff, summarize, readTranscript } = require('../src/core/handoff');

let fail = 0;
const ok = (m) => console.log('  ok:   ' + m);
const bad = (m) => { console.log('  FAIL: ' + m); fail = 1; };
const truthy = (n, v) => (v ? ok(n) : bad(n + ' (was falsey)'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-h-'));
const tx = path.join(dir, 't.jsonl');
fs.writeFileSync(tx, [
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Refactor the auth module' }] } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'auth.ts' } }] } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }),
].join('\n'));

console.log('summarize:');
const s = summarize(readTranscript(tx));
truthy('last user task captured', s.lastUser.includes('Refactor the auth module'));
truthy('actions captured', s.actions.some((a) => a.includes('Edit')) && s.actions.some((a) => a.includes('npm test')));

console.log('writeHandoff:');
// outPath is an explicit, nested session dir the caller computes (core/paths in the
// real caller) — must NOT fall back to <cwd>/HANDOFF.md (the pre-hardening behavior).
const sessionDir = path.join(dir, 'sess', 'sub');
const outPath = path.join(sessionDir, 'HANDOFF.md');
const out = writeHandoff({ transcriptPath: tx, outPath, pct: 95, window: '5h', resetText: '14:30', isGit: true });
truthy('writes to the passed outPath', out === outPath && fs.existsSync(outPath));
truthy('parent dir created via mkdirSync recursive', fs.existsSync(sessionDir));

console.log('does not write to cwd (robust to a stray HANDOFF.md already sitting in cwd):');
// Asserting against the REAL process.cwd() is brittle - a leftover HANDOFF.md in
// whatever directory `npm test` happens to run from would make this fail for a reason
// unrelated to writeHandoff (this literally broke the live checkout at merge). Instead:
// chdir into a FRESH temp dir this test owns, seed it with a known stray HANDOFF.md,
// call writeHandoff pointed elsewhere, and prove the stray file survives byte-for-byte -
// genuinely proving writeHandoff only touches outPath, without depending on (or being
// tripped up by) whatever the real cwd contains.
const originalCwd = process.cwd();
const fakeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-h-cwd-'));
const strayPath = path.join(fakeCwd, 'HANDOFF.md');
const strayContent = '# STRAY - pre-existing, not written by this test run';
fs.writeFileSync(strayPath, strayContent);
try {
  process.chdir(fakeCwd);
  const outPath4 = path.join(dir, 'sess4', 'HANDOFF.md');
  const out4 = writeHandoff({ transcriptPath: tx, outPath: outPath4, pct: 42, window: '5h', resetText: '', isGit: true });
  truthy('writes to the passed outPath even while cwd holds a stray HANDOFF.md', out4 === outPath4 && fs.existsSync(outPath4));
  truthy('stray cwd HANDOFF.md left byte-for-byte untouched', fs.readFileSync(strayPath, 'utf8') === strayContent);
} finally {
  process.chdir(originalCwd);
  try { fs.rmSync(fakeCwd, { recursive: true, force: true }); } catch {}
}

const md = fs.readFileSync(out, 'utf8');
truthy('has the task', /Refactor the auth module/.test(md));
truthy('has reset time', /14:30/.test(md));
truthy('has percentage', /95%/.test(md));
truthy('NOT self-contradictory (no "Do NOT call tools")', !/Do NOT call/.test(md));
truthy('isGit:true -> git-note line present', /This IS a git repo/.test(md));

console.log('isGit:false drives the non-git note:');
const outPath2 = path.join(dir, 'sess2', 'HANDOFF.md');
const out2b = writeHandoff({ transcriptPath: tx, outPath: outPath2, pct: 60, window: '5h', resetText: '', isGit: false });
truthy('isGit:false -> not-a-git-repo note', /not a git repo - nothing to commit/.test(fs.readFileSync(out2b, 'utf8')));

console.log('missing transcript degrades gracefully:');
const outPath3 = path.join(dir, 'sess3', 'HANDOFF.md');
const out2 = writeHandoff({ transcriptPath: '/nonexistent', outPath: outPath3, pct: 99, window: 'weekly', resetText: '', isGit: false });
truthy('still writes a minimal HANDOFF', out2 && fs.existsSync(out2) && /could not read/.test(fs.readFileSync(out2, 'utf8')));

fs.rmSync(dir, { recursive: true, force: true });
console.log('');
if (fail) { console.log('SOME FAILED'); process.exit(1); } else { console.log('ALL PASS'); }

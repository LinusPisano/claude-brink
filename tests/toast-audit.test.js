#!/usr/bin/env node
// Brink — toast-content audit (pre-launch hardening Task 9). Static grep-guard: no
// notify() call site anywhere in the codebase may embed the user's verbatim
// prompt/last-message/transcript CONTENT in a desktop toast (a bare filename, pct
// number, window label, or count is fine — free-text conversation content is not).
// This mechanically re-checks every notify call site enumerated in the manual audit
// documented in .superpowers/sdd/task-9-report.md, so a future PR can't silently
// reintroduce a leak without this test catching it.
//
// Also asserts the in-place resume toast wording is honest: injector exit 0 only
// means the keystrokes were WRITTEN to the console buffer, not that Claude actually
// submitted them and continued the turn — the old wording ("resumed in place -
// continued your live session") overclaimed a confirmation Brink doesn't have.
const fs = require('fs');
const path = require('path');

let fail = 0;
const ok = (m) => console.log('  ok:   ' + m);
const bad = (m) => { console.log('  FAIL: ' + m); fail = 1; };

const SRC = path.join(__dirname, '..', 'src');

// --- 1. Resume-in-place toast wording is honest -----------------------------------
console.log('resume-dispatch.ps1 in-place toast wording:');
{
  const text = fs.readFileSync(path.join(SRC, 'resume-dispatch.ps1'), 'utf8');
  if (!/resumed in place - continued your live session/.test(text)) {
    ok('old overclaiming wording ("continued your live session") is gone');
  } else {
    bad('old overclaiming wording is still present');
  }
  if (/nudged your live session to continue/.test(text)) {
    ok('new wording present and does not claim confirmed continuation');
  } else {
    bad('expected honest "nudged your live session to continue" wording not found');
  }
}

// --- 2. No notify() call site embeds prompt/transcript/message content -----------
console.log('');
console.log('toast-content audit (grep-guard over every notify call site):');
const files = [
  'brink.js', 'cli.js', 'notify.js', 'notify.ps1', 'resume-dispatch.ps1',
  'resume-once.ps1', 'statusline-brink.js', path.join('core', 'reset.js'),
];
// Lines that hand a message to the notifier: notify(...), Notify(...), a spawn(...,
// [..., 'notify.js', <msg>]) call, or brink.js's once() pause/warn wrapper. Excludes
// the notify()/Notify() FUNCTION DEFINITIONS themselves (those just forward an
// already-built string, not conversation content).
const CALL_RE = /\bnotify\(|\bNotify\s|notify\.js'\)|^\s*once\(/;
const DEF_RE = /^(async )?function notify\(|^function Notify\(/;
// Identifiers that would mean a toast is carrying live conversation content rather
// than a generic status string (pct/window/count/path/label are fine).
const BLACKLIST = [/transcript/i, /continue_prompt/i, /user.?prompt/i, /last.?message/i,
  /hook\.prompt/i, /\.prompt\b/i, /message_content/i];

// --- Positive control: a broken/over-narrowed BLACKLIST would make the "no leaks
// found" result above pass vacuously (zero leaks because the regex never matches
// anything, not because the code is clean). Run the same CALL_RE/DEF_RE/BLACKLIST
// machinery against PLANTED synthetic call sites that genuinely embed conversation
// content, and assert they DO get caught — proving the regexes actually fire.
console.log('positive control (planted synthetic leaks must be caught by BLACKLIST):');
{
  const plantedLeaks = [
    "notify(`sending: ${userPrompt}`);",
    'Notify "Brink: continuing with $continue_prompt"',
    'notify(transcript.slice(-500));',
  ];
  for (const line of plantedLeaks) {
    const isCallSite = CALL_RE.test(line) && !DEF_RE.test(line.trim());
    const isCaught = isCallSite && BLACKLIST.some((re) => re.test(line));
    if (isCaught) ok(`planted leak correctly caught by BLACKLIST -> ${line.trim()}`);
    else bad(`planted leak NOT caught (isCallSite=${isCallSite}) -> ${line.trim()} — BLACKLIST regex is broken/vacuous`);
  }
}

let totalHits = 0;
for (const rel of files) {
  const p = path.join(SRC, rel);
  if (!fs.existsSync(p)) { bad(`expected audit target missing: ${rel}`); continue; }
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  const hits = lines.filter((l) => CALL_RE.test(l) && !DEF_RE.test(l.trim()));
  totalHits += hits.length;
  const leaks = hits.filter((l) => BLACKLIST.some((re) => re.test(l)));
  if (leaks.length) {
    for (const l of leaks) bad(`${rel}: notify call looks like it embeds prompt/transcript content -> ${l.trim()}`);
  } else {
    ok(`${rel}: ${hits.length} notify call site(s) scanned, none embed prompt/transcript content`);
  }
}
if (totalHits === 0) bad('audit found ZERO notify call sites across all target files — regex likely broken, re-check');

console.log('');
if (fail) { console.log('SOME FAILED'); process.exit(1); } else { console.log('ALL PASS'); }

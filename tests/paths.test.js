#!/usr/bin/env node
// Brink — Pre-launch hardening Task 1: src/core/paths.js (pure, no I/O, no deps).
// Verifies the <project-slug> encoding: abs project dir with drive-colon + path
// separators replaced by '-', e.g.
//   C:\Users\Dev\GitHub\my-app -> C--Users-Dev-GitHub-my-app
// plus sessionDir composition and sid sanitization.
const path = require('path');
const { projectSlug, sessionDir, handoffPath, resumeLogPath, ctxPath } = require('../src/core/paths');

let fail = 0;
const ok = (m) => console.log('  ok:   ' + m);
const bad = (m) => { console.log('  FAIL: ' + m); fail = 1; };
const eq = (n, a, e) => (JSON.stringify(a) === JSON.stringify(e)
  ? ok(`${n} = ${JSON.stringify(e)}`)
  : bad(`${n} expected ${JSON.stringify(e)} got ${JSON.stringify(a)}`));

console.log('projectSlug - Windows backslash path:');
eq('C:\\Users\\Dev\\GitHub\\my-app',
  projectSlug('C:\\Users\\Dev\\GitHub\\my-app'),
  'C--Users-Dev-GitHub-my-app');

console.log('projectSlug - git-bash path (/c/...):');
eq('/c/Users/Dev/GitHub/my-app',
  projectSlug('/c/Users/Dev/GitHub/my-app'),
  'C--Users-Dev-GitHub-my-app');

console.log('projectSlug - forward-slash Windows path:');
eq('C:/Users/Dev/GitHub/my-app',
  projectSlug('C:/Users/Dev/GitHub/my-app'),
  'C--Users-Dev-GitHub-my-app');

console.log('projectSlug - mixed forward+back slashes:');
eq('C:\\Users/Dev\\GitHub/my-app',
  projectSlug('C:\\Users/Dev\\GitHub/my-app'),
  'C--Users-Dev-GitHub-my-app');

console.log('projectSlug - trailing slash is ignored (Windows):');
eq('C:\\Users\\Dev\\GitHub\\my-app\\ === no-trailing-slash version',
  projectSlug('C:\\Users\\Dev\\GitHub\\my-app\\'),
  projectSlug('C:\\Users\\Dev\\GitHub\\my-app'));

console.log('projectSlug - trailing slash is ignored (git-bash):');
eq('/c/Users/Dev/GitHub/my-app/',
  projectSlug('/c/Users/Dev/GitHub/my-app/'),
  'C--Users-Dev-GitHub-my-app');

console.log('projectSlug - lowercase drive letter normalizes to uppercase:');
eq('c:\\Users\\Dev\\GitHub\\my-app',
  projectSlug('c:\\Users\\Dev\\GitHub\\my-app'),
  'C--Users-Dev-GitHub-my-app');

console.log('projectSlug - collision-safety: a literal trailing dash in the folder name must NOT collapse onto the dash-free name:');
{
  const withDash = projectSlug('C:\\Users\\Dev\\GitHub\\proj-');
  const noDash = projectSlug('C:\\Users\\Dev\\GitHub\\proj');
  if (withDash !== noDash) ok(`"proj-" (${withDash}) !== "proj" (${noDash}) — distinct slugs, no collision`);
  else bad(`COLLISION: "proj-" and "proj" both slug to "${withDash}"`);
}

console.log('projectSlug - empty/falsy cwd -> _no-project:');
eq('""', projectSlug(''), '_no-project');
eq('undefined', projectSlug(undefined), '_no-project');
eq('null', projectSlug(null), '_no-project');
eq('whitespace-only', projectSlug('   '), '_no-project');

console.log('sessionDir composition:');
eq('sessionDir(brinkDir, cwd, sid)',
  sessionDir('C:\\brink', 'C:\\Users\\Dev\\GitHub\\my-app', 'abc123'),
  path.join('C:\\brink', 'C--Users-Dev-GitHub-my-app', 'abc123'));

console.log('sid sanitization (sid.replace(/[^\\w.-]/g, "_")):');
eq('sid with space/slash/colon -> underscored',
  sessionDir('C:\\brink', 'C:\\p', 'weird sid/1:2'),
  path.join('C:\\brink', 'C--p', 'weird_sid_1_2'));
eq('sid with allowed chars (word, dot, dash) preserved',
  sessionDir('C:\\brink', 'C:\\p', 'sess-1.2_x'),
  path.join('C:\\brink', 'C--p', 'sess-1.2_x'));

console.log('handoffPath / resumeLogPath / ctxPath:');
eq('handoffPath',
  handoffPath('C:\\brink', 'C:\\p', 's1'),
  path.join(sessionDir('C:\\brink', 'C:\\p', 's1'), 'HANDOFF.md'));
eq('resumeLogPath',
  resumeLogPath('C:\\brink', 'C:\\p', 's1'),
  path.join(sessionDir('C:\\brink', 'C:\\p', 's1'), '.claude-resume.log'));
eq('ctxPath',
  ctxPath('C:\\brink', 'C:\\p', 's1'),
  path.join(sessionDir('C:\\brink', 'C:\\p', 's1'), 'resume-ctx.json'));

console.log('');
if (fail) { console.log('SOME FAILED'); process.exit(1); } else { console.log('ALL PASS'); }

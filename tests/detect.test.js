#!/usr/bin/env node
const { spawnSync } = require('child_process'); const os = require('os'); const path = require('path');
let fail = 0; const ok=(m)=>console.log('  ok:   '+m); const bad=(m)=>{console.log('  FAIL: '+m);fail=1;};
if (os.platform() !== 'win32') { console.log('  skip: detect test is win32-only'); process.exit(0); }
const r = spawnSync('powershell', ['-NoProfile','-ExecutionPolicy','Bypass','-File', path.join(__dirname,'detect-synthetic.ps1')], { encoding: 'utf8' });
process.stdout.write(r.stdout || '');
if (r.status === 0) ok('all synthetic terminal branches classified correctly'); else bad('synthetic detection failed: ' + (r.stderr||'').slice(0,300));
console.log(''); process.exit(fail ? 1 : 0);

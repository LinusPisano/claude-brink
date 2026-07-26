#!/usr/bin/env node
const { validateTarget, serializeCtx, parseCtx } = require('../src/core/target');
let fail = 0; const ok=(m)=>console.log('  ok:   '+m); const bad=(m)=>{console.log('  FAIL: '+m);fail=1;};
const eq=(n,a,e)=>(JSON.stringify(a)===JSON.stringify(e)?ok(`${n} = ${JSON.stringify(e)}`):bad(`${n} expected ${JSON.stringify(e)} got ${JSON.stringify(a)}`));

const rec = { SessionPid: 1234, SessionStartTime: '2026-07-10T09:00:00.000Z', Terminal: 'WindowsTerminal', Injectable: true, sid: 's1', proj: 'C:/p' };
eq('valid when pid+startTime match', validateTarget(rec, { pid: 1234, startTime: '2026-07-10T09:00:00.000Z' }), true);
eq('invalid on pid reuse (start-time differs)', validateTarget(rec, { pid: 1234, startTime: '2026-07-10T11:00:00.000Z' }), false);
eq('invalid when dead (live null)', validateTarget(rec, null), false);
eq('invalid on pid mismatch', validateTarget(rec, { pid: 9999, startTime: '2026-07-10T09:00:00.000Z' }), false);
eq('round-trips', parseCtx(serializeCtx(rec)), rec);
eq('parse garbage => null', parseCtx('{not json'), null);
console.log(''); if (fail) process.exit(1); else console.log('ALL PASS');

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {scheduleCpmRoute} from '../src/scheduleCpmRoute.mjs';
const bytes=await readFile(new URL('./fixtures/standalone-test.xer',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const json=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
const enabled=!!process.env.PVR_MPXJ_CLASSPATH;
const start=async t=>{
  const s=createServer((req,res)=>scheduleCpmRoute(req,res,json));
  s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>s.close());
  return `http://127.0.0.1:${s.address().port}`;
};
const headers={'content-type':'application/octet-stream','x-schedule-sha256':sha(bytes)};
test('the standalone schedule route reports an unconfigured runtime', {skip:enabled}, async t=>{
  const url=await start(t);
  assert.equal((await fetch(url,{method:'POST',headers,body:bytes})).status,503);
});
test('checksum and change input failures cannot produce a scenario', {skip:!enabled},async t=>{
  const url=await start(t);
  assert.equal((await fetch(url,{method:'POST',headers:{...headers,'x-schedule-sha256':'0'.repeat(64)},body:bytes})).status,422);
  assert.equal((await fetch(url,{method:'POST',headers:{...headers,'x-schedule-change-code':'WORK','x-schedule-change-hours':'-8'},body:bytes})).status,400);
});
test('actual worker route moves a synthetic finish and its milestone by one calendar day', {skip:!enabled,timeout:120_000}, async t=>{
  const url=await start(t);
  const result=await fetch(url,{method:'POST',headers:{...headers,'x-schedule-change-code':'WORK','x-schedule-change-hours':'8'},body:bytes});
  assert.equal(result.status,200);
  const data=await result.json();
  assert.equal(data.sourceSha256,sha(bytes));
  assert.equal(data.control.ok,true);
  assert.equal(data.simulation.calendarDays,1);
  assert.equal(data.simulation.before,'2027-02-02T17:00:00');
  assert.equal(data.simulation.after,'2027-02-03T17:00:00');
  assert.equal(data.simulation.milestones[0].code,'END');
});
test('even the same finish does not permit a scenario when stored activity dates drift', {skip:!enabled,timeout:120_000},async t=>{
  const url=await start(t);
  const altered=Buffer.from(bytes.toString('utf8').replace('Civil work\t0\t0\t16\t16\t2027-02-01 08:00','Civil work\t0\t0\t16\t16\t2027-02-01 09:00'));
  assert.notEqual(sha(altered),sha(bytes));
  const result=await fetch(url,{method:'POST',headers:{...headers,'x-schedule-sha256':sha(altered),'x-schedule-change-code':'WORK','x-schedule-change-hours':'8'},body:altered});
  assert.equal(result.status,200);
  const data=await result.json();
  assert.equal(data.control.ok,false);assert.equal(data.control.calculatedFinish,data.control.expectedFinish);
  assert.equal(data.control.dateMismatches,1);assert.equal(data.simulation,null);
});
const v2=(changes=[],fragments=[])=>({...headers,'x-schedule-changes':Buffer.from(JSON.stringify([changes,fragments])).toString('base64url')});
const startV2=async t=>{
  const s=createServer((req,res)=>scheduleCpmRoute(req,res,json,2));
  s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>s.close());
  return `http://127.0.0.1:${s.address().port}`;
};
test('combined change duration and an inserted activity move the same completion by two days', {skip:!enabled,timeout:120_000}, async t=>{
  const url=await startV2(t), edited=[['WORK',8]], created=[['PVR-NEW-1','WORK','END',8]];
  const result=await fetch(url,{method:'POST',headers:v2(edited,created),body:bytes});
  const out=await result.json();
  assert.equal(result.status,200,JSON.stringify(out));
  assert.equal(out.revision,2);
  assert.equal(out.control.ok,true);
  assert.equal(out.simulation.calendarDays,2);
  assert.equal(out.simulation.after,'2027-02-04T17:00:00');
  assert.deepEqual(out.simulation.changes,{WORK:8});
  assert.deepEqual(out.simulation.fragments,[{code:'PVR-NEW-1',from:'WORK',to:'END',hours:8}]);
  assert.equal(out.simulation.activityChanges.find(a=>a.code==='PVR-NEW-1').before,null);
  assert.deepEqual(out.simulation.drivingTies,[{from:'PVR-NEW-1',to:'END',type:'FS'},{from:'WORK',to:'PVR-NEW-1',type:'FS'}]);
  const baseline=await (await fetch(url,{method:'POST',headers:v2(),body:bytes})).json();
  assert.equal(baseline.control.calculatedFinish,'2027-02-02T17:00:00');
  assert.equal(baseline.simulation,null);
});
test('v2 rejects duplicate activities, invalid anchors, missing time precision, and reuse of an existing code', {skip:!enabled,timeout:120_000}, async t=>{
  const url=await startV2(t);
  for(const payload of [v2([['WORK',8],['WORK',8]]),v2([['WORK',.001]]),v2([], [['PVR-NEW-1','WORK','WORK',8]]),v2([], [['WORK','WORK','END',8]])]) {
    assert.equal((await fetch(url,{method:'POST',headers:payload,body:bytes})).status,400);
  }
  for(const payload of [v2([], [['PVR-NEW-1','END','WORK',8]]),v2([], [['PVR-NEW-1','WORK','END',8],['PVR-NEW-2','WORK','END',8]])]) {
    assert.equal((await fetch(url,{method:'POST',headers:payload,body:bytes})).status,422);
  }
});
test('differentiate same-day movement, calendar exceptions, and delay absorbed by float', {skip:!enabled,timeout:120_000}, async t=>{
  const url=await startV2(t);
  async function scenario(xer,code,hours) {
    const r=await fetch(url,{method:'POST',headers:{...v2([[code,hours]]),'x-schedule-sha256':sha(xer)},body:xer});
    assert.equal(r.status,200);
    const result=await r.json();
    assert.equal(result.control.ok,true,JSON.stringify(result));
    assert.ok(result.simulation);
    return result.simulation;
  }
  // Fewer than 24 elapsed hours can cross a date boundary: finish Tuesday at 17:00, restart Wednesday at 08:00.
  const minute=await scenario(bytes,'WORK',1/60);
  assert.equal(minute.after,'2027-02-03T08:01:00');
  assert.equal(minute.calendarDays,1);
  assert.ok(minute.elapsedHours<24);
  // Shift the two-day control to Thursday/Friday. Saturday and Sunday are excluded by the actual calendar.
  const friday=Buffer.from(bytes.toString().replaceAll('2027-02-02','2027-02-05').replaceAll('2027-02-01','2027-02-04'));
  const weekend=await scenario(friday,'WORK',8);
  assert.equal(weekend.after,'2027-02-08T17:00:00');
  assert.equal(weekend.calendarDays,3);
  const branch=Buffer.from(bytes.toString().replace('%T\tTASKPRED',[
    '%R\t103\t1\t10\t1\tTT_Task\tDT_FixedDrtn\tTK_NotStart\tFLOAT\tNon-driving work\t12\t12\t4\t4\t2027-02-01 08:00\t2027-02-01 12:00\t2027-02-01 08:00\t2027-02-01 12:00\t2027-02-01 08:00\t2027-02-01 12:00','%T\tTASKPRED'
  ].join('\n')).replace('%E','%R\t81\t102\t103\t1\t1\tPR_FS\t0\n%E'));
  const absorbed=await scenario(branch,'FLOAT',4);
  assert.equal(absorbed.calendarDays,0);
  assert.equal(absorbed.elapsedHours,0);
  assert.equal(absorbed.activityChanges.find(x=>x.code==='FLOAT').after.floatHours,8);
  assert.equal(absorbed.drivingTies.some(t=>t.from==='FLOAT'),false);
});

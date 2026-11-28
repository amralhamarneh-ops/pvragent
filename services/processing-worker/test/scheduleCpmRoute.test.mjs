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

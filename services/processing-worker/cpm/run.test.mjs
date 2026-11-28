import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractControlRows, verifyControl } from './run.mjs';
const start='2027-02-01T08:00:00', finish='2027-02-01T17:00:00';
const x = (pred='')=>Buffer.from([
 'ERMHDR\t23.12', '%T\tPROJECT','%F\tproj_id\tlast_recalc_date\tscd_end_date','%R\t1\t2027-02-01 08:00\t2027-02-01 17:00',
 '%T\tSCHEDOPTIONS','%F\tproj_id\tsched_retained_logic\tsched_progress_override\tsched_float_type','%R\t1\tY\tN\tFT_FF',
 '%T\tTASK','%F\ttask_id\tproj_id\ttask_code\ttask_type\tearly_start_date\tearly_end_date\ttotal_float_hr_cnt','%R\t20\t1\tWORK\tTT_Task\t2027-02-01 08:00\t2027-02-01 17:00\t0',
 '%T\tTASKPRED','%F\ttask_id\tpred_task_id\tpred_type',pred,'%E',''
].join('\n'));
const candidate=(overrides = {})=>({dataDate:start,finish,rows:new Map([['WORK',{start,finish,floatHours:0,...overrides}]])});
test('exact unchanged activity dates, numeric float, and finish pass',()=>{
 const c=verifyControl(extractControlRows(x()),candidate());
 assert.equal(c.ok,true); assert.equal(c.activities,1);
});
test('matching project finish alone does not pass',()=>{
 const ctl=verifyControl(extractControlRows(x()),candidate({finish:'2027-02-01T16:00:00',floatHours:20}));
 assert.equal(ctl.ok,false); assert.equal(ctl.dateMismatches,1); assert.equal(ctl.floatMismatches,1);
});
test('float differences smaller than one minute do not trigger a false mismatch',()=>{
 assert.equal(verifyControl(extractControlRows(x()),candidate({floatHours:0.01})).ok,true);
});
test('an unlinked activity ID or truncated input cannot be scheduled silently',()=>{
 assert.throws(()=>extractControlRows(x('%R\t20\t19\tPR_FS')),/Unresolved/);
 assert.throws(()=>extractControlRows(x().subarray(0,-6)),/full XER/);
});

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const executable = new URL('./ScheduleCpm.java', import.meta.url);
const MAX_XER_BYTES = 35 * 1024 * 1024;
const FLOAT_TOLERANCE_HOURS = 1/60;
const limitHours = 24 * 366 * 5;
const date = x => {
  const t=(x??'').trim().replace(' ','T');
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(t) ? t.length===16?t+':00':t : '';
};
const seconds = value => Date.parse(value+'Z')/1000;
const rowKey = r => r.task_code;
const num = x => x==='' || x==null || !Number.isFinite(Number(x)) ? null : Number(x);
const actualFinish = row => row.act_end_date || '';
const noChange = changed => Object.keys(changed).length===0;
const day = value => value.slice(0,10);
export function extractControlRows(bytes) {
  if (!bytes.length || bytes.length>MAX_XER_BYTES) throw new Error('XER size is outside the supported range.');
  const src=new TextDecoder('windows-1252').decode(bytes);
  if (!src.startsWith('ERMHDR\t')) throw new Error('Input is not an XER.');
  const out = { PROJECT: [], TASK: [], SCHEDOPTIONS: [], TASKPRED: [] };
  let table, fields, ended=false;
  for (const line of src.split(/\r\n|\n|\r/)) {
    const kind=line.slice(0,2);
    if (kind==='%E') {ended=true; break;}
    if (kind==='%T') { const name=line.split('\t')[1]; table=Object.hasOwn(out,name)?out[name]:null; fields=null; continue; }
    if (!table) continue;
    if (kind==='%F') {fields=line.split('\t').slice(1); continue;}
    if (kind==='%R') {
      if (!fields?.length) throw new Error('Missing XER table header.');
      const values=line.split('\t').slice(1); const r=Object.create(null);
      fields.forEach((k,i)=>{r[k]=(values[i]??'').trim();}); table.push(r);
    }
  }
  if (!ended || out.PROJECT.length!==1 || !out.TASK.length) throw new Error('The full XER must contain exactly one project and activity records.');
  const p=out.PROJECT[0], taskCodes=new Set(out.TASK.map(rowKey)), taskIds=new Set(out.TASK.map(r=>r.task_id));
  if (taskCodes.has('') || taskIds.has('') || taskCodes.size!==out.TASK.length || taskIds.size!==out.TASK.length || out.TASK.some(r=>r.proj_id && r.proj_id!==p.proj_id)) {
    throw new Error('The XER contains missing, duplicated or out-of-project activity identity.');
  }
  if(out.TASKPRED.some(r=>!taskIds.has(r.task_id) || !taskIds.has(r.pred_task_id) || !['PR_FS','PR_SS','PR_FF','PR_SF'].includes(r.pred_type))) throw new Error('Unresolved or unsupported XER relationships.');
  return out;
}
export function verifyControl(tables, calculated) {
  const {PROJECT:[p], TASK, SCHEDOPTIONS} = tables;
  const schedule=SCHEDOPTIONS.find(x=>x.proj_id===p.proj_id);
  const dataDate=date(p.last_recalc_date||p.sum_data_date);
  const expectedFinish=date(p.scd_end_date);
  const reasons=[];
  if (!schedule || schedule.sched_retained_logic !== 'Y' || schedule.sched_progress_override !== 'N' || schedule.sched_float_type !== 'FT_FF') reasons.push('The source must document retained logic and finish-float settings.');
  if (schedule?.sched_level_flag==='Y') reasons.push('The source uses resource levelling.');
  if (!dataDate || calculated.dataDate!==dataDate) reasons.push('Data date is missing or was not reproduced.');
  if (!expectedFinish || calculated.finish!==expectedFinish) reasons.push('Project completion was not reproduced.');
  let dateMismatches=0, floatMismatches=0, milestones=0, floatChecks=0, milestoneDateMismatches=0;
  for (const r of TASK) {
    const candidate=calculated.rows.get(rowKey(r));
    const expectedStart=date(r.act_start_date||r.early_start_date), expectedEnd=date(r.act_end_date||r.early_end_date);
    const taskDateBad=!expectedStart || !expectedEnd || candidate?.start!==expectedStart || candidate?.finish!==expectedEnd;
    if (taskDateBad) dateMismatches++;
    if (r.task_type==='TT_Mile' || r.task_type==='TT_FinMile') { milestones++; if(taskDateBad) milestoneDateMismatches++; }
    if (!actualFinish(r)) {
      floatChecks++;
      const expectedFloat=num(r.total_float_hr_cnt), float=candidate?.floatHours;
      if (expectedFloat==null || float==null || Math.abs(float-expectedFloat)>FLOAT_TOLERANCE_HOURS) floatMismatches++;
    }
  }
  if (calculated.rows.size!==TASK.length) reasons.push('The engine did not return exactly the source activity set.');
  if (dateMismatches) reasons.push('Some unchanged activity dates were not reproduced.');
  if (floatMismatches || !floatChecks) reasons.push('Some unchanged activity float was not reproduced, or no float records could be verified.');
  return {ok:reasons.length===0, reasons, expectedFinish, calculatedFinish:calculated.finish, dataDate,
    activities:TASK.length,dateMismatches,floatMismatches,floatChecks,milestones,milestoneDateMismatches};
}
function decode(stdout) {
  const rows = new Map();
  let dataDate, finish;
  for (const l of stdout.trimEnd().split('\n')) {
    const [kind,id,a,b,c,d] = l.split('\t');
    if (kind==='PROJECT' && !dataDate) {dataDate=date(id); finish=date(a);}
    else if (kind==='TASK') {
      const code=Buffer.from(id,'base64').toString('utf8');
      if (rows.has(code)) throw new Error('Duplicate calculation result.');
      rows.set(code, {start:date(a),finish:date(b),floatHours:num(c),critical:d==='true'});
    } else throw new Error('Unexpected schedule output.');
  }
  if (!dataDate || !finish || !rows.size) throw new Error('Incomplete calculation output.');
  return { dataDate, finish, rows };
}
export async function validateAndSimulate(bytes, changes = {}, { classpath = process.env.PVR_MPXJ_CLASSPATH, signal } = {}) {
  if (!classpath) throw new Error('The standalone CPM runtime is not configured.');
  if (!changes || typeof changes!=='object' || Array.isArray(changes)) throw new Error('Duration changes must map activity codes to added hours.');
  const tables=extractControlRows(bytes);
  const codes=new Map(tables.TASK.map(r=>[rowKey(r),r]));
  for (const [code,hours] of Object.entries(changes)) {
    const row=codes.get(code);
    if (!row || /[\t\r\n]/.test(code) || row.task_type!=='TT_Task' || actualFinish(row) || typeof hours!=='number' || !Number.isFinite(hours) || hours<=0 || hours>limitHours) {
      throw new Error('Each change must add a bounded number of hours to an unfinished task-dependent activity.');
    }
  }
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pvr-cpm-'));
  try {
    const input=path.join(dir,'input.xer'), delta=path.join(dir,'delta.tsv');
    await fs.writeFile(input,bytes,{mode:0o600});
    const run=async inputDeltas=>{
      await fs.writeFile(delta,Object.entries(inputDeltas).map(([code,hrs])=>code+'\t'+hrs+'\n').join(''),{mode:0o600});
      const { stdout }=await exec('java',['-Xmx512m','-cp',classpath,fileURLToPath(executable),input,delta],{signal,timeout:70_000,maxBuffer:30*1024*1024});
      return decode(stdout);
    };
    const before=await run({});
    const control=verifyControl(tables,before);
    const basis={algorithm:'Standalone MPXJ Primavera-style CPM',sourceSha256:createHash('sha256').update(bytes).digest('hex'),control};
    if (!control.ok || noChange(changes)) return {...basis, simulation:null};
    const after=await run(changes);
    if (after.dataDate!==before.dataDate || after.rows.size!==before.rows.size || [...before.rows.keys()].some(k=>!after.rows.has(k))) throw new Error('The model changed the data date or activity set.');
    const activityChanges=[...after.rows].flatMap(([code,r])=>{
      const old=before.rows.get(code);
      return !Object.hasOwn(changes,code) && r.start===old.start && r.finish===old.finish && r.floatHours===old.floatHours && r.critical===old.critical ? [] : [{code,before:old,after:r}];
    });
    const milestoneCodes = new Set(tables.TASK.filter(r=>r.task_type==='TT_Mile'||r.task_type==='TT_FinMile').map(rowKey));
    return {...basis,simulation:{before:before.finish,after:after.finish,calendarDays:(seconds(day(after.finish)+'T00:00:00')-seconds(day(before.finish)+'T00:00:00'))/86400,
      elapsedHours:(seconds(after.finish)-seconds(before.finish))/3600,changes,milestones:activityChanges.filter(r=>milestoneCodes.has(r.code)),activityChanges}};
  } finally {
    await fs.rm(dir,{recursive:true,force:true});
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  try {
    const [input,changeFile]=process.argv.slice(2);
    if (!input) throw new Error('Use: node run.mjs <input.xer> [changes.json]');
    const file=await fs.stat(input);
    if (!file.isFile() || !file.size || file.size>MAX_XER_BYTES) throw new Error('XER size is outside the supported range.');
    const changes=changeFile? JSON.parse(await fs.readFile(changeFile,'utf8')) : {};
    console.log(JSON.stringify(await validateAndSimulate(await fs.readFile(input),changes),null,2));
  } catch(error) { console.error(error.message); process.exitCode=1; }
}

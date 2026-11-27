import { D } from '@/lib/assessment/decimal';
import { calculateCpm, dayDiff, drivingPath } from '@/lib/assessment/cpmEngine';
import { compareProgrammeEvidence, validateRealProgramme } from '@/lib/assessment/realProgramme';
import { normaliseUnit } from '@/lib/assessment/costEngine';
import { parseCsvText, sha256Hex } from '@/lib/boq/readers';
import { mapLine } from '@/lib/mapping/realActivityMapping';
import { parseXerBytes } from '@/lib/mapping/xerParser';
import type { BrowserRehearsal, DemoFile } from './browserRehearsal';

export type ScheduleInputs = {baseline:DemoFile; productivity:DemoFile; benchmark?:DemoFile};
type ActivityRow = {code:string;name:string;kind:string;beforeStart:string;beforeFinish:string;afterStart:string;afterFinish:string;beforeDuration:number;afterDuration:number;beforeFloat:number;afterFloat:number;driving:boolean;shift:number;predecessors:string[]};
type ActivityMapping = {id:string;name:string;boqRef:string;qty:string;unit:string;code:string;activity:string;explanation:string;workDays:number|null;rate:string;rateBasis:string};
type Benchmark = {name:string;status:'matched'|'different'|'not_comparable';storedFinish:string;milestoneMatches:number;milestoneCount:number;checks:string[]};
export type RehearsalSchedule = {
  version:1; sample:boolean; baseline:string; productivity:string; dataDate:string; activityCount:number; linkCount:number; checkedCount:number;
  inputs:{name:string;sha256:string;role:string}[];
  mappings:ActivityMapping[]; rows:ActivityRow[]; blockers:string[]; warnings:string[];
  before:string; after:string; completionDelta:number|null; path:string[]; benchmark:Benchmark|null;
};
const MAX_XER = 2_000_000;
const MAX_ACTIVITIES = 120;
const iso = (s:string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s));
const code = (ref:string) => ref.trim().toUpperCase();
const positiveDecimal = (v:string) => /^\d+(\.\d{1,8})?$/.test(v) && v.length <= 24 && Number(v)>0;
const unit = (s:string) => normaliseUnit(s);
function readXer(f: DemoFile) {
  if (!/\.xer$/i.test(f.name) || !f.bytes.length || f.bytes.length > MAX_XER) throw new Error('Use an XER file up to 2 MB for this rehearsal.');
  const model = parseXerBytes(f.bytes, f.name);
  if (!model.activities.length || model.activities.length > MAX_ACTIVITIES || model.relationships.length > 800)
    throw new Error('Use a small, single-project XER with 1–120 activities and at most 800 links for this rehearsal.');
  return model;
}
function productivity(f: DemoFile) {
  if (!/\.csv$/i.test(f.name) || !f.bytes.length || f.bytes.length>50_000) throw new Error('Use a productivity CSV up to 50 KB.');
  const [head,...rows] = parseCsvText(new TextDecoder('utf-8',{fatal:true}).decode(f.bytes).replace(/^\uFEFF/,''));
  if (!head || head.map(x=>x.trim().toLowerCase()).join(',') !== 'item,unit,quantity per working day,source')
    throw new Error('Productivity CSV columns must be: Item, Unit, Quantity per working day, Source.');
  const out = new Map<string,{unit:string; rate:string; source:string}>();
  for (const row of rows) {
    if (!row.some(x=>x.trim())) continue;
    const [ref,u,rate,source] = row.map(x=>x.trim());
    if (row.length!==4 || !ref || !u || !positiveDecimal(rate??'') || !source || out.has(code(ref)))
      throw new Error('Use one row per BOQ item, a positive output per working day, and a stated productivity source.');
    out.set(code(ref),{unit:u,rate,source});
  }
  return out;
}

export async function calculateRehearsalSchedule(run:BrowserRehearsal, files:ScheduleInputs, sample=false):Promise<RehearsalSchedule> {
  const model = readXer(files.baseline);
  const rates = productivity(files.productivity);
  const checked = validateRealProgramme(model);
  const blockers = [...checked.reasons];
  if (model.activities.some(a=>!a.id) || new Set(model.activities.map(a=>a.id)).size!==model.activities.length) blockers.push('The XER must have unique, nonblank activity codes.');
  const boundaries = new Set(checked.network?.activities.filter(a=>a.type==='milestone_start').map(a=>a.id));
  const issues = checked.result?.issues.filter(i=>i.severity==='warning' && !(i.code==='OPEN_START' && i.activityId && boundaries.has(i.activityId)))??[];
  const warnings = [...(model.warnings??[]),...issues.map(i=>i.message)].slice(0,12);
  if (issues.length) blockers.push('Resolve the network warnings before simulating a date impact.');
  const elapsed = new Map<string,number>();
  const plannedBy = new Map<string,number>();
  const mappings:ActivityMapping[] = run.changes.map(c=>{
    const b=run.mappings.find(x=>x.id===c.id)?.proposal;
    const q=c.addedQty ?? '';
    const record:ActivityMapping={id:c.id,name:c.component,boqRef:b?.ref??'',qty:q,unit:c.unit,code:'',activity:'',explanation:'',workDays:null,rate:'',rateBasis:''};
    const hold = (s:string) => {blockers.push(`${c.component}: ${s}`);return {...record,explanation:s};};
    if (!b || c.conflict || c.ambiguity) return hold('No unique, reviewed BOQ or drawing basis.');
    if (c.change!=='added' || !positiveDecimal(q) || Number(c.omittedQty??'0')!==0)
      return hold('This rehearsal calculates additions only. Omissions, relocation and replacements need a planner-reviewed work model.');
    const tagged=model.activities.filter(a=>Object.entries(a.activityCodes??{}).some(([label,value])=>/^boq(?: item)?$/i.test(label.trim())&&code(value)===code(b.ref)));
    if (tagged.length>1) return hold('The BOQ item is linked to multiple activities; a planner must allocate the measured quantity.');
    // The drawing engine's CAD coordinate/handle string is evidence, not a programme location name.
    // Coordinate-only changes require an explicit XER BOQ cross-reference, not a guessed location.
    const location=c.location??'';
    const coordinateOnly=/^near\s*\(/i.test(location)||!location.trim();
    if (coordinateOnly && tagged.length!==1) return hold('A CAD coordinate is not a P6 work location. Add an explicit BOQ Item code to the correct execution activity.');
    const line={lineId:c.id,componentId:c.id,name:c.component,description:b.description,specification:'',
      location:coordinateOnly?'':location,discipline:'',workType:'',searchTerms:[],quantity:q,unit:c.unit,action:'add' as const,executes:true};
    const map=mapLine(line,model,tagged[0]?{activityTaskIds:[tagged[0].taskId??tagged[0].id]}:undefined);
    const a=map.allocations[0];
    // A code cross-reference still needs independently corroborating work terms and no contradictory scope.
    const taggedCandidate=tagged[0]?map.candidates.find(x=>x.activity.taskId===(tagged[0].taskId??tagged[0].id)):null;
    const unambiguous=tagged[0] ? map.state==='accepted' && taggedCandidate?.eligible && !taggedCandidate.review.length
      : map.state==='proposed' && map.confidence==='high';
    if (!unambiguous || map.allocations.length!==1 || !a)
      return hold(tagged[0]?'The tagged activity does not independently match the execution scope.':map.explanation || 'There is no unique high-confidence execution activity.');
    record.code=a.activityCode;record.activity=a.activityName;
    const rate=rates.get(code(b.ref));
    if (!rate || unit(rate.unit)!==unit(c.unit)) return hold('No matching-unit productivity rate was supplied for this BOQ item.');
    const amount=D(q).raw, output=D(rate.rate).raw;
    const workDays=Number((amount+output-BigInt(1))/output);
    if (!Number.isSafeInteger(workDays) || workDays<1 || workDays>365) return hold('Additional duration is outside the 1–365 working-day rehearsal range.');
    plannedBy.set(a.activityTaskId,(plannedBy.get(a.activityTaskId)??0)+1);
    elapsed.set(a.activityTaskId,(elapsed.get(a.activityTaskId)??0)+workDays);
    return {...record,workDays,rate:rate.rate,rateBasis:rate.source,explanation:tagged[0] ? `XER BOQ Item code ${b.ref}; ${taggedCandidate?.reasons.join('; ')}.` : map.explanation};
  });
  if ([...plannedBy.values()].some(n=>n>1)) blockers.push('Multiple changes hit the same activity. Confirm sequencing and shared crews before adding durations.');
  const base=checked.result;
  const network=checked.network;
  let scenario=!blockers.length && network && elapsed.size ? calculateCpm({...network,activities:network.activities.map(a=>({
    ...a,remainingDuration:a.remainingDuration+(elapsed.get(a.id)??0)
  }))}) : null;
  if (scenario && (!scenario.ok || !scenario.projectFinish)) {blockers.push('The revised network could not be calculated.');scenario=null;}
  const ending=scenario?.order.filter(id=>scenario?.activities[id].earlyFinish===scenario?.projectFinish)??[];
  const terminal=new Set((network?.relationships??[]).map(r=>r.from));
  const end=ending.find(id=>!terminal.has(id)&&network?.activities.find(a=>a.id===id)?.type==='milestone_finish')
    ?? ending.find(id=>!terminal.has(id)) ?? ending.at(-1);
  const pathIds=scenario&&end?drivingPath(scenario,end):[];
  const codeById=new Map(model.activities.map(a=>[a.taskId??a.id,a.id]));
  const rows:ActivityRow[]=model.activities.flatMap(a=>{
    const id=a.taskId??a.id, before=base?.activities[id], after=scenario?.activities[id];
    if (!before || !after) return [];
    const d=network?.activities.find(n=>n.id===id)?.remainingDuration??0;
    return [{code:a.id,name:a.name,kind:a.kind??'task',beforeStart:before.earlyStart,beforeFinish:before.earlyFinish,afterStart:after.earlyStart,afterFinish:after.earlyFinish,
      beforeDuration:d,afterDuration:d+(elapsed.get(id)??0),beforeFloat:before.totalFloat,afterFloat:after.totalFloat,driving:pathIds.includes(id),
      shift:dayDiff(before.earlyFinish,after.earlyFinish),
      predecessors:model.relationships.filter(r=>r.toTaskId===id).map(r=>`${r.from} ${r.type}${r.lagHours ? ` (${r.lagHours}h)` : ''}`)}];
  }).sort((a,b)=>a.beforeStart.localeCompare(b.beforeStart)||a.code.localeCompare(b.code));
  let benchmark:Benchmark|null=null;
  // Only now inspect the independent check file; it/its dates are never passed to mapping, durations or CPM.
  if (files.benchmark) {
    try {
      const ref=readXer(files.benchmark);
      const compare=compareProgrammeEvidence(model,ref);
      const m=rows.filter(r=>r.kind==='milestone_finish');
      const stored=new Map(compare.rhs.milestone.map(x=>[x.code,x.forecast.slice(0,10)]));
      const n=m.filter(r=>stored.get(r.code)===r.afterFinish).length;
      const checks=[...compare.checks,
        ...(compare.added.length || compare.removed || compare.existingLinkAdds || compare.existingLinkRemovals || compare.existingConstraintChanges
          ? ['Check file includes scope, logic or constraint differences outside this duration-only scenario.'] : []),
      ];
      const refFinish=compare.rhs.forecast.slice(0,10);
      benchmark={name:files.benchmark.name,status:checks.length || !scenario || !iso(refFinish) ? 'not_comparable' : n===m.length && refFinish===scenario.projectFinish ? 'matched':'different',
        storedFinish:iso(refFinish)?refFinish:'',milestoneMatches:n,milestoneCount:m.length,checks};
    } catch (e) { benchmark={name:files.benchmark.name,status:'not_comparable',storedFinish:'',milestoneMatches:0,milestoneCount:0,
      checks:[e instanceof Error ? e.message : 'Could not read the independent check file.']}; }
  }
  const before=base?.projectFinish && !checked.reasons.length ? base.projectFinish:'', after=scenario?.projectFinish??'';
  const inputs=await Promise.all([{f:files.baseline,role:'Pre-change XER'},{f:files.productivity,role:'Productivity basis'},
    ...(files.benchmark?[{f:files.benchmark,role:'Impacted XER · comparison only'}]:[])].map(async ({f,role})=>({name:f.name,role,sha256:await sha256Hex(f.bytes)})));
  return {version:1,sample,baseline:files.baseline.name,productivity:files.productivity.name,dataDate:model.dataDate,activityCount:model.activities.length,
    linkCount:model.relationships.length,checkedCount:checked.compared,mappings,rows,blockers:blockers.slice(0,24),warnings,before,after,
    completionDelta:before && after ? dayDiff(before,after) : null,path:pathIds.map(id=>codeById.get(id)??id),benchmark,inputs};
}

export function isRehearsalSchedule(v:unknown): v is RehearsalSchedule {
  if (!v || typeof v!=='object') return false;
  const s=v as RehearsalSchedule;
  const strings=(a:unknown):a is string[]=>Array.isArray(a)&&a.every(x=>typeof x==='string');
  const numbers=(a:unknown[])=>a.every(x=>typeof x==='number'&&Number.isSafeInteger(x));
  const texts=(a:unknown[])=>a.every(x=>typeof x==='string');
  const b=s.benchmark;
  return s.version===1&&typeof s.sample==='boolean'&&texts([s.baseline,s.productivity,s.dataDate,s.before,s.after])
   &&[s.before,s.after].every(d=>d===''||iso(d))
   &&numbers([s.activityCount,s.linkCount,s.checkedCount])&&(s.completionDelta===null||numbers([s.completionDelta]))
   &&strings(s.path)&&strings(s.blockers)&&strings(s.warnings)
   &&Array.isArray(s.rows)&&s.rows.length<=MAX_ACTIVITIES&&s.rows.every(r=>r&&texts([r.name,r.kind,r.code])&&
      [r.beforeStart,r.beforeFinish,r.afterStart,r.afterFinish].every(iso)&&numbers([r.beforeFloat,r.afterFloat,r.beforeDuration,r.afterDuration,r.shift])&&
      typeof r.driving==='boolean'&&strings(r.predecessors))
   &&Array.isArray(s.mappings)&&s.mappings.every(m=>m&&texts([m.id,m.name,m.boqRef,m.qty,m.unit,m.code,m.activity,m.explanation,m.rate,m.rateBasis])&&
      (m.workDays===null||numbers([m.workDays])))
   &&Array.isArray(s.inputs)&&s.inputs.length>=2&&s.inputs.length<=3&&s.inputs.every(i=>i&&texts([i.name,i.role,i.sha256]))
   &&(b===null||!!b&&texts([b.name,b.storedFinish])&&['matched','different','not_comparable'].includes(b.status)&&
      numbers([b.milestoneMatches,b.milestoneCount])&&strings(b.checks));
}

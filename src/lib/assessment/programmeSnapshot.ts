import type { GanttDates } from './programmeGantt';
import type { ProgrammeScopeLine, ScopeDecision } from './programmeScope';

export const PROGRAMME_SNAPSHOT_KEY='__programmeSnapshotV1';
export type ProgrammeDelta={code:string;before:GanttDates|null;after:GanttDates};
export type ProgrammeResult={revision:2;scenarioBlocker?:string;sourceSha256:string;control:{ok:boolean;activities:number;dateMismatches:number;floatMismatches:number;milestones:number;milestoneDateMismatches:number;calculatedFinish:string;reasons:string[];examples?:{code:string;storedStart:string;storedFinish:string;recalculatedStart:string;recalculatedFinish:string}[]};simulation:null|{before:string;after:string;calendarDays:number;elapsedHours:number;activityChanges:ProgrammeDelta[];milestones:ProgrammeDelta[];movedActivities:number;changedMilestones:number;affectedActivities:number;drivingTieCount:number;drivingTies:{from:string;to:string;type:string}[]}};
export type ProgrammeReview={scopeKey:string;decisions:Record<string,ScopeDecision>};
export type ProgrammeSnapshot={version:1;docId:string;sha256:string;drawingKey:string;runAt:string;review:ProgrammeReview;result:ProgrammeResult};

const text=(v:unknown,n:number):v is string=>typeof v==='string'&&v.length<=n;
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const date=(v:unknown)=>text(v,30)&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)&&Number.isFinite(Date.parse(v.endsWith('Z')?v:v+'Z'));
const count=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v);
const digest=(v:unknown)=>text(v,64)&&/^[a-f0-9]{64}$/.test(v);
const scheduleDates=(v:unknown)=>record(v)&&date(v.start)&&date(v.finish);
const row=(v:unknown)=>record(v)&&text(v.code,150)&&(v.before===null||scheduleDates(v.before))&&scheduleDates(v.after);
export function programmeScopeKey(scope:ProgrammeScopeLine[]) {
  // Cost citation alone does not change scheduling logic. Scope, quantities and mapping do.
  return JSON.stringify(scope.map(({boqSource:_cost,split,...line})=>[line,Object.entries(split??{}).sort()])
    .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
export function readProgrammeReview(v:unknown):ProgrammeReview|null {
  if(!record(v)||!text(v.scopeKey,100_000)||!v.scopeKey||!record(v.decisions)||Object.keys(v.decisions).length>300) return null;
  if(!Object.entries(v.decisions).every(([id,d])=>text(id,2000)&&record(d)&&
    (d.treatment==='include'||d.treatment==='exclude')&&text(d.rate,40)&&text(d.basis,300)&&
    (d.predecessor===undefined||text(d.predecessor,100))&&(d.successor===undefined||text(d.successor,100)))) return null;
  return v as ProgrammeReview;
}
export function readProgrammeSnapshot(raw:unknown):ProgrammeSnapshot|null {
  if(!text(raw,400_000))return null;
  try {
    const v=JSON.parse(raw);
    if(!record(v)||v.version!==1||!text(v.docId,160)||!v.docId||!digest(v.sha256)||!digest(v.drawingKey)||!date(v.runAt)||!readProgrammeReview(v.review))return null;
    const r=v.result;
    if(!record(r)||r.revision!==2||r.sourceSha256!==v.sha256||!record(r.control)||r.control.ok!==true||!Array.isArray(r.control.reasons)||!date(r.control.calculatedFinish)||
       !['activities','dateMismatches','floatMismatches','milestones','milestoneDateMismatches'].every(k=>count((r.control as Record<string,unknown>)[k])))return null;
    const sim=r.simulation;
    if(!record(sim)||!date(sim.before)||!date(sim.after)||!number(sim.calendarDays)||!number(sim.elapsedHours)||
       !['movedActivities','changedMilestones','affectedActivities','drivingTieCount'].every(k=>count(sim[k]))||
       !Array.isArray(sim.activityChanges)||sim.activityChanges.length>150||!sim.activityChanges.every(row)||
       !Array.isArray(sim.milestones)||sim.milestones.length>80||!sim.milestones.every(row)||
       !Array.isArray(sim.drivingTies)||sim.drivingTies.length>120||!sim.drivingTies.every(t=>record(t)&&text(t.from,150)&&text(t.to,150)&&text(t.type,20)))return null;
    return v as unknown as ProgrammeSnapshot;
  } catch { return null; }
}

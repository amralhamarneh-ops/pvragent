'use client';

import {useEffect,useMemo,useRef,useState,useId} from 'react';
import ProgrammeGantt from './ProgrammeGantt';
import {getAccessToken} from '@/lib/supabase/client';
import {anchorKey,reviewProgrammeScope,type ProgrammeScopeLine,type ScopeDecision,type ReviewedChange,type ReviewedFragment} from '@/lib/assessment/programmeScope';
import type {LoadedSchedule} from '@/lib/mapping/scheduleLoader';
import type {GanttDates,GanttRow} from '@/lib/assessment/programmeGantt';
import type {ScheduleActivity} from '@/lib/mapping/types';
import type {ProgrammeWhatIf} from '@/lib/pvr/finalForm';

type Delta={code:string;before:GanttDates|null;after:GanttDates};
type Result={revision:2;scenarioBlocker?:string;sourceSha256:string;control:{ok:boolean;activities:number;dateMismatches:number;floatMismatches:number;milestones:number;milestoneDateMismatches:number;calculatedFinish:string;reasons:string[];examples?:{code:string;storedStart:string;storedFinish:string;recalculatedStart:string;recalculatedFinish:string}[]};simulation:null|{before:string;after:string;calendarDays:number;elapsedHours:number;activityChanges:Delta[];milestones:Delta[];movedActivities:number;changedMilestones:number;affectedActivities:number;drivingTieCount:number;drivingTies:{from:string;to:string;type:string}[]}};
const milestone=(a?:ScheduleActivity)=>Boolean(a && ['milestone_start','milestone_finish'].includes(a.kind??''));
const dates=(a?:ScheduleActivity):GanttDates|undefined=>a?{start:a.actualStart||a.earlyStart||a.start,finish:a.actualFinish||a.earlyFinish||a.finish,floatHours:a.totalFloatHours}:undefined;
const byFinish=(a:GanttRow,b:GanttRow)=>(b.before?.finish||'').localeCompare(a.before?.finish||'');
const fmt=(value:string)=>value?.replace('T',' ').slice(0,16)||'Not available';
const signed=(value:number)=>`${value>0?'+':''}${Number(value.toFixed(2))}`;
const empty:ScopeDecision={treatment:'include',rate:'',basis:''};

export default function StandaloneProgrammePanel({caseId,source,reference,scope,onScenario,verifyDrawings}:{caseId:string;source:LoadedSchedule;reference?:LoadedSchedule;scope:ProgrammeScopeLine[];verifyDrawings?:()=>Promise<boolean>;onScenario?:(v:ProgrammeWhatIf|null)=>void}) {
  const [runResult,setRunResult]=useState<{input:string;result:Result}|null>(null);
  const [decisions,setDecisions]=useState<Record<string,ScopeDecision>>({});
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const running=useRef<AbortController|null>(null);
  const scopeKey=JSON.stringify(scope);
  // A changed drawing/mapping/valuation must be reviewed again, even if the activity codes did not change.
  const [reviewedKey,setReviewedKey]=useState(scopeKey);
  const activeDecisions=reviewedKey===scopeKey?decisions:{};
  const activities=useMemo(()=>new Map(source.model.activities.map(a=>[a.id,a])),[source]);
  const listId=useId();
  const anchors=useMemo(()=>{
    const links=new Map<string,Set<string>>();
    for(const rel of source.model.relationships) {
      if(rel.resolved===false||rel.type!=='FS'||rel.lagHours!==0)continue;
      const prev=activities.get(rel.from),next=activities.get(rel.to);
      if(!prev||!next||!prev.kind||!next.kind||prev.actualFinish||next.actualStart||
        !['task','milestone_start','milestone_finish'].includes(prev.kind)||!['task','milestone_finish'].includes(next.kind)||next.status!=='not_started')continue;
      const dest=links.get(prev.id)??new Set<string>();dest.add(next.id);links.set(prev.id,dest);
    }
    const keys=new Set([...links].flatMap(([from,to])=>[...to].map(dest=>anchorKey({from,to:dest}))));
    return {links,keys};
  },[activities,source]);
  const review=reviewProgrammeScope(scope,activeDecisions,anchors.keys);
  const input=JSON.stringify([scopeKey,activeDecisions]);
  const result=runResult?.input===input?runResult.result:null;
  useEffect(()=>()=>running.current?.abort(),[]);
  const localCase=caseId.startsWith('session-');
  const simulation=result?.simulation;
  useEffect(()=>{
    onScenario?.(simulation?{before:simulation.before,after:simulation.after,calendarDays:simulation.calendarDays,input:source.fileName,sourceSha256:source.sha256,elapsedHours:simulation.elapsedHours,
      activity:[...review.changes,...review.fragments].map(x=>x.code).join(', '),
      scopeAudit:review.review.map(({line,result})=>({line:line.name,basis:activeDecisions[line.id]?.basis??'',
        outcome:'entries' in result?result.entries.map(x=>`${x.quantity} ${line.unit} on ${x.code}: +${(x.minutes/60).toFixed(2)} working hours`).join('; ')+
          (result.anchor?` (new activity between ${result.anchor.from} and ${result.anchor.to})`:''):'Excluded from this scenario'}))}:null);
    return ()=>onScenario?.(null);
  },[simulation,input,source.fileName,onScenario]); // An input change clears the result and export immediately.
  const rows=useMemo<GanttRow[]>(()=>{
    if(simulation) {
      const selected=new Set([...review.changes,...review.fragments].map(c=>c.code));
      const drives=new Set(simulation.drivingTies.flatMap(t=>[t.from,t.to]));
      const newNames=new Map(scope.filter(s=>s.newCode).map(s=>[s.newCode,s.name]));
      return simulation.activityChanges.map(d=>({code:d.code,name:activities.get(d.code)?.name||newNames.get(d.code)||d.code,milestone:milestone(activities.get(d.code)),before:d.before??undefined,after:d.after,driving:drives.has(d.code)}))
        .sort((a,b)=>Number(b.milestone)-Number(a.milestone)||Number(selected.has(b.code))-Number(selected.has(a.code))||byFinish(a,b));
    }
    return [...activities.values()].map(a=>({code:a.id,name:a.name,milestone:milestone(a),before:dates(a)})).sort((a,b)=>Number(b.milestone)-Number(a.milestone)||byFinish(a,b));
  },[activities,simulation,input]);
  const comparisonRows=useMemo<GanttRow[]>(()=>{
    if(!reference)return [];
    const ref=new Map(reference.model.activities.map(a=>[a.id,a]));
    return [...activities.values()].filter(a=>ref.has(a.id)).map(a=>({code:a.id,name:a.name,milestone:milestone(a),before:dates(a),after:dates(ref.get(a.id))})).sort((a,b)=>Number(b.milestone)-Number(a.milestone)||byFinish(a,b));
  },[activities,reference]);
  function edit(id:string,patch:Partial<ScopeDecision>) {
    setReviewedKey(scopeKey);setDecisions({...activeDecisions,[id]:{...empty,...(Object.hasOwn(activeDecisions,id)?activeDecisions[id]:{}),...patch}});setError('');
  }
  async function run(changes:ReviewedChange[],fragments:ReviewedFragment[]=[]) {
    if(localCase||running.current)return;
    const c=new AbortController();running.current=c;setBusy(true);setError('');setRunResult(null);
    try {
      if((changes.length+fragments.length) && verifyDrawings && !(await verifyDrawings()))throw new Error('The drawing revisions could not be verified. Process the current drawing pair before recalculating.');
      const token=await getAccessToken();
      if(!token)throw new Error('Sign in to calculate a private PVR programme.');
      const r=await fetch(`/api/boq-cases/${encodeURIComponent(caseId)}/programme-simulation`,{
        method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
        body:JSON.stringify({docId:source.docId,sha256:source.sha256,changes,fragments}),signal:c.signal
      });
      const data=await r.json();
      if(!r.ok || data.revision!==2 || data.sourceSha256!==source.sha256 || !data.control)throw new Error(data.error||'The calculation did not return a verified result.');
      if(!c.signal.aborted)setRunResult({input,result:data as Result});
    } catch(e) {if(!c.signal.aborted)setError(e instanceof Error?e.message:'The calculation did not finish.');}
    finally {if(running.current===c)running.current=null;if(!c.signal.aborted)setBusy(false);}
  }
  return <div className="space-y-4 rounded-lg border border-border bg-muted/20 p-3 sm:p-4">
    <div><h4 className="font-semibold">Programme and time impact</h4><p className="text-sm text-muted-foreground">Follow the measured drawing changes into the programme. The tool checks the original XER, applies the reviewed durations together and recalculates the existing calendar and logic. No native P6 is used.</p></div>
    <section aria-label="Review schedule inputs" className="space-y-2">
      <h5 className="font-semibold text-sm">1. Review the drawing changes and their time basis</h5>
      {!scope.length ? <p className="text-sm">Process the drawings and confirm the execution activity mapping when available. You can still preview and check the unchanged programme below.</p> :
        <div className="space-y-2">{review.review.map(({line,result:r},i)=>{
          const d=Object.hasOwn(activeDecisions,line.id)?activeDecisions[line.id]:empty;
          return <fieldset key={line.id} disabled={busy} className="space-y-2 rounded border border-border bg-card p-3">
            <legend className="px-1 text-sm font-semibold">{i+1}. {line.name}</legend>
            <p className="text-xs text-muted-foreground">{line.quantity?`${line.quantity} ${line.unit} from drawings`:'No verified drawing quantity'}{line.drawingSource?` · ${line.drawingSource}`:''}</p>
            <p className="text-xs text-muted-foreground">{line.boqSource||'No verified BOQ match for this line'} · {line.activityCodes.join(', ')||(line.newCode?`Proposed activity ${line.newCode}`:'No confirmed eligible activity')}</p>
            <div className="grid gap-2 md:grid-cols-[1fr_1fr_2fr]">
              <label className="text-xs">Treatment<select className="block w-full rounded border border-input bg-card p-2" value={d.treatment} onChange={e=>edit(line.id,{treatment:e.target.value==='exclude'?'exclude':'include',basis:''})}><option value="include">Include measured work</option><option value="exclude">Exclude from this scenario</option></select></label>
              {d.treatment==='include'&&<label className="text-xs">Productivity ({line.unit||'quantity'} / working hour)<input type="text" inputMode="decimal" maxLength={40} className="block w-full rounded border border-input bg-card p-2" value={d.rate} onChange={e=>edit(line.id,{rate:e.target.value})} /></label>}
              <label className="text-xs">{d.treatment==='include'?'Productivity source / crew basis':'Reason for exclusion'}<input type="text" maxLength={300} className="block w-full rounded border border-input bg-card p-2" value={d.basis} onChange={e=>edit(line.id,{basis:e.target.value})} /></label>
            </div>
            {line.newCode&&d.treatment==='include'&&<div className="space-y-1">
              <p className="text-xs">Add the new work between two activities that already have a zero-lag finish-to-start link. The original link stays, and the new work uses the successor’s calendar.</p>
              <label className="block text-xs">Predecessor activity code<input list={listId} type="text" className="ml-2 rounded border border-input bg-card px-2 py-1" value={d.predecessor??''} onChange={e=>edit(line.id,{predecessor:e.target.value,successor:''})}/></label>
              <label className="block text-xs">Unstarted successor<select className="ml-2 max-w-full rounded border border-input bg-card px-2 py-1" value={d.successor??''} onChange={e=>edit(line.id,{successor:e.target.value})}>
                <option value="">Select linked activity</option>{[...(anchors.links.get(d.predecessor??'')??[])].map(code=><option key={code}>{code}</option>)}</select></label>
              {d.successor&&<p className="text-xs">Calendar: {activities.get(d.successor)?.calendarName||'Successor’s effective calendar'}</p>}
            </div>}
            <p className="text-xs">{'error' in r?r.error:'excluded' in r?'Explicitly excluded. This scenario does not cover the full PVR.':r.entries.map(e=>`${e.quantity} ÷ ${d.rate} = ${(e.minutes/60).toFixed(2)} working hours on ${e.code}`).join(' · ')+' (rounded up to a minute).'}</p>
          </fieldset>;
        })}</div>}
      {scope.some(line=>line.newCode)&&<datalist id={listId}>{[...anchors.links.keys()].slice(0,1000).map(code=><option value={code} key={code}>{activities.get(code)?.name}</option>)}</datalist>}
      {review.changes.length>0&&<p className="text-sm"><strong>Combined changes (hours on the same activity are added):</strong> {review.changes.map(c=>`${c.code} +${c.hours.toFixed(2)} h`).join(' · ')}</p>}
    </section>
    <section aria-label="Calculate programme impact" className="space-y-2">
      <h5 className="font-semibold text-sm">2. Validate and calculate</h5>
      <div className="flex flex-wrap gap-2">
        <button disabled={busy||localCase} type="button" className="rounded border border-input px-3 py-2 text-sm disabled:opacity-50" onClick={()=>void run([])}>Validate unchanged XER</button>
        <button disabled={busy||localCase||!!review.error} type="button" className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" onClick={()=>void run(review.changes,review.fragments)}>Calculate impact scenario</button>
      </div>
      {localCase&&<p className="text-xs text-muted-foreground">Preview is available here. Save a signed-in private case to calculate impact.</p>}
      {scope.length>0&&review.error&&<p className="text-xs">{review.error}</p>}
      {busy&&<p role="status" className="text-sm">Checking the unchanged XER and recalculating the programme…</p>}
      {error&&<p role="alert" className="text-sm">{error}</p>}
      {result&&<div role="status" className="rounded border border-border bg-card p-3 text-sm">
        <p><strong>{result.control.ok?'Unchanged programme validated.':'Unchanged programme did not validate. No impact calculated.'}</strong> {result.control.activities.toLocaleString()} activities checked; {result.control.dateMismatches.toLocaleString()} date and {result.control.floatMismatches.toLocaleString()} float differences. {result.control.milestoneDateMismatches} of {result.control.milestones} milestone dates differed.</p>
        {result.scenarioBlocker&&<p className="font-medium">{result.scenarioBlocker} No impact forecast was accepted.</p>}
        {!!result.control.examples?.length&&<details><summary>Examples of source date differences</summary><ul className="mt-1 list-disc pl-5">{result.control.examples.map(e=><li key={e.code}>{e.code} · stored {fmt(e.storedStart)} to {fmt(e.storedFinish)} · recalculated {fmt(e.recalculatedStart)} to {fmt(e.recalculatedFinish)}</li>)}</ul></details>}
        {result.control.ok&&<p>Recalculated unchanged completion: {fmt(result.control.calculatedFinish)} (source programme clock).</p>}
        {result.control.reasons.length>0&&<ul className="list-disc pl-5">{result.control.reasons.map(r=><li key={r}>{r}</li>)}</ul>}
      </div>}
    </section>
    <section aria-label="Review programme results" className="space-y-2">
      <h5 className="font-semibold text-sm">3. Review the result</h5>
      {simulation&&<>
        <div className="grid gap-2 sm:grid-cols-3">
          {[['Pre-change completion',fmt(simulation.before)],['Simulated completion',fmt(simulation.after)],['Completion movement',`${signed(simulation.calendarDays)} calendar days · ${signed(simulation.elapsedHours)} elapsed hours`]].map(([label,value])=><div key={label} className="rounded border border-border bg-card p-3 text-sm"><p className="text-xs text-muted-foreground">{label}</p><strong>{value}</strong></div>)}
        </div>
        <p className="text-sm">{simulation.movedActivities} activities with moved dates. {review.exclusions>0?`${review.exclusions} identified changes excluded; partial-scope scenario.`:'All listed scope lines included in this scenario.'} It is not an approved delay or entitlement decision.</p>
        {simulation.milestones.length>0&&<details open className="rounded border border-border bg-card p-3 text-sm"><summary>Milestones affected ({simulation.changedMilestones})</summary><ul className="mt-2 list-disc pl-5">{simulation.milestones.map(m=><li key={m.code}>{m.code}: {fmt(m.before?.finish??'')} → {fmt(m.after.finish)}{m.before?.finish===m.after.finish?' (finish unchanged)':''}</li>)}</ul></details>}
        {simulation.drivingTies.length>0&&<details className="rounded border border-border bg-card p-3 text-sm"><summary>Driving links toward completion ({simulation.drivingTieCount})</summary>
          <p className="mt-1 text-xs">Engine-reported links, not a statement of delay responsibility. Showing {simulation.drivingTies.length} of {simulation.drivingTieCount}.</p>
          <ul className="list-disc pl-5">{simulation.drivingTies.map((t,i)=><li key={i}>{t.from} → {t.to} ({t.type})</li>)}</ul>
        </details>}
      </>}
      <ProgrammeGantt rows={rows} beforeLabel={simulation?'Recalculated pre-change dates':'Stored source dates'} afterLabel={simulation?'Simulated dates':undefined}
        description={simulation?`Only affected programme rows are shown here (${simulation.affectedActivities} affected)`:'Preview of the uploaded source programme'} />
      {comparisonRows.length>0&&<details className="rounded border border-border p-2"><summary className="text-sm">Stored reference Gantt (not part of the simulation)</summary>
        <ProgrammeGantt rows={comparisonRows} beforeLabel="Stored source dates" afterLabel="Stored reference dates" description="Matching activity codes from the uploaded files; comparison only" />
      </details>}
    </section>
  </div>;
}

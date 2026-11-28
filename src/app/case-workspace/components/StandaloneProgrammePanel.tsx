'use client';
import {useEffect,useMemo,useRef,useState} from 'react';
import ProgrammeGantt from './ProgrammeGantt';
import {getAccessToken} from '@/lib/supabase/client';
import type {LoadedSchedule} from '@/lib/mapping/scheduleLoader';
import type {GanttDates,GanttRow} from '@/lib/assessment/programmeGantt';
import type {ScheduleActivity} from '@/lib/mapping/types';

type Delta={code:string;before:GanttDates;after:GanttDates};
type Result={sourceSha256:string;control:{ok:boolean;activities:number;dateMismatches:number;floatMismatches:number;milestones:number;milestoneDateMismatches:number;calculatedFinish:string;reasons:string[]};simulation:null|{before:string;after:string;calendarDays:number;elapsedHours:number;activityChanges:Delta[];movedActivities:number}};
const milestone=(a?:ScheduleActivity)=>Boolean(a && ['milestone_start','milestone_finish'].includes(a.kind??''));
const dates=(a?:ScheduleActivity):GanttDates|undefined=>a?{start:a.actualStart||a.earlyStart||a.start,finish:a.actualFinish||a.earlyFinish||a.finish,floatHours:a.totalFloatHours}:undefined;
const byFinish=(a:GanttRow,b:GanttRow)=>(b.before?.finish||'').localeCompare(a.before?.finish||'');
export default function StandaloneProgrammePanel({caseId,source,reference,confirmedTaskIds}:{caseId:string;source:LoadedSchedule;reference?:LoadedSchedule;confirmedTaskIds:string[]}) {
  const [result,setResult]=useState<Result|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [code,setCode]=useState(''),[hours,setHours]=useState('');
  const running=useRef<AbortController|null>(null);
  useEffect(()=>()=>running.current?.abort(),[]);
  const localCase=caseId.startsWith('session-');
  const confirmed=new Set(confirmedTaskIds);
  const choices=source.model.activities.filter(a=>confirmed.has(a.taskId??a.id)&&a.kind==='task'&&!a.actualFinish);
  const ready=choices.some(a=>a.id===code)&&Number(hours)>0&&Number(hours)<=8760&&/^\d+(\.\d+)?$/.test(hours);
  const rows=useMemo<GanttRow[]>(()=>{
    const input=new Map(source.model.activities.map(a=>[a.id,a]));
    if(result?.simulation) {
      return result.simulation.activityChanges.map(d=>({code:d.code,name:input.get(d.code)?.name||d.code,milestone:milestone(input.get(d.code)),before:d.before,after:d.after}))
        .sort((a,b)=>Number(b.code===code)-Number(a.code===code)||Number(b.milestone)-Number(a.milestone)||byFinish(a,b));
    }
    const ref=new Map(reference?.model.activities.map(a=>[a.id,a]));
    return [...input.values()].map(a=>({code:a.id,name:a.name,milestone:milestone(a),before:dates(a),after:dates(ref.get(a.id))}))
      .sort((a,b)=>Number(b.code===code)-Number(a.code===code)||Number(b.milestone)-Number(a.milestone)||byFinish(a,b));
  },[code,reference,result,source]);
  async function run(simulate:boolean) {
    if(localCase || running.current || (simulate&&!ready))return;
    const c=new AbortController();running.current=c;setBusy(true);setError('');setResult(null);
    try {
      const token=await getAccessToken();
      const r=await fetch(`/api/boq-cases/${encodeURIComponent(caseId)}/programme-simulation`,{
        method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},
        body:JSON.stringify({docId:source.docId,sha256:source.sha256,...(simulate?{activity:code,addedHours:Number(hours)}:{})}),signal:c.signal
      });
      const data=await r.json();
      if(!r.ok || data.sourceSha256!==source.sha256 || !data.control)throw new Error(data.error||'The standalone calculation did not return a verified result.');
      setResult(data as Result);
    } catch(e) {if(!c.signal.aborted)setError(e instanceof Error?e.message:'The calculation did not finish.');}
    finally {if(running.current===c)running.current=null;if(!c.signal.aborted)setBusy(false);}
  }
  const simulation=result?.simulation;
  return <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
    <div><h4 className="font-semibold text-sm">Standalone programme simulation</h4><p className="text-xs text-muted-foreground">Recalculates the uploaded XER without Primavera P6. Checks the unchanged programme before testing reviewed activity hours.</p></div>
    <ProgrammeGantt rows={rows} beforeLabel={simulation?'Recalculated before change':'Stored source dates'} afterLabel={simulation?'Simulated dates':reference?'Stored reference dates':undefined}
      description={simulation?'Change scenario, not a certified PVR delay':reference?'Uploaded schedule comparison, not a calculated delay':'Preview of the uploaded source programme'}/>
    <div className="flex flex-wrap items-end gap-2 text-sm">
      <button disabled={busy||localCase} type="button" className="rounded border border-input px-3 py-2" onClick={()=>void run(false)}>Validate unchanged XER</button>
      {choices.length>0&&<><label className="text-xs">Confirmed execution activity<select disabled={busy} className="block rounded border border-input bg-card p-2" value={code} onChange={e=>{setCode(e.target.value);setResult(null);}}><option value="">Select activity</option>{choices.map(a=><option key={a.taskId??a.id} value={a.id}>{a.id}: {a.name}</option>)}</select></label>
        <label className="text-xs">Added working hours<input disabled={busy} type="number" min="0.1" max="8760" step="any" className="block w-28 rounded border border-input bg-card p-2" value={hours} onChange={e=>{setHours(e.target.value);setResult(null);}}/></label>
        <button disabled={busy||localCase||!ready} type="button" className="rounded border border-input px-3 py-2" onClick={()=>void run(true)}>Calculate impact scenario</button></>}
    </div>
    {localCase&&<p className="text-xs text-muted-foreground">The Gantt can be viewed here. Save a signed-in private case to run the standalone engine.</p>}
    {!choices.length&&<p className="text-xs text-muted-foreground">Confirm an activity mapping to simulate a duration change.</p>}
    {busy&&<p role="status" className="text-sm">Recalculating programme…</p>}
    {error&&<p role="status" className="text-sm">{error}</p>}
    {result&&<div role="status" className="space-y-1 text-sm">
      <p><strong>{result.control.ok?'Control passed.':'Control did not pass. No impact forecast.'}</strong> {result.control.activities.toLocaleString()} activities checked; {result.control.dateMismatches.toLocaleString()} date and {result.control.floatMismatches.toLocaleString()} float differences. {result.control.milestoneDateMismatches} of {result.control.milestones} milestone dates differed.</p>
      {result.control.reasons.length>0&&<ul className="list-disc pl-5">{result.control.reasons.map(r=><li key={r}>{r}</li>)}</ul>}
      {simulation&&<p>Completion: {simulation.before.replace('T',' ')} → <strong>{simulation.after.replace('T',' ')}</strong> ({simulation.calendarDays>0?'+':''}{simulation.calendarDays} calendar {Math.abs(simulation.calendarDays)===1?'day':'days'}; {simulation.movedActivities} activities with dates moved). This is a duration scenario, not a certified PVR delay.</p>}
    </div>}
  </div>;
}

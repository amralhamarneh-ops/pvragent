'use client';

import {useEffect,useMemo,useState} from 'react';
import {compareProgrammeEvidence,describeProgramme,testDurationChange,validateRealProgramme} from '@/lib/assessment/realProgramme';
import FragmentReplayPanel from '@/app/pvr-demo/FragmentReplayPanel';
import {drivingPath} from '@/lib/assessment/cpmEngine';
import type {ProgrammeWhatIf} from '@/lib/pvr/finalForm';
import type {LoadedSchedule} from '@/lib/mapping/scheduleLoader';

export function referenceOnlyProgramme(s: Pick<LoadedSchedule,'subrole'|'fileName'>) {
  const name = s.fileName.replace(/_/g,' ');
  return s.subrole === 'reference' ||
    (!/\b(?:pre|before)[ -]?impact\b/i.test(name) && /\b(?:impacted|impact|post[- ]?impact)\b/i.test(name));
}

export default function RealProgrammePanel({source,references,confirmedTaskIds,onScenario}: {
  source:LoadedSchedule; references:LoadedSchedule[]; confirmedTaskIds:string[]; onScenario?:(result:ProgrammeWhatIf|null)=>void;
}) {
  const [refId,setRefId]=useState('');
  const [taskId,setTaskId]=useState('');
  const [days,setDays]=useState('');
  const [run,setRun]=useState(false);
  const [validate,setValidate]=useState(false);
  const current=useMemo(()=>describeProgramme(source.model),[source]);
  const ref=references.find(r=>r.docId===refId);
  const evidence=useMemo(()=>ref ? compareProgrammeEvidence(source.model,ref.model) : null,[source,ref]);
  const checked=useMemo(()=>validate ? validateRealProgramme(source.model) : null,[source,validate]);
  const options=source.model.activities.filter(a=>confirmedTaskIds.includes(a.taskId??a.id) && a.kind==='task' && !a.actualFinish);
  const validSelection=options.some(a=>(a.taskId??a.id)===taskId);
  const scenario=useMemo(()=>run && checked && validSelection ? testDurationChange(checked,taskId,Number(days)) : null,[run,checked,validSelection,taskId,days]);
  useEffect(()=>{
    const activity=source.model.activities.find(a=>(a.taskId??a.id)===taskId)?.id;
    onScenario?.(scenario && activity ? {before:scenario.before,after:scenario.after,calendarDays:scenario.calendarDays,input:source.fileName,activity} : null);
    return ()=>onScenario?.(null);
  },[scenario,source,taskId,onScenario]);
  const endpoint=scenario && checked?.network?.activities.find(a=>a.type==='milestone_finish' && scenario.result.activities[a.id]?.earlyFinish===scenario.after);
  const path=endpoint && scenario ? drivingPath(scenario.result,endpoint.id) : [];
  const codes=path.map(id=>source.model.activities.find(a=>(a.taskId??a.id)===id)?.id??id);
  const horizon=evidence?.rhs.forecast.slice(0,10);
  const selectedActivity=options.find(a=>(a.taskId??a.id)===taskId);
  const directScenarioComparison = evidence && !evidence.added.length && !evidence.removed &&
    !evidence.checks.length && !evidence.existingLinkAdds && !evidence.existingLinkRemovals && !evidence.existingConstraintChanges &&
    evidence.existingDurationChanges.length === 1 && evidence.existingDurationChanges[0].code === selectedActivity?.id &&
    !!selectedActivity.hoursPerDay &&
    Number(evidence.existingDurationChanges[0].after)-Number(evidence.existingDurationChanges[0].before) === Number(days)*selectedActivity.hoursPerDay;
  return (
    <section aria-label="Real programme impact" className="rounded-lg border border-border bg-card p-5 space-y-3">
      <h3 className="font-semibold text-foreground">Real programme impact</h3>
      <p className="text-sm">Input: <strong>{source.fileName}</strong>. {current.activityCount.toLocaleString()} activities, {current.relationships.toLocaleString()} relationships{current.unresolvedRelationships ? ` (${current.unresolvedRelationships.toLocaleString()} excluded from logic)` : ''}. XER data date: {current.dataDate || 'not available'}. Stored forecast: {current.forecast || 'not available'}.</p>
      {Boolean(source.model.warnings?.length) && <details className="text-sm"><summary>XER import notices</summary><ul className="list-disc pl-5">{source.model.warnings?.map((w,i)=><li key={i}>{w}</li>)}</ul></details>}
      <div className="flex flex-wrap gap-3 items-center">
        <button type="button" className="rounded border border-input px-3 py-2 text-sm" onClick={()=>{setValidate(true);setRun(false);}} disabled={validate}>Check unchanged programme</button>
        {references.length>0 ? <label className="text-sm">Processed PVR XER (reference only) <select className="rounded border border-input bg-card px-2 py-1" value={refId} onChange={e=>setRefId(e.target.value)}>
          <option value="">Select the processed result</option>{references.map(r=><option key={r.docId} value={r.docId}>{r.fileName}</option>)}</select></label> : <p className="text-sm text-muted-foreground">Upload the processed XER as a Reference programme to compare it separately.</p>}
      </div>
      {checked && (checked.reasons.length ? <div role="status" className="rounded border border-warning/60 p-3 text-sm"><strong>No independently calculated delay.</strong> The unchanged programme is not validated.
        <ul className="list-disc pl-5">{checked.reasons.map(r=><li key={r}>{r}</li>)}</ul></div> :
        <div className="space-y-2 text-sm">
          <p>Unchanged programme reproduced {checked.compared} activity records at the available day-level precision.</p>
          {!options.length ? <p>Confirm a mapped execution activity before testing a duration change.</p> : <div className="flex flex-wrap gap-3 items-center">
            <label>Confirmed activity <select className="rounded border border-input bg-card px-2 py-1" value={taskId} onChange={e=>{setTaskId(e.target.value);setRun(false);}}>
              <option value="">Select activity</option>{options.map(a=><option key={a.taskId??a.id} value={a.taskId??a.id}>{a.id}: {a.name}</option>)}
            </select></label>
            <label>Additional working days <input type="number" min="1" max="3650" step="1" className="rounded border border-input bg-card px-2 py-1 w-24" value={days} onChange={e=>{setDays(e.target.value);setRun(false);}} /></label>
            <button type="button" className="rounded border border-input px-3 py-2" disabled={!validSelection || !Number.isSafeInteger(Number(days)) || Number(days)<1 || Number(days)>3650} onClick={()=>setRun(true)}>Calculate duration scenario</button>
          </div>}
          {scenario && <p role="status">What-if forecast: <strong>{scenario.after}</strong>, {scenario.calendarDays} calendar days after {scenario.before}.{codes.length ? ` Driving path to finish: ${codes.join(' → ')}.` : ''}</p>}
          {run && !scenario && <p role="status">The duration scenario did not produce a reliable result.</p>}
        </div>)}
      {evidence && <div className="rounded border border-input p-3 text-sm space-y-2">
        <p>Processed reference: <strong>{evidence.rhs.forecast || 'forecast not available'}</strong> (data date {evidence.rhs.dataDate || 'not available'}). {evidence.added.length} activities only in the reference; {evidence.removed} only in the source.</p>
        {evidence.observedCalendarDays !== null && <p>Difference between stored forecasts: <strong>{evidence.observedCalendarDays>0 ? '+' : ''}{evidence.observedCalendarDays} calendar days</strong>. This is not a delay recalculated by the tool.</p>}
        <p>Changes among existing activities: {evidence.existingDurationChanges.length} with different durations, {evidence.existingConstraintChanges} with different constraints or expected finish overrides, and {evidence.existingLinkAdds} links added / {evidence.existingLinkRemovals} removed.</p>
        {evidence.changedSettingFields.length>0 && <details><summary>Changed project and scheduling settings ({evidence.changedSettingFields.length})</summary><p>{evidence.changedSettingFields.join(', ')}</p></details>}
        {evidence.checks.length>0 ? <><p className="font-semibold">Stored result only. Do not attribute the date difference to the variation from this pair.</p>
          <ul className="list-disc pl-5">{evidence.checks.map(c=><li key={c}>{c}</li>)}</ul></> :
          <p>{scenario && horizon && directScenarioComparison ? `Calculated finish ${scenario.after === horizon ? 'matches' : 'does not match'} the reference finish at day precision. Verify scope and logic separately.` : scenario ? 'The single-activity test does not reproduce the changes in this reference. Do not score it as a match.' : 'Reference loaded separately. No independently calculated result to score yet.'}</p>}
        {evidence.added.length>0 && <details><summary>Activities only in the reference</summary><ul className="list-disc pl-5">{evidence.added.slice(0,30).map(a=><li key={a.code}>{a.code}: {a.description}</li>)}</ul></details>}
        {(evidence.referenceTies.length>0 || evidence.referenceInternalTies.length>0) && <details><summary>Links involving reference-only activities</summary><ul className="list-disc pl-5">{[...evidence.referenceTies,...evidence.referenceInternalTies].slice(0,40).map((r,i)=><li key={i}>{r.from} → {r.to} ({r.type}{r.lagHours ? `, lag ${r.lagHours} h` : ''})</li>)}</ul></details>}
        {evidence.milestones.length>0 && <details><summary>Changed stored milestones ({evidence.milestones.length})</summary><ul className="list-disc pl-5">{evidence.milestones.slice(0,30).map(a=><li key={a.code}>{a.code}: {a.before} → {a.after} (float {a.floatBefore ?? 'unknown'} → {a.floatAfter ?? 'unknown'} hours)</li>)}</ul></details>}
      </div>}
      {ref && <FragmentReplayPanel key={ref.sha256} reference={ref} preChange={source} />}
    </section>
  );
}

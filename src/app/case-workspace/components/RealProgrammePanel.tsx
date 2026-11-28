'use client';

import {useMemo,useState} from 'react';
import {compareProgrammeEvidence,describeProgramme} from '@/lib/assessment/realProgramme';
import StandaloneProgrammePanel from './StandaloneProgrammePanel';
import type {ProgrammeScopeLine} from '@/lib/assessment/programmeScope';
import type {ProgrammeWhatIf} from '@/lib/pvr/finalForm';
import {isReferenceProgramme} from '@/lib/mapping/scheduleProvenance';
import type {LoadedSchedule} from '@/lib/mapping/scheduleLoader';

export function referenceOnlyProgramme(s: Pick<LoadedSchedule,'subrole'|'fileName'>) {
  return isReferenceProgramme(s.fileName,s.subrole);
}

export default function RealProgrammePanel({caseId,source,references,scope,onScenario,verifyDrawings}: {
  caseId:string; source:LoadedSchedule; references:LoadedSchedule[]; scope:ProgrammeScopeLine[]; verifyDrawings?:()=>Promise<boolean>;onScenario?:(result:ProgrammeWhatIf|null)=>void;
}) {
  const [refId,setRefId]=useState('');
  const current=useMemo(()=>describeProgramme(source.model),[source]);
  const ref=references.find(r=>r.docId===refId);
  const evidence=useMemo(()=>ref ? compareProgrammeEvidence(source.model,ref.model) : null,[source,ref]);
  return (
    <section aria-label="Real programme impact" className="rounded-lg border border-border bg-card p-5 space-y-3">
      <h3 className="font-semibold text-foreground">Real programme impact</h3>
      <p className="text-sm">Input: <strong>{source.fileName}</strong>. {current.activityCount.toLocaleString()} activities, {current.relationships.toLocaleString()} relationships{current.unresolvedRelationships ? ` (${current.unresolvedRelationships.toLocaleString()} unresolved; calculation unavailable)` : ''}. XER data date: {current.dataDate || 'not available'}. Stored forecast: {current.forecast || 'not available'}.</p>
      {Boolean(source.model.warnings?.length) && <details className="text-sm"><summary>XER import notices</summary><ul className="list-disc pl-5">{source.model.warnings?.map((w,i)=><li key={i}>{w}</li>)}</ul></details>}
      <div className="flex flex-wrap gap-3 items-center">
        {references.length>0 ? <label className="text-sm">Processed PVR XER (reference only) <select className="rounded border border-input bg-card px-2 py-1" value={refId} onChange={e=>setRefId(e.target.value)}>
          <option value="">Select the processed result</option>{references.map(r=><option key={r.docId} value={r.docId}>{r.fileName}</option>)}</select></label> : <p className="text-sm text-muted-foreground">Upload the processed XER as a Reference programme to compare it separately.</p>}
      </div>
      <StandaloneProgrammePanel caseId={caseId} source={source} reference={ref} scope={scope} onScenario={onScenario} verifyDrawings={verifyDrawings} />
      {evidence && <div className="rounded border border-input p-3 text-sm space-y-2">
        <p>Processed reference: <strong>{evidence.rhs.forecast || 'forecast not available'}</strong> (data date {evidence.rhs.dataDate || 'not available'}). {evidence.added.length} activities only in the reference; {evidence.removed} only in the source.</p>
        {evidence.observedCalendarDays !== null && <p>Difference between stored forecasts: <strong>{evidence.observedCalendarDays>0 ? '+' : ''}{evidence.observedCalendarDays} calendar days</strong>. This is not a delay recalculated by the tool.</p>}
        <p>Changes among existing activities: {evidence.existingDurationChanges.length} with different durations, {evidence.existingConstraintChanges} with different constraints or expected finish overrides, and {evidence.existingLinkAdds} links added / {evidence.existingLinkRemovals} removed.</p>
        {evidence.changedSettingFields.length>0 && <details><summary>Changed project and scheduling settings ({evidence.changedSettingFields.length})</summary><p>{evidence.changedSettingFields.join(', ')}</p></details>}
        {evidence.checks.length>0 ? <><p className="font-semibold">Stored result only. Do not attribute the date difference to the variation from this pair.</p>
          <ul className="list-disc pl-5">{evidence.checks.map(c=><li key={c}>{c}</li>)}</ul></> :
          <p>This is a comparison of uploaded programmes. Matching dates alone do not validate the scenario or establish the cause of a delay.</p>}
        {evidence.added.length>0 && <details><summary>Activities only in the reference</summary><ul className="list-disc pl-5">{evidence.added.slice(0,30).map(a=><li key={a.code}>{a.code}: {a.description}</li>)}</ul></details>}
        {(evidence.referenceTies.length>0 || evidence.referenceInternalTies.length>0) && <details><summary>Links involving reference-only activities</summary><ul className="list-disc pl-5">{[...evidence.referenceTies,...evidence.referenceInternalTies].slice(0,40).map((r,i)=><li key={i}>{r.from} → {r.to} ({r.type}{r.lagHours ? `, lag ${r.lagHours} h` : ''})</li>)}</ul></details>}
        {evidence.milestones.length>0 && <details><summary>Changed stored milestones ({evidence.milestones.length})</summary><ul className="list-disc pl-5">{evidence.milestones.slice(0,30).map(a=><li key={a.code}>{a.code}: {a.before} → {a.after} (float {a.floatBefore ?? 'unknown'} → {a.floatAfter ?? 'unknown'} hours)</li>)}</ul></details>}
      </div>}
    </section>
  );
}

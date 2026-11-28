'use client';

import {useState} from 'react';
import {calculateScopeReadiness,type ScopeLot} from '@/lib/assessment/scopeReadiness';
import {sameUnit} from '@/lib/boq/calc';
import type {ScheduleModel} from '@/lib/mapping/types';
import type {FormLine} from '@/lib/pvr/finalForm';

const field='rounded border border-input bg-card px-2 py-1';
const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

export default function ScopeReadinessPanel({lines,model}:{lines:FormLine[];model:ScheduleModel}) {
  const [instruction,setInstruction]=useState('');
  const [gate,setGate]=useState('');
  const [days,setDays]=useState<number[]>([]);
  const [inputs,setInputs]=useState<Record<string,{leadMonths:string;unitsPerCrewDay:string}>>({});
  const [show,setShow]=useState(false);
  const candidates=lines.filter(l=>l.quantityAction==='add' && !!l.drawingSource && !!l.quantity && /^[1-9]\d*$/.test(l.quantity) &&
    sameUnit(l.quantityUnit,'nr') && (l.disposition==='priced'||l.disposition==='unpriced'));
  const gateActivities=model.activities.filter(a=>!!a.earlyStart && !a.actualFinish && a.status==='not_started');
  const selectedGate=gateActivities.find(a=>(a.taskId??a.id)===gate);
  const selected=candidates.filter(l=>Object.hasOwn(inputs,l.lineId));
  const lots:ScopeLot[]=selected.map(l=>({id:l.lineId,quantity:l.quantity!,...inputs[l.lineId]}));
  const result=show&&selectedGate?.earlyStart ? calculateScopeReadiness(instruction,selectedGate.earlyStart,days,lots) : null;
  const change=(fn:()=>void)=>{fn();setShow(false);};
  if (!candidates.length) return null;
  return <details className="rounded-lg border border-input bg-card p-4 text-sm space-y-3">
    <summary className="font-semibold cursor-pointer">Test readiness of counted drawing scope</summary>
    <p>Choose verified additions from drawing counts and enter explicit procurement and crew assumptions. Lots run in parallel with separate crews. The selected programme activity is a date to compare against; this does not reschedule the project or calculate a PVR delay.</p>
    <div className="flex flex-wrap gap-2">
      <label>Assumed instruction date <input className={field} type="date" value={instruction} onChange={e=>change(()=>setInstruction(e.target.value))}/></label>
      <label>Comparison activity <select className={field} value={gate} onChange={e=>change(()=>setGate(e.target.value))}>
        <option value="">Select from pre-impact programme</option>{gateActivities.map(a=><option key={a.taskId??a.id} value={a.taskId??a.id}>{a.id}: {a.name} ({a.earlyStart})</option>)}
      </select></label>
    </div>
    <fieldset className="flex flex-wrap gap-2"><legend>Assumed crew working week (no calendar exceptions)</legend>
      {DAYS.map((name,i)=><label key={name}><input type="checkbox" checked={days.includes(i)} onChange={e=>change(()=>setDays(old=>e.target.checked?[...old,i]:old.filter(d=>d!==i)))}/> {name}</label>)}
    </fieldset>
    <div className="divide-y max-h-80 overflow-y-auto">
      {candidates.map(l=><div key={l.lineId} className="py-1 flex flex-wrap items-center gap-3">
        <label><input type="checkbox" checked={!!inputs[l.lineId]} onChange={e=>change(()=>setInputs(old=>{
          const next={...old};if(e.target.checked) next[l.lineId]={leadMonths:'',unitsPerCrewDay:''};else delete next[l.lineId];return next;
        }))}/> {l.description} ({l.quantity} {l.quantityUnit})</label>
        {inputs[l.lineId]&&(['leadMonths','unitsPerCrewDay'] as const).map(k=><label key={k}>{k==='leadMonths'?'Calendar months to deliver':'Units installed per crew day'} <input className={field+' w-20'} type="number" min={k==='leadMonths'?0:1} step="1" value={inputs[l.lineId][k]} onChange={e=>change(()=>setInputs(old=>({...old,[l.lineId]:{...old[l.lineId],[k]:e.target.value}})))}/></label>)}
      </div>)}
    </div>
    <button type="button" className={field} onClick={()=>setShow(true)}>Calculate readiness</button>
    {show && (result?<div role="status">
      <p>Scope ready <strong>{result.ready}</strong>, {Math.abs(result.afterGateCalendarDays)} calendar day(s) {result.afterGateCalendarDays===0?'from':result.afterGateCalendarDays<0?'before':'after'} the stored activity start. This is a readiness comparison, not project delay.</p>
      <ul>{result.rows.map(r=><li key={r.id}>{selected.find(l=>l.lineId===r.id)?.description}: delivery {r.delivery}, installation {r.fieldDays} crew day(s), ready {r.complete}.</li>)}</ul>
    </div>:<p role="status">Enter an instruction date, comparison activity, crew working days and complete assumptions for each selected scope line.</p>)}
  </details>;
}

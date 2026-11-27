'use client';

import { useEffect, useMemo, useState } from 'react';
import { compareTakeoff, DETAILS, REASONS, renderPvrForm, type FormDetails, type FormInput, type TakeoffReference } from '@/lib/pvr/finalForm';

interface Props extends Omit<FormInput,'details'|'references'> {caseId:string; title:string; verifyDrawingRevisions:()=>Promise<boolean>}
const selectOptions: Partial<Record<typeof DETAILS[number][0],string[]>> = {
  initiator:['Project Owner/Development','Consultant','Contractor'],
  basis:['Rough order of Magnitude','Detailed Proposal','Other'],
  recommendation:['Sign VO before proceeding with work',"Proceed with Engineer's Instruction"],
};
const fieldClass = 'w-full rounded border border-input bg-card px-2 py-1.5 text-foreground';
const EMPTY_REFERENCE:TakeoffReference={value:'',unit:'',citation:''};

export default function FinalPvrForm({caseId,title,lines,reportReady,time,blockers,verifyDrawingRevisions}:Props) {
  const [details,setDetails]=useState<FormDetails>({});
  const [refs,setRefs]=useState<Record<string,TakeoffReference>>({});
  const [loaded,setLoaded]=useState(false);
  const [saveProblem,setSaveProblem]=useState(false);
  const key='pvr-final-form-v1:'+caseId;
  useEffect(()=>{
    let data:{details?:FormDetails;refs?:Record<string,TakeoffReference>}={};
    try {data=JSON.parse(window.localStorage.getItem(key)||'{}')??{};} catch {/* start empty */}
    setDetails({title,...data.details});setRefs(data.refs??{});setLoaded(true);
  },[key,title]);
  useEffect(()=>{
    if (!loaded) return;
    try {window.localStorage.setItem(key,JSON.stringify({details,refs}));setSaveProblem(false);} catch {setSaveProblem(true);}
  },[key,loaded,details,refs]);
  const setField=(k:typeof DETAILS[number][0],v:string)=>setDetails(d=>({...d,[k]:v}));
  const setRef=(id:string,v:Partial<TakeoffReference>)=>setRefs(cur=>({...cur,[id]:{...(cur[id]??EMPTY_REFERENCE),...v}}));
  const identification=!!(details.project?.trim() && details.contract?.trim() && details.number?.trim() && details.title?.trim());
  const ready=reportReady && identification;
  const formBlockers=useMemo(()=>[...(!identification?['Complete the project name, contract number, PVR number and title to prepare a final form.']:[]),...(blockers??[])],[identification,blockers]);
  const html=async()=>{
    const stale=ready && !(await verifyDrawingRevisions());
    return renderPvrForm({details,lines,references:refs,reportReady:ready&&!stale,time,blockers:stale
      ? [...formBlockers,'The source drawing revisions have changed or are unavailable. Rerun the takeoff before using these results.']
      : formBlockers});
  };
  const download=async()=>{
    const url=URL.createObjectURL(new Blob([await html()],{type:'text/html;charset=utf-8'}));
    const a=document.createElement('a');a.href=url;a.download=((details.number||'PVR').replace(/[^\w.-]/g,'_').slice(0,80)||'PVR')+'-form.html';
    a.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  const print=async()=>{
    // Print in an isolated frame so the app's dashboard is never included in the form.
    const frame=document.createElement('iframe');frame.title='Printable PVR form';frame.setAttribute('sandbox','allow-same-origin allow-modals');
    frame.style.cssText='position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
    frame.onload=()=>{const win=frame.contentWindow;if(!win){frame.remove();return;}win.addEventListener('afterprint',()=>frame.remove(),{once:true});win.focus();win.print();window.setTimeout(()=>frame.remove(),60000);};
    frame.srcdoc=await html();document.body.append(frame);
  };
  return <section aria-labelledby="final-pvr-title" className="rounded-lg border border-border bg-card p-5 shadow-sm space-y-3">
    <div className="flex gap-3 flex-wrap justify-between items-start"><div>
      <h2 id="final-pvr-title" className="text-lg font-semibold">Final PVR form</h2>
      <p className="text-sm text-muted-foreground">Project details, cost and time impact, recommendations and unsigned approvals. The annex shows the drawing takeoff and every rate source.</p>
    </div><div className="flex flex-wrap gap-2">
      <button type="button" onClick={download} className="rounded border border-input px-3 py-1.5 text-sm">Download form</button>
      <button type="button" onClick={print} className="rounded border border-input px-3 py-1.5 text-sm">Print / Save PDF</button>
    </div></div>
    {formBlockers.length>0 && <div className="rounded border border-warning/40 bg-warning/10 p-2 text-sm">
      <strong>Draft until verified</strong><ul className="list-disc pl-5">{formBlockers.map(b=><li key={b}>{b}</li>)}</ul>
    </div>}
    {saveProblem && <p role="status" className="text-sm">These form edits could not be saved in this browser. Download a copy before leaving.</p>}
    <details open className="rounded border border-input p-3"><summary className="cursor-pointer font-medium">Project and PVR details</summary>
      <div className="grid gap-2 mt-3 sm:grid-cols-2 lg:grid-cols-3">{DETAILS.slice(0,9).map(([k,label])=><label key={k} className={(k==='description'||k==='reasoning'?'sm:col-span-2 lg:col-span-3 ':'')+'block text-sm'}>
        {label}{(k==='description'||k==='reasoning')?<textarea className={fieldClass} rows={2} value={details[k]??''} onChange={ev=>setField(k,ev.target.value)}/>:<input className={fieldClass} value={details[k]??''} onChange={ev=>setField(k,ev.target.value)}/>}
      </label>)}</div>
    </details>
    <details className="rounded border border-input p-3"><summary className="cursor-pointer font-medium">Change reason, budget and recommendations</summary>
      <fieldset className="flex flex-wrap gap-3 mt-2 text-sm"><legend>Change reason (select all that apply)</legend>{REASONS.map(r=><label key={r}><input type="checkbox" checked={details.reasons?.includes(r)??false} onChange={ev=>{const checked=ev.target.checked;setDetails(d=>({...d,reasons:checked?[...(d.reasons??[]),r]:(d.reasons??[]).filter(x=>x!==r)}));}}/> {r}</label>)}</fieldset>
      <div className="grid gap-2 mt-3 sm:grid-cols-2 lg:grid-cols-3">{DETAILS.slice(9).map(([k,label])=><label key={k} className="block text-sm">{label}
        {selectOptions[k]?<select className={fieldClass} value={details[k]??''} onChange={ev=>setField(k,ev.target.value)}><option value="">Not specified</option>{selectOptions[k]?.map(o=><option key={o}>{o}</option>)}</select>:
        <input className={fieldClass} type={k==='clientCommitment'?'date':'text'} value={details[k]??''} onChange={ev=>setField(k,ev.target.value)}/>}
      </label>)}</div>
    </details>
    {lines.length>0 && <details className="rounded border border-input p-3"><summary className="cursor-pointer font-medium">Compare quantities against the processed PVR</summary>
      <p className="text-sm text-muted-foreground mb-2">Enter a reference value and citation for the equivalent scope. These values never feed pricing or the schedule.</p>
      <div className="divide-y divide-border max-h-96 overflow-auto">{lines.map(l=>{const ref=refs[l.lineId]??EMPTY_REFERENCE;const delta=compareTakeoff(l,ref);
        return <div key={l.lineId} className="grid gap-2 py-2 text-sm md:grid-cols-[1.4fr_1fr_1fr]">
          <div><strong>{l.description}</strong><div className="text-muted-foreground">{l.drawingSource && l.quantity ? l.quantity+' '+l.quantityUnit+' from drawings' : 'No verified drawing quantity'}</div></div>
          <div className="flex gap-2"><label className="flex-1">Reference quantity<input className={fieldClass} value={ref.value} inputMode="decimal" onChange={ev=>setRef(l.lineId,{value:ev.target.value})}/></label>
          <label className="w-20">Unit<input className={fieldClass} value={ref.unit} onChange={ev=>setRef(l.lineId,{unit:ev.target.value})}/></label></div>
          <label>Source / page / line<input className={fieldClass} value={ref.citation} onChange={ev=>setRef(l.lineId,{citation:ev.target.value})}/><small>{delta===null?'Not comparable yet':'Drawings less reference: '+delta+' '+l.quantityUnit}</small></label>
        </div>;})}</div>
    </details>}
  </section>;
}

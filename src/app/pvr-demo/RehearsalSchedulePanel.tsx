'use client';

import React, { useState } from 'react';
import { dayDiff } from '@/lib/assessment/cpmEngine';
import type { RehearsalSchedule } from '@/lib/demo/scheduleRehearsal';

const fmt = (s:string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) ? new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(s+'T00:00:00Z')) : '—';
const qtyUnit = (s:string) => s==='m2'?'m²':s==='m3'?'m³':s;
const delta=(n:number) => n>0?`+${n}`:n<0?`−${Math.abs(n)}`:'0';
type Row=RehearsalSchedule['rows'][number];

function Timeline({ rows }: { rows:Row[] }) {
  if (!rows.length) return null;
  const start=rows[0].beforeStart;
  const finish=rows.flatMap(r=>[r.beforeFinish,r.afterFinish]).sort().at(-1)!;
  const days=Math.max(1,dayDiff(start,finish)+1);
  const bar=(from:string,to:string,milestone:boolean)=>({
    left:`${Math.max(0,dayDiff(start,from)) / days * 100}%`,
    width:milestone?'0':`${Math.max(1,1+dayDiff(from,to)) / days * 100}%`,
  });
  return <div className="mt-5 overflow-x-auto" aria-label="Baseline and simulated programme comparison">
    <div className="mb-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
      <span><span className="mr-1 inline-block h-2 w-4 rounded bg-slate-400" />Pre-change</span>
      <span><span className="mr-1 inline-block h-2 w-4 rounded bg-blue-700" />Simulated</span>
      <span><span className="mr-1 inline-block h-2 w-4 rounded bg-rose-700" />Simulated driving path</span>
      <span>◆ Milestone</span>
    </div>
    <div className="min-w-[730px] rounded border border-border">
      <div className="grid grid-cols-[13rem_minmax(12rem,1fr)_15rem] gap-3 bg-muted px-3 py-2 text-xs font-semibold">
        <span>Activity / milestone</span><span className="flex justify-between"><span>{fmt(start)}</span><span>{fmt(finish)}</span></span><span>Finish: pre-change → simulated</span>
      </div>
      {rows.map(r=>{
        const milestone=r.kind.startsWith('milestone');
        return <div key={r.code} className="grid grid-cols-[13rem_minmax(12rem,1fr)_15rem] items-center gap-3 border-t border-border px-3 py-2 text-xs">
          <div><span className="font-mono text-muted-foreground">{r.code}</span><p className="font-semibold">{r.name}</p></div>
          <div className="relative mr-2 h-7 rounded bg-muted/50" aria-hidden="true">
            <span className={`absolute top-1 h-2 bg-slate-400 ${milestone?'!w-2 rotate-45':'rounded'}`} style={bar(r.beforeStart,r.beforeFinish,milestone)} />
            <span className={`absolute top-4 h-2 ${r.driving?'bg-rose-700':'bg-blue-700'} ${milestone?'!w-2 rotate-45':'rounded'}`} style={bar(r.afterStart,r.afterFinish,milestone)} />
          </div>
          <div><span>{fmt(r.beforeFinish)} → {fmt(r.afterFinish)}</span><strong className={r.shift?'ml-2 text-rose-700':'ml-2 text-muted-foreground'}>{delta(r.shift)}d</strong>
            <p className="text-muted-foreground">Float: {r.beforeFloat} → {r.afterFloat} workdays</p></div>
        </div>;
      })}
    </div>
  </div>;
}

export default function RehearsalSchedulePanel({ schedule, busy, onCalculate }: {
  schedule?: RehearsalSchedule;
  busy:boolean;
  onCalculate:(baseline:File, productivity:File, benchmark?:File)=>void;
}) {
  const [files,setFiles]=useState<{baseline?:File;productivity?:File;benchmark?:File}>({});
  const fields=[['baseline','Pre-change Primavera XER','.xer'],['productivity','Productivity assumptions (CSV)','.csv'],['benchmark','Impacted XER (optional comparison only)','.xer']] as const;
  return <section aria-label="Programme and time impact" className="space-y-4 rounded-lg border border-border bg-card p-4">
    <div>
      <h2 className="text-xl font-semibold">Programme and time impact</h2>
      <p className="mt-1 text-sm text-muted-foreground">Follow measured work from the drawing and BOQ into P6 activities, then see what moves when the original logic and calendar are recalculated.</p>
    </div>
    {!schedule ? <p className="rounded border border-border bg-muted p-3 text-sm">No schedule is saved with this rehearsal. Use the complete civil sample or attach a pre-change XER and a productivity basis.</p> :
      <>
        <p className="text-sm"><strong>{schedule.sample?'Synthetic civil works demonstration':'Uploaded rehearsal inputs'}</strong> · {schedule.activityCount} activities · {schedule.linkCount} logic links · Data date {fmt(schedule.dataDate)}.</p>
        {schedule.after ? <div className="grid gap-2 sm:grid-cols-3">
          <div className="rounded border border-border p-3"><p className="text-xs text-muted-foreground">Pre-change completion</p><strong className="text-lg">{fmt(schedule.before)}</strong></div>
          <div className="rounded border border-border p-3"><p className="text-xs text-muted-foreground">Simulated completion</p><strong className="text-lg">{fmt(schedule.after)}</strong></div>
          <div className="rounded border border-rose-200 bg-rose-50 p-3 text-rose-950"><p className="text-xs">Completion impact</p><strong className="text-lg">{delta(schedule.completionDelta??0)} calendar days</strong></div>
        </div> : <div role="status" className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"><strong>Impact not calculated.</strong>
          <ul className="list-disc pl-5">{schedule.blockers.map((reason,i)=><li key={i}>{reason}</li>)}</ul></div>}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm"><thead><tr className="border-b border-border">
            <th className="p-2">Measured change / BOQ</th><th className="p-2">Proposed execution activity</th><th className="p-2">Working duration added</th>
          </tr></thead><tbody>{schedule.mappings.map(m=><tr key={m.id} className="border-b border-border align-top">
            <th scope="row" className="p-2 font-medium capitalize">{m.name.toLowerCase()}<p className="font-normal">{m.qty ? `${m.qty} ${qtyUnit(m.unit)}` : 'Quantity needs review'}{m.boqRef ? ` · ${m.boqRef}` : ''}</p></th>
            <td className="p-2">{m.code?<strong>{m.code} · {m.activity}</strong>:'Held for review'}<p className="text-xs text-muted-foreground">{m.explanation}</p></td>
            <td className="p-2">{m.workDays===null?'Not set':<><strong>+{m.workDays} workdays</strong><p className="text-xs">{m.qty} ÷ {m.rate} {qtyUnit(m.unit)}/workday, rounded up</p><p className="text-xs text-muted-foreground">{m.rateBasis}</p></>}</td>
          </tr>)}</tbody></table>
        </div>
        {schedule.after ? <>
          <div className="grid gap-2 sm:grid-cols-2" aria-label="Finish milestones">{schedule.rows.filter(r=>r.kind==='milestone_finish').map(r=><div key={r.code} className="rounded border border-border p-3 text-sm">
            <p className="font-semibold">{r.name} · {r.code}</p><p>{fmt(r.beforeFinish)} → {fmt(r.afterFinish)} <strong>({delta(r.shift)} calendar days)</strong></p>
          </div>)}</div>
          <Timeline rows={schedule.rows}/>
          <p className="text-sm"><strong>Driving chain:</strong> {schedule.path.join(' → ')}</p>
          <details className="rounded border border-border p-3 text-sm"><summary className="cursor-pointer font-semibold">Activity dates, durations and predecessor ties</summary>
            <ul className="mt-2 space-y-2">{schedule.rows.map(r=><li key={r.code}><strong>{r.code} · {r.name}:</strong> {fmt(r.beforeStart)} to {fmt(r.beforeFinish)} → {fmt(r.afterStart)} to {fmt(r.afterFinish)}. Duration {r.beforeDuration} → {r.afterDuration} workdays. Predecessors: {r.predecessors.join(', ')||'start of programme'}.</li>)}</ul>
          </details>
        </>:null}
        <div className="rounded border border-border p-3 text-sm">
          <p><strong>Source control:</strong> {schedule.after?'Reproduced':'Compared'} {schedule.checkedCount} source activity records{schedule.after?' before applying the change.':'; any unresolved checks block simulation.'}</p>
          <p className="mt-1"><strong>Independent check:</strong> {schedule.benchmark
            ? schedule.benchmark.status==='not_comparable'?'Not comparable.':`${schedule.benchmark.status==='matched'?'Matched':'Differences found'}: ${schedule.benchmark.milestoneMatches}/${schedule.benchmark.milestoneCount} finish milestones; stored completion ${fmt(schedule.benchmark.storedFinish)}.`
            :'No impacted XER supplied.'} {schedule.benchmark?'The impacted XER was used only after calculation, never to set activities or dates.':''}</p>
          {schedule.benchmark?.checks.map((c,i)=><p key={i} className="mt-1 text-muted-foreground">{c}</p>)}
          {schedule.warnings.map((w,i)=><p key={i} className="mt-1 text-muted-foreground">{w}</p>)}
          <details className="mt-2 text-xs"><summary className="cursor-pointer">Schedule source files</summary>
            <ul className="mt-1">{schedule.inputs.map(f=><li key={f.role} title={f.sha256}>{f.role}: {f.name}</li>)}</ul>
          </details>
        </div>
        <p className="text-xs text-muted-foreground">Day-level CPM simulation, not a Primavera run, an approved programme or an extension-of-time decision. Resource levelling is not applied. The source XER is never edited.</p>
      </>}
    <details className="rounded border border-border p-3 text-sm">
      <summary className="cursor-pointer font-semibold">Calculate using your own synthetic XER and productivity CSV</summary>
      <p className="mt-2 text-muted-foreground">Use a small single-project XER. CSV columns: Item, Unit, Quantity per working day, Source. For coordinate-only drawing locations, link each BOQ item to its P6 execution activity with a BOQ Item activity code.</p>
      <form className="mt-2 flex flex-wrap items-end gap-3" onSubmit={e=>{e.preventDefault(); if(files.baseline&&files.productivity)onCalculate(files.baseline,files.productivity,files.benchmark);}}>
        {fields.map(([id,label,accept])=><label key={id} className="grid gap-1 text-xs font-medium">{label}<input type="file" required={id!=='benchmark'} accept={accept} disabled={busy} onChange={e=>setFiles(prev=>({...prev,[id]:e.target.files?.[0]}))}/></label>)}
        <button type="submit" disabled={busy||!files.baseline||!files.productivity} className="rounded bg-primary px-3 py-2 font-semibold text-primary-foreground disabled:opacity-50">Calculate and save time impact</button>
      </form>
    </details>
  </section>;
}

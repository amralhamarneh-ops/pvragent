'use client';
import {useId,useMemo,useState} from 'react';
import {makeGanttLayout,type GanttDates,type GanttRow} from '@/lib/assessment/programmeGantt';
export default function ProgrammeGantt({rows,beforeLabel,afterLabel,description}:{rows:GanttRow[];beforeLabel:string;afterLabel?:string;description:string}) {
  const [expanded,setExpanded]=useState(false);
  const id=useId();
  const g=useMemo(()=>makeGanttLayout(rows,expanded?40:12),[rows,expanded]);
  if(!g.rows.length)return <p className="text-sm text-muted-foreground">No valid activity dates are available for the Gantt preview.</p>;
  function bar(d:GanttDates|undefined,row:GanttRow,after=false) {
    if(!d)return null;
    const x=g.position(d.start),finish=g.position(d.finish),tone=after?(row.driving?'bg-rose-700':'bg-emerald-600'):'bg-sky-600';
    const marker=row.milestone || x===finish;
    return <span aria-hidden="true" title={`${d.start} → ${d.finish}`} className={`absolute z-[1] h-2 ${tone} ${marker?'w-2 rotate-45 rounded-[1px]':'min-w-[3px] rounded-full'}`}
       style={{left:`${x}%`,top:after?21:8,...(marker?{marginLeft:-4}:{width:`${finish-x}%`})}} />;
  }
  return <figure aria-labelledby={id} className="rounded-xl border border-border bg-card p-3 sm:p-4">
    <figcaption id={id} className="space-y-1"><strong className="text-sm">Programme Gantt preview</strong><p className="text-xs text-muted-foreground">{description}. Each pair shares the same date scale.</p></figcaption>
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs"><span><span aria-hidden="true" className="mr-1 inline-block h-2 w-3 rounded bg-sky-600" />{beforeLabel}</span>{afterLabel&&<span><span aria-hidden="true" className="mr-1 inline-block h-2 w-3 rounded bg-emerald-600" />{afterLabel}</span>}{afterLabel&&g.rows.some(r=>r.driving)&&<span><span aria-hidden="true" className="mr-1 inline-block h-2 w-3 rounded bg-rose-700" />Simulated driving links</span>}<span>◆ Milestone</span></div>
    <p className="mt-2 text-[11px] text-muted-foreground sm:hidden">Swipe across to see the full timeline.</p>
    <div className="mt-3 overflow-x-auto px-1 pb-2"><div className="min-w-[300px] sm:min-w-[630px]">
      <div className="grid grid-cols-[6.25rem_1fr] sm:grid-cols-[12rem_1fr] gap-3 border-b border-input py-2 text-[11px] text-muted-foreground">
        <span>Activity</span><div className="relative h-4">{g.ticks.map((t,i)=><span key={i} className="absolute whitespace-nowrap" style={{left:`${100*i/(g.ticks.length-1)}%`,transform:i===0?undefined:i===g.ticks.length-1?'translateX(-100%)':'translateX(-50%)'}}><span className="hidden sm:inline">{t}</span><span className="sm:hidden" title={t}>{t.slice(5).replace('-','/')}</span></span>)}</div>
      </div>
      {g.rows.map(row=><div className="grid grid-cols-[6.25rem_1fr] sm:grid-cols-[12rem_1fr] items-center gap-3 border-b border-border/60 py-1" key={row.code}>
        <div className="overflow-hidden text-xs"><span className="block truncate font-medium" title={row.name}>{row.name}</span><span className="text-[10px] text-muted-foreground">{row.code}</span>
          {row.after&&<span className="mt-0.5 block break-words text-[10px] text-muted-foreground">{row.before?row.before.finish.replace('T',' ').slice(0,16):'New work'} → {row.after.finish.replace('T',' ').slice(0,16)}{row.after.floatHours!=null?` · float ${row.before?.floatHours??'–'} → ${row.after.floatHours} h`:''}</span>}
          <span className="sr-only">{row.before?`${beforeLabel}: ${row.before.start} to ${row.before.finish}.`:''} {row.after?`${afterLabel}: ${row.after.start} to ${row.after.finish}.`:''}</span>
        </div>
        <div className="relative h-9 border-x border-input bg-muted/30">
          {g.ticks.slice(1,-1).map((_,i)=><i aria-hidden="true" key={i} className="absolute inset-y-0 border-l border-input" style={{left:`${100*(i+1)/(g.ticks.length-1)}%`}} />)}
          {bar(row.before,row)}{bar(row.after,row,true)}
        </div>
      </div>)}
    </div></div>
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>Showing {g.rows.length} of {g.total} {afterLabel?'preview rows':'activities'}</span>{g.total>12&&<button type="button" className="rounded border border-input px-2 py-1" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>{expanded?'Show fewer':`Show up to ${Math.min(40,g.total)}`}</button>}</div>
  </figure>;
}

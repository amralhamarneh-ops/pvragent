'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { REPLAY_SPEEDS, replayDelay, type ReplaySpeed } from '@/lib/drawings/replay';
import { completeCivilSample } from '@/lib/demo/scheduleSample';
import { calculateRehearsalSchedule, type RehearsalSchedule } from '@/lib/demo/scheduleRehearsal';
import RehearsalSchedulePanel from './RehearsalSchedulePanel';
import DrawingChangeSheets from './DrawingChangeSheets';
import SavedDrawingReplay from '@/app/case-workspace/components/SavedDrawingReplay';
import { DEMO_KEY, REHEARSAL_LIMIT, loadBrowserRehearsal, runBrowserRehearsal, type BrowserRehearsal } from '@/lib/demo/browserRehearsal';

const fileFields = [
  ['original', 'Original drawing (DXF)', '.dxf'],
  ['revised', 'Revised drawing (DXF)', '.dxf'],
  ['boq', 'BOQ (CSV)', '.csv'],
  ['reference', 'Optional change instruction or processed PVR (reference only)', '.txt,.pdf,.docx'],
] as const;
type Field = (typeof fileFields)[number][0];
const numberLabel = (n: string | undefined) => n ?? '0';

export default function BrowserDemo() {
  const [files, setFiles] = useState<Partial<Record<Field,File>>>({});
  const [run, setRun] = useState<BrowserRehearsal | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mappingFrame, setMappingFrame] = useState<number | null>(null);
  const [mappingPaused, setMappingPaused] = useState(false);
  const [mappingSpeed, setMappingSpeed] = useState<ReplaySpeed>(1);
  // Frame zero shows the recorded BOQ import; later frames reveal one saved decision at a time.
  const mappingCount = run?.changes.length ?? 0;
  const mappingPlaying = mappingFrame !== null && mappingFrame < mappingCount;
  const visibleChanges = run?.changes.slice(0, mappingFrame ?? mappingCount) ?? [];
  useEffect(() => { setMappingFrame(null); setMappingPaused(false); }, [run]);
  useEffect(() => {
    if (!mappingPlaying || mappingPaused) return;
    const timer = window.setTimeout(() => setMappingFrame(n => n === null ? null : Math.min(n + 1, mappingCount)), replayDelay(mappingSpeed) * 2);
    return () => window.clearTimeout(timer);
  }, [mappingFrame, mappingCount, mappingPlaying, mappingPaused, mappingSpeed]);
  useEffect(() => {
    try {
      const saved = loadBrowserRehearsal(localStorage.getItem(DEMO_KEY));
      if (saved) { setRun(saved); setStatus('Reopened the saved rehearsal. No processing was rerun.'); }
    } catch { /* The file form remains available when storage is blocked. */ }
  }, []);
  const saveCopy = () => {
    if (!run) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(run)],{type:'application/json'}));
    const a = document.createElement('a');
    a.href=url; a.download='PVR-rehearsal-result.json'; a.click();
    window.setTimeout(()=>URL.revokeObjectURL(url), 2000);
  };
  const openCopy = async (file?: File) => {
    if (!file || busy) return;
    setError(''); setStatus('');
    try {
      const restored = file.size <= REHEARSAL_LIMIT * 3 ? loadBrowserRehearsal(await file.text()) : null;
      if (!restored) throw new Error('Choose a valid rehearsal result exported by this tool.');
      setRun(restored);
      try {
        localStorage.setItem(DEMO_KEY,JSON.stringify(restored));
        setStatus('Opened the saved rehearsal file. No processing was rerun.');
      } catch {
        setStatus('Opened the saved rehearsal file. No processing was rerun.');
        setError('This browser did not retain it. Keep the original saved file.');
      }
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not open the rehearsal file.'); }
  };
  const saveSchedule = (original: BrowserRehearsal, schedule: RehearsalSchedule) => {
    const next = {...original, schedule};
    const raw = JSON.stringify(next);
    if (!loadBrowserRehearsal(raw)) throw new Error('This rehearsal exceeds the save limit or has invalid schedule evidence.');
    setRun(next);
    try {
      localStorage.setItem(DEMO_KEY,raw);
      setStatus(schedule.after?'Saved drawing changes, BOQ matches and time impact in this browser.':'Saved the rehearsal with schedule checks requiring review.');
    } catch {
      setStatus('The complete rehearsal is shown below. Download the backup to preserve it; this browser did not save it.');
    }
  };
  const completeSample = async () => {
    if (busy) return;
    setBusy(true);setError('');setStatus('Reading the civil sample files…');
    try {
      const f=completeCivilSample();
      const result=await runBrowserRehearsal(f.original,f.revised,f.boq,f.referenceName,setStatus);
      setStatus('Reading the XER and calculating the scenario…');
      saveSchedule(result,await calculateRehearsalSchedule(result,f.schedule,true));
    } catch(err) {setError(err instanceof Error ? err.message : 'Could not run the complete rehearsal.');setStatus('');}
    finally {setBusy(false);}
  };
  const addSchedule = async (baseline:File, productivity:File, benchmark?:File) => {
    if (!run || busy) return;
    setBusy(true);setError('');setStatus('Reading the XER and calculating the scenario…');
    try {
      if (baseline.size>2_000_000 || (benchmark?.size??0)>2_000_000 || productivity.size>50_000)
        throw new Error('Use XERs up to 2 MB each and a productivity CSV up to 50 KB.');
      const input=async (f:File) => ({name:f.name,bytes:new Uint8Array(await f.arrayBuffer())});
      const [a,b,c]=await Promise.all([input(baseline),input(productivity),benchmark?input(benchmark):undefined]);
      saveSchedule(run,await calculateRehearsalSchedule(run,{baseline:a,productivity:b,benchmark:c}));
    } catch(err) {setError(err instanceof Error ? err.message : 'Could not assess the programme.');setStatus('');}
    finally {setBusy(false);}
  };
  const start = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const {original,revised,boq,reference} = files;
    if (busy || !original || !revised || !boq) return;
    if (original.size > 8_000_000 || revised.size > 8_000_000 || boq.size > 2_000_000) { setError('Use DXF files up to 8 MB each and a BOQ CSV up to 2 MB.'); return; }
    setBusy(true); setError(''); setStatus('Reading the selected files…');
    try {
      const [a,b,c] = await Promise.all([original,revised,boq].map(async f => ({name:f.name,bytes:new Uint8Array(await f.arrayBuffer())})));
      const result = await runBrowserRehearsal(a,b,c,reference?.name,setStatus);
      setRun(result);
      try {
        localStorage.setItem(DEMO_KEY, JSON.stringify(result));
        if (loadBrowserRehearsal(localStorage.getItem(DEMO_KEY))?.savedAt !== result.savedAt) throw new Error();
        setStatus('Saved in this browser. Reopen this page in the same profile to replay without processing again.');
      } catch {
        setStatus('');
        setError('Processing finished, but the browser could not save the result. Keep this tab open.');
      }
    } catch (err) { setStatus(''); setError(err instanceof Error ? err.message : 'The demo could not be processed.'); }
    finally { setBusy(false); }
  };
  return <main className="mx-auto max-w-6xl space-y-5 p-4 lg:p-8">
    <div>
      <Link href="/new-pvr" className="text-sm underline">Back to New PVR</Link>
      <h1 className="mt-2 text-3xl font-semibold">PVR rehearsal: drawings, BOQ &amp; programme</h1>
      <p className="mt-1 text-muted-foreground">Browser-only demo. Use synthetic files only. The latest rehearsal is saved in this browser profile, not on the server. No cost or approvals. The schedule section shows a simulated impact, not an approved programme.</p>
    </div>
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3">
      <button type="button" disabled={busy} onClick={()=>void completeSample()} className="rounded bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">Run complete civil sample</button>
      <p className="text-sm text-muted-foreground">Drawing revisions → BOQ → P6 activities → time impact. Running the sample replaces the saved rehearsal in this browser.</p>
    </div>
    <details className="rounded-lg border border-border bg-card p-4" open={run ? undefined : true}>
      <summary className="cursor-pointer font-semibold">Run a new rehearsal</summary>
      <form onSubmit={start} className="mt-3 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          {fileFields.map(([id,label,accept]) => <label key={id} className="grid gap-1 text-sm font-medium">{label}
            <input type="file" accept={accept} required={id!=='reference'} disabled={busy} onChange={e => setFiles(p=>({...p,[id]:e.target.files?.[0]}))} className="rounded border border-input p-2" />
          </label>)}
        </div>
        <button disabled={busy || !files.original || !files.revised || !files.boq} type="submit" className="rounded bg-primary px-4 py-2 font-semibold text-primary-foreground disabled:opacity-50">Process and save rehearsal</button>
      </form>
    </details>
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3 text-sm">
      <label className="grid gap-1 font-medium">Open saved rehearsal file
        <input aria-label="Open saved rehearsal file" type="file" accept=".json" disabled={busy} onChange={e=>{const f=e.target.files?.[0];e.target.value='';void openCopy(f);}} />
      </label>
      {run ? <button type="button" onClick={saveCopy} className="rounded border border-input px-3 py-2">Download rehearsal backup</button> : null}
      <p className="text-xs text-muted-foreground">Only open rehearsal files you trust. A backup shows recorded results; it does not recheck the source files.</p>
    </div>
    {status ? <p role="status" className="text-sm font-medium">{status}</p> : null}
    {error ? <p role="alert" className="rounded border border-destructive/40 p-3 text-sm text-destructive">{error}{run ? ' The result shown below is from the latest completed run.' : ''}</p> : null}
    {run ? <div className="space-y-5">
      <nav aria-label="Rehearsal steps" className="flex flex-wrap gap-3 text-sm font-semibold"><a href="#drawing-rehearsal" className="underline">Drawings &amp; replay</a><a href="#boq-rehearsal" className="underline">BOQ matches</a><a href="#programme-rehearsal" className="underline">Programme &amp; time impact</a></nav>
      <div id="drawing-rehearsal" className="scroll-mt-20 space-y-4">
        <DrawingChangeSheets key={run.savedAt} model={run.replay.models[0]} changes={run.changes} />
        <SavedDrawingReplay key={`replay-${run.savedAt}`} replay={run.replay} changes={run.changes} />
      </div>
      <section id="boq-rehearsal" className="scroll-mt-20 rounded-lg border border-border bg-card p-4" aria-label="Measured quantities and BOQ mapping">
        <h2 className="text-xl font-semibold">Measured quantities and BOQ mapping</h2>
        <p className="text-sm text-muted-foreground">{run.boqRows} BOQ item(s) read. Mappings are proposals, not approvals. Quantities come from the drawing comparison only.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="BOQ mapping replay controls">
          <button type="button" onClick={()=>{setMappingFrame(0);setMappingPaused(window.matchMedia('(prefers-reduced-motion: reduce)').matches);}} className="rounded border border-input px-3 py-2 text-sm">Replay BOQ mapping</button>
          <label className="flex items-center gap-2 text-sm">Mapping replay speed
            <select aria-label="Mapping replay speed" value={mappingSpeed} onChange={e=>setMappingSpeed(Number(e.target.value) as ReplaySpeed)} className="rounded border border-input bg-card p-1.5">
              {REPLAY_SPEEDS.map(speed=><option key={speed} value={speed}>{speed}×</option>)}
            </select>
          </label>
          {mappingPlaying ? <>
            <button type="button" onClick={()=>setMappingPaused(v=>!v)} className="rounded border border-input px-2 py-1.5 text-sm">{mappingPaused ? 'Resume mapping replay' : 'Pause mapping replay'}</button>
            <button type="button" onClick={()=>setMappingFrame(i=>Math.min((i ?? 0)+1,mappingCount))} className="rounded border border-input px-2 py-1.5 text-sm">Next mapping</button>
            <button type="button" onClick={()=>setMappingFrame(mappingCount)} className="rounded border border-input px-2 py-1.5 text-sm">Show all mappings</button>
          </> : null}
        </div>
        {mappingFrame !== null ? <p role="status" className="mt-2 text-sm">
          {mappingFrame === 0 ? `Recorded BOQ import: ${run.boqRows} item(s). Showing the saved mapping decisions next.`
            : `Mapping replay: ${mappingFrame} of ${mappingCount} decisions shown. No analysis was rerun.`}
        </p> : null}
        <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm">
          <thead><tr className="border-b"><th className="p-2">Drawing change</th><th className="p-2">Measured delta</th><th className="p-2">Proposed BOQ item</th><th className="p-2">Source and review</th></tr></thead>
          <tbody>{visibleChanges.map(c=>{
            const m=run.mappings.find(x=>x.id===c.id);
            return <tr key={c.id} className="align-top border-b">
              <th scope="row" className="p-2">{c.component}</th>
              <td className="p-2">{c.netQty ?? c.changeQty} {c.unit}<p className="text-xs text-muted-foreground">Added {numberLabel(c.addedQty)} · omitted {numberLabel(c.omittedQty)}</p></td>
              <td className="p-2">{m?.proposal ? <><strong>{m.proposal.ref}</strong> · {m.proposal.description}</> : 'Held for review'}</td>
              <td className="p-2"><p>{m?.reason}</p>{m?.proposal ? <p className="text-xs">{m.proposal.file} · {m.proposal.sheet} · row {m.proposal.row}</p> : null}
                <details className="mt-1 text-xs"><summary className="cursor-pointer underline">Drawing quantity evidence</summary><p>{c.description}</p><p>{c.trace?.formula} · {c.trace?.drawingRevision}</p><p>{c.sources.join(' · ')}</p></details>
              </td>
            </tr>;
          })}</tbody>
        </table></div>
      </section>
      <div id="programme-rehearsal" className="scroll-mt-20"><RehearsalSchedulePanel key={run.savedAt} schedule={run.schedule} busy={busy} onCalculate={(a,b,c)=>void addSchedule(a,b,c)}/></div>
      <section className="rounded-lg border border-border bg-card p-4" aria-label="Saved processing steps">
        <h2 className="text-xl font-semibold">Saved processing steps</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">{run.events.map(event=><li key={event.step}><strong>{event.step}</strong>: {event.detail}</li>)}</ol>
        {run.schedule ? <p className="mt-2 text-sm">Schedule steps saved: read pre-change XER, check baseline reproduction, map execution activities, apply stated crew outputs and {run.schedule.after ? 'recalculate the network' : 'hold the simulation for review'}.</p> : null}
        <h3 className="mt-3 font-semibold">Input files</h3>
        <ul className="text-sm">{run.sources.map(s=><li key={s.role} title={s.sha256}>{s.role}: {s.name}</li>)}</ul>
        <details className="mt-3 text-sm"><summary className="cursor-pointer underline">Drawing reader checks</summary>
          <ul className="mt-2 space-y-1">{run.reads.map(r=><li key={r.fileName}>{r.fileName} · {r.stateLabel}: {r.detail}</li>)}</ul>
        </details>
      </section>
    </div> : null}
  </main>;
}

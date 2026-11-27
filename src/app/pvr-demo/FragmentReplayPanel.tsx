'use client';

import { useEffect, useState } from 'react';
import type { LoadedSchedule } from '@/lib/mapping/scheduleLoader';
import { FRAGMENT_MAX_BYTES, readSavedFragment, type FragmentResult } from '@/lib/demo/fragmentReplay';

export const SAVED_FRAGMENT_KEY = 'pvr-demo:reference-fragment:v1';
const dateLabel = (d: string) => new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
}).format(new Date(d + 'T00:00:00Z'));

export default function FragmentReplayPanel({reference, preChange}: {reference?: LoadedSchedule; preChange?: LoadedSchedule}) {
  const storageKey = reference && preChange ? `${SAVED_FRAGMENT_KEY}:${reference.sha256}:${preChange.sha256}` : SAVED_FRAGMENT_KEY;
  const [file, setFile] = useState<File>();
  const [first, setFirst] = useState('');
  const [next, setNext] = useState('');
  const [result, setResult] = useState<FragmentResult | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    try {
      const recorded = readSavedFragment(localStorage.getItem(storageKey));
      setResult(recorded); setSaved(!!recorded);
    } catch { /* Browser storage is optional. */ }
  }, [storageKey]);
  const calculate = async () => {
    if (busy || (!file && !reference)) return;
    setBusy(true); setError('');
    try {
      if (!reference && file && file.size > FRAGMENT_MAX_BYTES) throw new Error('Select an XER file up to 30 MB.');
      const { runFragmentReplay, calculateProgrammeFragment } = await import('@/lib/demo/fragmentReplay');
      setResult(reference ? calculateProgrammeFragment(reference.model,first,next,preChange?.model)
        : runFragmentReplay(new Uint8Array(await file!.arrayBuffer()),file!.name,first,next));
      setSaved(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not replay this fragment.');
    } finally { setBusy(false); }
  };
  const save = () => {
    if (!result) return;
    try {
      const data = JSON.stringify(result);
      if (!readSavedFragment(data)) throw new Error();
      localStorage.setItem(storageKey, data); setSaved(true); setError('');
    } catch { setError('This browser could not save the result. You can still show it during this session.'); }
  };
  const clear = () => {
    try { localStorage.removeItem(storageKey); setResult(null); setSaved(false); setError(''); }
    catch { setError('Could not remove the saved replay from this browser.'); }
  };
  return <details open={saved || undefined} className="space-y-4 rounded-lg border border-border bg-card p-4">
    <summary className="cursor-pointer font-semibold">Demo-only fallback for missing activity durations</summary>
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Demo only · Reference-assisted</p>
      <h2 id="reference-replay-title" className="text-xl font-semibold">Replay two activities from the impacted XER</h2>
      <p className="mt-1 text-sm text-muted-foreground">The same scheduling engine recalculates two linked activities using their durations, calendars, start constraint and link from the impacted XER. Stored finish dates are used only for comparison. This does not measure drawing quantities, infer productivity or calculate project delay.</p>
    </div>
    <form className="space-y-3" onSubmit={e=>{e.preventDefault();void calculate();}}>
      <fieldset disabled={busy} className="grid gap-3 md:grid-cols-3">
        {reference ? <p className="self-center break-words text-sm">Reference: <strong>{reference.fileName}</strong></p> : <label className="grid gap-1 text-sm font-medium">Impacted XER (up to 30 MB)
          <input className="w-full rounded border border-input p-2" type="file" accept=".xer" onChange={e=>setFile(e.target.files?.[0])}/>
        </label>}
        <label className="grid gap-1 text-sm font-medium">First activity code
          <input className="rounded border border-input bg-background p-2" value={first} maxLength={80} required onChange={e=>setFirst(e.target.value)}/>
        </label>
        <label className="grid gap-1 text-sm font-medium">Second activity code
          <input className="rounded border border-input bg-background p-2" value={next} maxLength={80} required onChange={e=>setNext(e.target.value)}/>
        </label>
      </fieldset>
      <p className="text-xs text-muted-foreground">Use two unstarted activities with a mandatory start on the first and a single zero-lag finish-to-start link. {reference ? 'Both activities must be missing from the pre-change XER.' : 'This check reads the file in your browser without sending it to the server.'}</p>
      <button type="submit" disabled={busy || (!file && !reference) || !first.trim() || !next.trim()} className="rounded bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{busy?'Reading and calculating…':'Calculate both activity dates'}</button>
    </form>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {result ? <div className="space-y-3">
      <p className="text-sm font-semibold" role="status">{result.rows.filter(r=>r.finish===r.storedFinish).length} of 2 activity finish dates matched{saved?' · Saved in this browser':''}</p>
      <p className="break-all text-sm text-muted-foreground">Source: {result.filename}. Mandatory start: {dateLabel(result.anchor)}. Relationship: finish-to-start, zero lag.</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[38rem] text-left text-sm">
          <caption className="sr-only">Recalculated dates compared to impacted XER</caption>
          <thead><tr className="border-b"><th scope="col" className="p-2">Activity</th><th scope="col" className="p-2">Impacted XER duration</th><th scope="col" className="p-2">Calculated start</th><th scope="col" className="p-2">Calculated finish</th><th scope="col" className="p-2">Stored finish</th></tr></thead>
          <tbody>{result.rows.map(r=><tr key={r.code} className="border-b align-top">
            <th scope="row" className="p-2">{r.code}<span className="block font-normal text-muted-foreground">{r.name}</span></th>
            <td className="p-2">{r.hours} h ÷ {r.hoursPerDay} h/day = {r.days} working {r.days===1?'day':'days'}<span className="block text-xs text-muted-foreground">{r.weekDays}-day week · {r.calendar}</span></td>
            <td className="p-2">{dateLabel(r.start)}</td><td className="p-2">{dateLabel(r.finish)}</td>
            <td className="p-2">{dateLabel(r.storedFinish)}<span className="block text-xs text-muted-foreground">{r.finish===r.storedFinish?'Matches':'Different'}</span></td>
          </tr>)}</tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || saved} onClick={save} className="rounded border border-input px-3 py-2 text-sm disabled:opacity-50">Save result in this browser</button>
        <button type="button" disabled={busy} onClick={clear} className="rounded border border-input px-3 py-2 text-sm">Clear result and saved copy</button>
      </div>
      <p className="text-xs text-muted-foreground">Saving replaces the previous result here. It does not save the source XER. Do not save on shared devices.</p>
    </div> : null}
  </details>;
}

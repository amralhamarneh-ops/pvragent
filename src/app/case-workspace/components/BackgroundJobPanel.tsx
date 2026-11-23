'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, Play, RotateCcw, Square, RefreshCw, Info } from 'lucide-react';
import { jobsApi, type JobSnapshot, type WorkerSummary } from '@/lib/drawings/jobsClient';
import { STATE_LABEL, assembleGeometry, buildRegister, fmtDuration, isActive, previewKind, summariseProgress, type DisplayState, type RegisterRow, type TaskResult } from '@/lib/drawings/jobView';
import type { JobRow } from '@/lib/drawings/jobService';
import PersistedDrawingViewer from '@/app/case-workspace/components/PersistedDrawingViewer';

interface Props {
  /** Server case id. Background processing needs a persisted case; a session-only case cannot be processed in the background. */
  caseId: string | null;
}

const POLL_MS = 3000;
const newRunId = () => `run-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
const tone = (s: string) => (s === 'completed' || s === 'reused' ? 'text-success' : s === 'partial' ? 'text-foreground' : s === 'failed' ? 'text-destructive' : s === 'cancelled' ? 'text-muted-foreground' : 'text-foreground');

/**
 * Persistent background analysis. This component only submits, observes and controls. Execution happens in the
 * independent worker; closing this page does not affect it. On mount it reconnects to the case's latest job.
 */
export default function BackgroundJobPanel({ caseId }: Props) {
  const [worker, setWorker] = useState<WorkerSummary | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [snap, setSnap] = useState<JobSnapshot | null>(null);
  const [events, setEvents] = useState<JobSnapshot['events']>([]);
  const [now, setNow] = useState<number>(0);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);
  const [replay, setReplay] = useState(false);
  const [replayCount, setReplayCount] = useState(0);
  const lastSeq = useRef(0);
  const jobRef = useRef<string | null>(null);
  jobRef.current = jobId;

  useEffect(() => { setNow(Date.now()); const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { void jobsApi.worker().then((r) => { if (r.ok) setWorker(r.data); }); }, []);

  // Reconnect: load the case's jobs and attach to the newest one, whatever state it is in.
  useEffect(() => {
    setJobs([]); setJobId(null); setSnap(null); setEvents([]); lastSeq.current = 0; setErr(''); setMsg('');
    if (!caseId || caseId.startsWith('session-')) return;
    let off = false;
    void jobsApi.list(caseId).then((r) => {
      if (off) return;
      if (!r.ok) { setErr(r.error); return; }
      setJobs(r.data.jobs);
      if (r.data.jobs[0]) setJobId(r.data.jobs[0].id);
    });
    return () => { off = true; };
  }, [caseId]);

  const refresh = useCallback(async (full = false) => {
    const id = jobRef.current; if (!caseId || !id) return;
    const r = await jobsApi.get(caseId, id, full ? 0 : lastSeq.current, true);
    if (jobRef.current !== id) return; // another job was selected meanwhile
    if (!r.ok) { setErr(r.error); return; }
    setErr('');
    setSnap(r.data);
    setEvents((prev) => {
      const base = full ? [] : prev;
      const seen = new Set(base.map((e) => e.seq));
      const add = r.data.events.filter((e) => !seen.has(e.seq));
      const next = base.concat(add);
      lastSeq.current = next.length ? next[next.length - 1].seq : lastSeq.current;
      return next;
    });
  }, [caseId]);

  // Poll while the job is active. Polling only observes; the job runs whether or not this loop exists.
  useEffect(() => {
    if (!jobId) return;
    lastSeq.current = 0; setEvents([]); setSnap(null);
    void refresh(true);
  }, [jobId, refresh]);
  const active = snap ? isActive(snap.job.state) : false;
  useEffect(() => {
    if (!jobId || !active) return;
    const t = setInterval(() => { void refresh(false); }, POLL_MS);
    return () => clearInterval(t);
  }, [jobId, active, refresh]);

  const act = async (name: string, fn: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, after?: (d: unknown) => void) => {
    setBusy(name); setErr(''); setMsg('');
    const r = await fn();
    setBusy('');
    if (!r.ok) { setErr(r.error); return; }
    after?.(r.data);
    await refresh(false);
  };

  const run = () => act('run', () => jobsApi.run(caseId as string, newRunId()), (d) => {
    const x = d as { jobId: string; duplicate: boolean; skipped: { fileName: string; reason: string }[] };
    setJobId(x.jobId); setJobs((j) => (j.some((q) => q.id === x.jobId) ? j : [{ id: x.jobId, case_id: caseId as string, state: 'queued' } as JobRow, ...j]));
    setMsg(`Job ${x.jobId} accepted and saved on the server. It will keep running if you close this page.${x.skipped.length ? ` ${x.skipped.length} file(s) are not processed by the background worker (see the register).` : ''}`);
  });
  const stop = () => act('stop', () => jobsApi.stop(caseId as string, jobId as string), (d) => setMsg((d as { state: string }).state === 'stopping' ? 'Stop requested. The job shows "Stopping" until the worker acknowledges it. Completed checkpoints are kept.' : 'Stopped. Completed checkpoints were kept.'));
  const resume = () => act('resume', () => jobsApi.resume(caseId as string, jobId as string), (d) => { const x = d as { jobId: string; reused: number; queued: number; invalidated: number }; setJobId(x.jobId); setMsg(`Resumed as a new job: ${x.reused} compatible task(s) reused, ${x.queued} to run, ${x.invalidated} invalidated by changed or removed files. The interrupted run is kept separately.`); });
  const retry = () => act('retry', () => jobsApi.retry(caseId as string, jobId as string), (d) => setMsg(`${(d as { requeued: number }).requeued} failed task(s) re-queued. Completed work was kept.`));

  const tasks = useMemo(() => snap?.tasks ?? [], [snap]);
  const prog = useMemo(() => (snap ? summariseProgress(snap.job, tasks, now || Date.parse(snap.serverTime)) : null), [snap, tasks, now]);
  const results = useMemo(() => { const m: Record<string, TaskResult | undefined> = {}; for (const t of tasks) if (t.result) m[t.doc_id] = t.result as TaskResult; return m; }, [tasks]);
  const register = useMemo<RegisterRow[]>(() => buildRegister(tasks, results), [tasks, results]);
  const geo = useMemo(() => assembleGeometry(events), [events]);
  const state = (snap?.job.state ?? null) as DisplayState | null;
  const sel = register.find((r) => r.docId === selectedDoc) ?? null;
  const counterpart = sel?.counterpart ? register.find((r) => r.fileName === sel.counterpart) ?? null : null;
  const receiving = active && !!sel && tasks.some((t) => t.doc_id === sel.docId && t.status === 'running');

  // Replay re-reveals layers that were ALREADY processed, in the order they arrived. It is visual only and never live.
  const selLayerOrder = useMemo(() => (sel && geo[sel.docId] ? Object.keys(geo[sel.docId].layers) : []), [sel, geo]);
  useEffect(() => {
    if (!replay) return;
    if (replayCount >= selLayerOrder.length) { setReplay(false); return; }
    const t = setTimeout(() => setReplayCount((n) => n + 1), 700);
    return () => clearTimeout(t);
  }, [replay, replayCount, selLayerOrder.length]);
  const startReplay = () => { setReplayCount(0); setReplay(true); };
  const primaryLayers = useMemo(() => {
    if (!sel || !geo[sel.docId]) return {};
    if (!replay) return geo[sel.docId].layers;
    const keep = new Set(selLayerOrder.slice(0, replayCount));
    return Object.fromEntries(Object.entries(geo[sel.docId].layers).filter(([k]) => keep.has(k)));
  }, [sel, geo, replay, replayCount, selLayerOrder]);

  const connected = worker?.mode === 'remote';
  const canRun = !!caseId && !caseId.startsWith('session-') && !busy && !(state && isActive(state));
  const canStop = !!state && (state === 'queued' || state === 'running');
  const canResume = !!state && (state === 'stopped' || state === 'failed' || state === 'partial');
  const canRetry = !!state && !isActive(state) && (prog?.failed ?? 0) > 0;

  return (
    <section aria-label="Background processing" className="space-y-3 rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h3 className="text-lg font-semibold text-foreground">Background processing</h3>
          <p className="text-sm text-muted-foreground">Accepted jobs run on a server-side queue, independent of this page. Closing the page, losing connection or sleeping your computer does not stop an accepted job; reopening this PVR reconnects to it and its saved results.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void run()} disabled={!canRun} className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground">{busy === 'run' ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Play size={15} aria-hidden />}Run analysis</button>
          <button type="button" onClick={() => void stop()} disabled={!canStop || !!busy} className="inline-flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"><Square size={14} aria-hidden />Stop processing</button>
          <button type="button" onClick={() => void resume()} disabled={!canResume || !!busy} className="inline-flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"><RotateCcw size={14} aria-hidden />Resume processing</button>
          <button type="button" onClick={() => void retry()} disabled={!canRetry || !!busy} className="inline-flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"><RefreshCw size={14} aria-hidden />Retry failed tasks</button>
        </div>
      </div>

      {worker && !connected ? (
        <p role="status" className="flex items-start gap-2 rounded-md border border-warning bg-warning/10 px-3 py-2 text-sm text-foreground"><AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden /><span><span className="font-semibold">Processing worker not connected.</span> PROCESSING_WORKER_URL is not configured, so no worker is attached. Jobs are saved in the database queue and will wait there; nothing will run them until the worker in <code>services/processing-worker</code> is deployed with the same database credentials. They are not lost and will start when a worker connects.</span></p>
      ) : null}
      {!caseId || caseId.startsWith('session-') ? <p role="status" className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">Background processing needs a case saved on the server. This case is held in this browser only, so it cannot be processed in the background.</p> : null}
      {err ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p> : null}
      {msg ? <p role="status" className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground">{msg}</p> : null}

      {jobs.length > 1 ? (
        <label className="flex items-center gap-2 text-sm text-foreground">Run
          <select value={jobId ?? ''} onChange={(e) => setJobId(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1 text-sm">
            {jobs.map((j) => <option key={j.id} value={j.id}>{j.id}{j.resumed_from ? ' (resumed)' : ''} · {STATE_LABEL[j.state as DisplayState] ?? j.state}</option>)}
          </select>
          <span className="text-xs text-muted-foreground">Earlier and interrupted runs stay separate from the current one.</span>
        </label>
      ) : null}

      {snap && prog && state ? (
        <div className="space-y-3">
          <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-5">
            <div className="rounded-md border border-border p-2"><p className="text-xs text-muted-foreground">Status</p><p className="font-semibold text-foreground" aria-live="polite">{STATE_LABEL[state] ?? state}</p>{state === 'stopping' ? <p className="text-xs text-muted-foreground">Waiting for the worker to acknowledge the stop.</p> : null}</div>
            <div className="rounded-md border border-border p-2"><p className="text-xs text-muted-foreground">Tasks</p><p className="font-data text-foreground">{prog.completed + prog.partial + prog.reused} of {prog.totalTasks} finished</p><p className="text-xs text-muted-foreground">{prog.reused} reused · {prog.running} running · {prog.queued} queued</p></div>
            <div className="rounded-md border border-border p-2"><p className="text-xs text-muted-foreground">Failures</p><p className={`font-data ${prog.failed ? 'text-destructive' : 'text-foreground'}`}>{prog.failed} failed · {prog.cancelled} cancelled</p></div>
            <div className="rounded-md border border-border p-2"><p className="text-xs text-muted-foreground">Elapsed</p><p className="font-data text-foreground">{fmtDuration(prog.elapsedMs)}</p></div>
            <div className="rounded-md border border-border p-2"><p className="text-xs text-muted-foreground">Last update</p><p className="font-data text-foreground">{prog.lastUpdate ? new Date(prog.lastUpdate).toLocaleTimeString('en-GB') : '—'}</p>{prog.heartbeatAgeMs !== null ? <p className="text-xs text-muted-foreground">Worker heartbeat {fmtDuration(prog.heartbeatAgeMs)} ago</p> : null}</div>
          </div>
          {prog.stalled ? <p role="status" className="flex items-start gap-2 rounded-md border border-warning bg-warning/10 px-3 py-2 text-sm"><AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />The worker has not sent a heartbeat for {fmtDuration(prog.heartbeatAgeMs)}. If it has stopped, its task is reclaimed automatically when the lease expires and another worker will continue it.</p> : null}
          {snap.job.resumed_from ? <p className="text-xs text-muted-foreground">Resumed from <span className="font-data">{snap.job.resumed_from}</span>. Config {snap.job.config_version}.</p> : <p className="text-xs text-muted-foreground">Run <span className="font-data">{snap.job.run_id}</span> · config {snap.job.config_version} · {Object.keys(snap.job.source_hashes ?? {}).length} source file hash(es) recorded.</p>}
          {prog.fractionDone === null ? <p className="text-xs text-muted-foreground">Total work is not yet known, so no percentage is shown.</p> : null}

          <div>
            <h4 className="text-sm font-semibold text-foreground">Progress by document and stage</h4>
            <ul className="mt-1 divide-y divide-border rounded border border-border text-sm">
              {prog.perDocument.map((d) => (
                <li key={d.docId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
                  <span className="min-w-0 truncate font-medium text-foreground">{d.fileName}</span>
                  <span className="flex flex-wrap gap-3">{d.stages.map((s) => (
                    <span key={s.stage} className={`inline-flex items-center gap-1 text-xs ${tone(s.status)}`} title={s.error ?? s.detail ?? ''}>
                      {s.status === 'running' ? <Loader2 size={12} className="animate-spin" aria-hidden /> : s.status === 'completed' || s.status === 'reused' ? <CheckCircle2 size={12} aria-hidden /> : s.status === 'failed' ? <AlertTriangle size={12} aria-hidden /> : <CircleDashed size={12} aria-hidden />}
                      {s.stage}: {s.status === 'reused' ? 'reused from earlier run' : s.status}{s.attempts > 1 ? ` (attempt ${s.attempts})` : ''}
                    </span>
                  ))}</span>
                </li>
              ))}
              {prog.perDocument.length === 0 ? <li className="px-3 py-2 text-muted-foreground">No tasks were created.</li> : null}
            </ul>
          </div>

          <div>
            <h4 className="text-sm font-semibold text-foreground">Drawing register <span className="text-xs font-normal text-muted-foreground">({register.length} document{register.length === 1 ? '' : 's'} in this run)</span></h4>
            <p className="text-xs text-muted-foreground">Every included file is listed, including drawings with no detected change and files that could not be processed. Pairing is inferred from file names and is stated as such.</p>
            <div className="mt-1 overflow-x-auto rounded border border-border">
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-2 py-1.5">Drawing</th><th className="px-2 py-1.5">Role / pairing</th><th className="px-2 py-1.5">Status</th><th className="px-2 py-1.5">Units / scale</th><th className="px-2 py-1.5">Layers</th><th className="px-2 py-1.5">Processed types</th><th className="px-2 py-1.5">Not processed</th><th className="px-2 py-1.5">Changes</th><th className="px-2 py-1.5" /></tr></thead>
                <tbody>
                  {register.map((r) => (
                    <tr key={r.docId} className={`border-t border-border align-top ${selectedDoc === r.docId ? 'bg-primary/5' : ''}`}>
                      <td className="px-2 py-1.5"><p className="font-medium text-foreground">{r.fileName}</p><p className="font-data text-[11px] text-muted-foreground">{r.format}{r.sha256 ? ` · ${r.sha256.slice(0, 10)}…` : ''}{r.converter ? ` · via ${r.converter}` : ''}</p></td>
                      <td className="px-2 py-1.5 text-xs text-muted-foreground">{r.role === 'unpaired' ? <span className="text-foreground">Unpaired</span> : <span className="text-foreground">{r.role === 'original' ? 'Original' : 'Revised'}</span>}{r.counterpart ? <> ↔ {r.counterpart}</> : null}</td>
                      <td className="px-2 py-1.5"><span className={`rounded px-1.5 py-0.5 text-xs font-medium ${r.status === 'processed' ? 'bg-success/15 text-success' : r.status === 'partial' ? 'bg-warning/20 text-foreground' : r.status === 'failed' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}`}>{r.statusLabel}</span>{r.reason ? <p className="mt-0.5 max-w-[16rem] text-xs text-destructive">{r.reason}</p> : null}</td>
                      <td className="px-2 py-1.5 text-xs text-muted-foreground">{r.unit ?? '—'}<br />{r.scale}</td>
                      <td className="px-2 py-1.5 font-data text-xs">{r.layers || '—'}</td>
                      <td className="px-2 py-1.5 text-xs text-muted-foreground">{r.processedTypes}</td>
                      <td className="px-2 py-1.5 text-xs text-muted-foreground">{r.skippedTypes.length ? r.skippedTypes.map((s) => `${s.name}×${s.count}`).join(', ') : '—'}{r.xrefs.length ? <p className="text-foreground">XREF: {r.xrefs.join(', ')}</p> : null}</td>
                      <td className="px-2 py-1.5 font-data text-xs">{r.changeCount || (r.status === 'processed' || r.status === 'partial' ? 'none detected' : '—')}</td>
                      <td className="px-2 py-1.5"><button type="button" onClick={() => { setSelectedDoc(r.docId); setReplay(false); }} className="rounded border border-input px-2 py-1 text-xs hover:bg-muted">Open</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {register.some((r) => r.limits.length > 0) ? (
              <details className="mt-1 text-xs"><summary className="cursor-pointer font-medium text-foreground">Coverage limits and explanations</summary>
                <ul className="mt-1 space-y-1">{register.filter((r) => r.limits.length).map((r) => <li key={r.docId}><span className="font-medium text-foreground">{r.fileName}:</span> <span className="text-muted-foreground">{r.limits.join(' ')}</span></li>)}</ul>
              </details>
            ) : null}
          </div>

          {sel ? (
            <div>
              {!sel.hasGeometry ? (
                <p className="flex items-start gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"><Info size={16} className="mt-0.5 shrink-0" aria-hidden />{sel.status === 'not_processed' || sel.status === 'failed' ? `${sel.statusLabel}. No geometry was produced for ${sel.fileName}, so there is nothing to draw. The original file is still stored.` : sel.status === 'pending' ? `${sel.fileName} has not produced geometry yet.` : `${sel.fileName} contains no geometry of a supported type.`}</p>
              ) : (
                <PersistedDrawingViewer
                  title={`Drawing viewer: ${sel.fileName}`}
                  primary={geo[sel.docId] ? { layers: primaryLayers, delivered: geo[sel.docId].delivered, total: geo[sel.docId].total, extents: geo[sel.docId].extents } : null}
                  primaryName={sel.fileName}
                  secondary={counterpart && geo[counterpart.docId] ? { layers: geo[counterpart.docId].layers, delivered: geo[counterpart.docId].delivered, total: geo[counterpart.docId].total, extents: geo[counterpart.docId].extents } : null}
                  secondaryName={counterpart?.fileName ?? ''}
                  coverage={results[sel.docId]?.coverage}
                  preview={previewKind({ receiving, coverage: results[sel.docId]?.coverage, hasGeometry: !!geo[sel.docId], replaying: replay })}
                />
              )}
              {sel.hasGeometry && !receiving && selLayerOrder.length > 1 ? (
                <div className="mt-1 flex items-center gap-2">
                  <button type="button" onClick={startReplay} disabled={replay} className="rounded border border-input px-2 py-1 text-xs hover:bg-muted disabled:opacity-50">Replay recorded layer order</button>
                  {replay ? <button type="button" onClick={() => setReplay(false)} className="rounded border border-input px-2 py-1 text-xs hover:bg-muted">Show all</button> : null}
                  <span className="text-xs text-muted-foreground">Replay re-reveals geometry that was already processed. It is not live processing.</span>
                </div>
              ) : null}
            </div>
          ) : register.length > 0 ? <p className="text-xs text-muted-foreground">Select “Open” on any row to view its processed geometry, including drawings with no detected change.</p> : null}

          <details className="text-xs"><summary className="cursor-pointer font-medium text-foreground">Event log ({events.filter((e) => e.kind !== 'geometry').length})</summary>
            <ol className="mt-1 max-h-48 space-y-0.5 overflow-auto pl-4">{events.filter((e) => e.kind !== 'geometry').slice(-80).map((e) => <li key={e.seq} className="list-decimal text-muted-foreground"><span className="font-data">{new Date(e.created_at).toLocaleTimeString('en-GB')}</span> · {e.kind.replace(/_/g, ' ')}: {e.detail}</li>)}</ol>
          </details>
        </div>
      ) : caseId && !caseId.startsWith('session-') && !err ? <p className="text-sm text-muted-foreground">{jobs.length === 0 ? 'No analysis has been run for this case yet.' : 'Loading the saved job…'}</p> : null}
    </section>
  );
}

'use client';

import React, { useEffect, useMemo, useReducer, useState } from 'react';
import { Check, CircleDashed, Loader2, Pause, Play, RotateCcw, SkipForward, X, AlertTriangle } from 'lucide-react';
import { STAGES, coverageOf, initialPlayback, playbackLabel, playbackReducer, visibleLayerCount, type RunState } from '@/lib/drawings/runState';

interface Props {
  run: RunState;
  /** Layers in the finished geometry, used only for a Replay after the run has completed. */
  finishedLayers: { name: string; count: number }[];
  onCancel: () => void;
  /** True while a Replay of a completed run is in progress. */
  replaying: boolean;
  onReplayStart: () => void;
  onReplayStop: () => void;
  /** Layers the viewer should reveal during a Replay. null = show everything (live or finished). */
  onReveal: (layers: string[] | null) => void;
}

const useReducedMotion = (): boolean => {
  const [r, setR] = React.useState(false);
  useEffect(() => { const m = window.matchMedia('(prefers-reduced-motion: reduce)'); setR(m.matches); const h = () => setR(m.matches); m.addEventListener('change', h); return () => m.removeEventListener('change', h); }, []);
  return r;
};

/**
 * Status for a processing run. While the run is live the picture is whatever geometry has actually arrived, so there
 * is no timer here. The only timed reveal is an explicit Replay of a completed run, and it is labelled as one.
 */
export default function LiveAnalysisPreview({ run, finishedLayers, onCancel, replaying, onReplayStart, onReplayStop, onReveal }: Props) {
  const reduced = useReducedMotion();
  const [pb, dispatch] = useReducer(playbackReducer, reduced, initialPlayback);
  const running = run.status === 'running';
  const files = Object.values(run.live);

  // A replay starts from the beginning each time it is requested.
  useEffect(() => { if (replaying) dispatch({ type: 'replay' }); }, [replaying]);
  useEffect(() => {
    if (!replaying || pb.paused || pb.skipped || reduced) return;
    if (pb.position >= finishedLayers.length) return;
    const t = window.setTimeout(() => dispatch({ type: 'tick', available: finishedLayers.length }), 350);
    return () => window.clearTimeout(t);
  }, [replaying, pb.paused, pb.skipped, pb.position, finishedLayers.length, reduced]);
  useEffect(() => { if (replaying && reduced) dispatch({ type: 'skip', available: finishedLayers.length }); }, [replaying, reduced, finishedLayers.length]);

  const shown = visibleLayerCount(pb, finishedLayers.length);
  const revealed = useMemo(() => finishedLayers.slice(0, shown).map((l) => l.name), [finishedLayers, shown]);
  useEffect(() => { onReveal(replaying ? revealed : null); }, [replaying, revealed, onReveal]);
  useEffect(() => { if (replaying && shown >= finishedLayers.length && finishedLayers.length > 0) { /* stay on the finished picture; user ends the replay */ } }, [replaying, shown, finishedLayers.length]);

  if (run.status === 'idle') return null;
  const label = playbackLabel(run, replaying);

  return (
    <section aria-label="Live drawing analysis" className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
            {running ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden /> : run.status === 'complete' ? <Check size={16} className="text-success" aria-hidden /> : run.status === 'cancelled' ? <X size={16} className="text-muted-foreground" aria-hidden /> : <AlertTriangle size={16} className="text-warning" aria-hidden />}
            Drawing analysis · {running ? 'in progress' : run.status}
            {replaying ? <span className="rounded bg-muted px-2 py-0.5 text-xs font-semibold text-foreground">Replay</span> : null}
          </h3>
          <p className="text-xs text-muted-foreground" role="status">{label}. Drawn geometry is what the parser delivered; only the Measurement stage produces quantities.</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {replaying ? (
            <>
              {pb.paused ? <button type="button" onClick={() => dispatch({ type: 'resume' })} className="inline-flex items-center gap-1 rounded-md border border-input px-2.5 py-1.5 text-sm hover:bg-muted"><Play size={14} aria-hidden />Resume replay</button> : <button type="button" onClick={() => dispatch({ type: 'pause' })} disabled={pb.skipped || shown >= finishedLayers.length} className="inline-flex items-center gap-1 rounded-md border border-input px-2.5 py-1.5 text-sm hover:bg-muted disabled:opacity-50"><Pause size={14} aria-hidden />Pause replay</button>}
              <button type="button" onClick={() => dispatch({ type: 'skip', available: finishedLayers.length })} disabled={pb.skipped} className="inline-flex items-center gap-1 rounded-md border border-input px-2.5 py-1.5 text-sm hover:bg-muted disabled:opacity-50"><SkipForward size={14} aria-hidden />Skip to end</button>
              <button type="button" onClick={onReplayStop} className="inline-flex items-center gap-1 rounded-md border border-input px-2.5 py-1.5 text-sm hover:bg-muted"><X size={14} aria-hidden />End replay</button>
            </>
          ) : (
            <button type="button" onClick={onReplayStart} disabled={running || run.status !== 'complete' || finishedLayers.length === 0} className="inline-flex items-center gap-1 rounded-md border border-input px-2.5 py-1.5 text-sm hover:bg-muted disabled:opacity-50"><RotateCcw size={14} aria-hidden />Replay completed processing</button>
          )}
          {running ? <button type="button" onClick={onCancel} className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2.5 py-1.5 text-sm text-destructive hover:bg-destructive/10"><X size={14} aria-hidden />Cancel analysis</button> : null}
        </div>
      </div>

      <ol className="mt-3 grid gap-1.5 sm:grid-cols-4 lg:grid-cols-7" aria-label="Processing stages">
        {STAGES.map((s) => {
          const st = run.stages[s.id];
          return (
            <li key={s.id} className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs ${st === 'done' ? 'border-success/40 bg-success/10 text-foreground' : st === 'active' ? 'border-accent bg-accent/10 text-foreground' : st === 'failed' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border text-muted-foreground'}`}>
              {st === 'done' ? <Check size={12} aria-hidden /> : st === 'active' ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden /> : st === 'failed' ? <AlertTriangle size={12} aria-hidden /> : <CircleDashed size={12} aria-hidden />}
              <span>{s.label}</span><span className="sr-only">{st}</span>
            </li>
          );
        })}
      </ol>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Geometry received</h4>
          {files.length === 0 ? <p className="text-sm text-muted-foreground">{running ? (run.stages.parsing === 'active' ? 'Parsing: the file is read as a whole before any geometry is available.' : 'Waiting for the first geometry batch…') : 'No vector geometry was delivered. For a flattened PDF or scan there are no layers.'}</p> : (
            <ul className="mt-1 space-y-2 text-sm">
              {files.map((f) => {
                const cov = coverageOf(f);
                return (
                  <li key={f.fileName}>
                    <p className="flex items-center justify-between gap-2"><span className="truncate font-medium text-foreground">{f.fileName}</span><span className="font-data text-xs text-muted-foreground">{f.delivered}{f.total ? ` / ${f.total}` : ''} entities{cov.pct !== null ? ` · ${cov.pct}%` : ''}</span></p>
                    <p className="text-xs text-muted-foreground">Units: {f.unit ?? 'not yet known'}{f.extents ? ` · extent ${(f.extents.maxX - f.extents.minX).toFixed(1)} × ${(f.extents.maxY - f.extents.minY).toFixed(1)} drawing units` : ''}</p>
                    <ul className="mt-1 max-h-28 space-y-0.5 overflow-auto">
                      {f.layerOrder.map((l) => <li key={l} className="flex items-center justify-between gap-2 rounded bg-muted/60 px-2 py-0.5 text-foreground"><span className="truncate">{l}</span><span className="font-data text-xs">{f.layers[l].entities.length} entities · {f.layers[l].batches} batch(es)</span></li>)}
                    </ul>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div>
          <h4 className="text-sm font-semibold text-foreground">Processing events</h4>
          <ol className="mt-1 max-h-40 space-y-0.5 overflow-auto text-xs text-muted-foreground" aria-live="polite">
            {run.events.slice(-40).map((e) => <li key={e.seq}><span className="font-medium text-foreground">{e.stage}</span> · {e.status} · {e.detail}</li>)}
            {run.events.length === 0 ? <li>No events yet.</li> : null}
          </ol>
          {run.ignored > 0 ? <p className="mt-1 text-xs text-muted-foreground">{run.ignored} late event(s) from a cancelled run or another case were ignored.</p> : null}
        </div>
      </div>
    </section>
  );
}

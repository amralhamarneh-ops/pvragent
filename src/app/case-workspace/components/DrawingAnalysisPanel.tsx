'use client';

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AlertTriangle, Play } from 'lucide-react';
import { analyseDocuments, type AnalysisOutput, type InputFile } from '@/lib/drawings/analyse';
import { evidenceForObject } from '@/lib/drawings/compare';
import { loadCapabilities, serverExtractor, type ExtractionCapabilities } from '@/lib/drawings/extractClient';
import { initialRun, runReducer } from '@/lib/drawings/runState';
import { buildSnapshot, loadSnapshot, nextVersion, saveSnapshot, snapshotStatus, type AnalysisSnapshot } from '@/lib/drawings/snapshot';
import { buildLiveModel, buildViewModel, type ViewModel } from '@/lib/drawings/viewModel';
import type { ReconciledChange } from '@/lib/drawings/types';
import LiveAnalysisPreview from '@/app/case-workspace/components/LiveAnalysisPreview';
import RealDrawingViewer from '@/app/case-workspace/components/RealDrawingViewer';

export interface PanelDoc { id: string; name: string; sha256: string; role: string; bytes: Uint8Array | null }

interface Props {
  /** Stable id of the open case/draft. Every event and result is tied to it. */
  scopeId: string;
  documents: PanelDoc[];
  narrative: string;
  /** Called with the finished output so the surrounding flow can use the same result (changes, extracted text, schedules). */
  onComplete?: (out: AnalysisOutput) => void;
}

const newRunId = () => `run-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;

/**
 * Real drawing analysis for the open case: runs the actual parsers, streams their events and geometry batches into the
 * viewer as they arrive, and saves a new version of the result. It reads the SAME document registry as the rest of the
 * flow (documents prop) and never uses demo drawings.
 */
export default function DrawingAnalysisPanel({ scopeId, documents, narrative, onComplete }: Props) {
  const [run, dispatch] = useReducer(runReducer, undefined, initialRun);
  const [out, setOut] = useState<AnalysisOutput | null>(null);
  const [snap, setSnap] = useState<AnalysisSnapshot | null>(null);
  const [caps, setCaps] = useState<ExtractionCapabilities | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [revealed, setRevealed] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const scopeRef = useRef(scopeId);
  scopeRef.current = scopeId;
  const activeRun = useRef<string | null>(null);

  // A different case invalidates everything held for the previous one, and cancels its run.
  useEffect(() => {
    abortRef.current?.abort(); abortRef.current = null; activeRun.current = null;
    dispatch({ type: 'reset' }); setOut(null); setSelected(null); setReplaying(false); setRevealed(null); setError('');
    setSnap(loadSnapshot(scopeId));
  }, [scopeId]);
  useEffect(() => { const ac = new AbortController(); void loadCapabilities(ac.signal).then(setCaps); return () => ac.abort(); }, []);
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const usable = useMemo(() => documents.filter((d) => ['drawings', 'pvr', 'correspondence', 'schedule', 'contract', 'reference', 'site'].includes(d.role)), [documents]);
  const status = useMemo(() => (snap ? snapshotStatus(snap, documents.map((d) => ({ id: d.id, sha256: d.sha256, role: d.role })), narrative) : null), [snap, documents, narrative]);

  // Cancel a running analysis whose inputs just changed: its output would be obsolete.
  const inputKey = useMemo(() => usable.map((d) => `${d.id}:${d.sha256}:${d.role}`).join('|') + `#${narrative.length}`, [usable, narrative]);
  const lastKey = useRef(inputKey);
  useEffect(() => {
    if (lastKey.current !== inputKey && abortRef.current && activeRun.current) {
      abortRef.current.abort(); dispatch({ type: 'cancel', runId: activeRun.current, caseId: scopeRef.current }); activeRun.current = null;
    }
    lastKey.current = inputKey;
  }, [inputKey]);

  const start = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController(); abortRef.current = ac;
    const runId = newRunId(); const caseId = scopeRef.current;
    activeRun.current = runId; setError(''); setOut(null); setSelected(null); setReplaying(false); setRevealed(null);
    dispatch({ type: 'start', runId, caseId, at: Date.now() });
    const files: InputFile[] = usable.map((d) => ({ name: d.name, bytes: d.bytes, role: d.role as InputFile['role'], docId: d.id }));
    try {
      const result = await analyseDocuments({
        files, narrative, runId, caseId, signal: ac.signal, extractor: serverExtractor,
        capabilities: caps ? { ocrScannedPdf: caps.ocrScannedPdf, dwg: caps.dwg } : null,
        // Events and geometry batches carry this run/case; the reducer discards anything that does not match the active run.
        onEvent: (event) => { if (activeRun.current === runId) dispatch({ type: 'event', event }); },
      });
      if (ac.signal.aborted || activeRun.current !== runId || scopeRef.current !== caseId) return; // cancelled or superseded
      setOut(result);
      dispatch({ type: 'complete', runId, caseId });
      const s = buildSnapshot(caseId, runId, result, usable.map((d) => ({ id: d.id, name: d.name, sha256: d.sha256, role: d.role })), narrative, nextVersion(caseId));
      const saved = saveSnapshot(s); setSnap(s);
      if (!saved) setError('The analysis finished but could not be saved in this browser (storage full). It will need to be re-run after reopening.');
      onComplete?.(result);
    } catch (e) {
      if (ac.signal.aborted || activeRun.current !== runId) return;
      dispatch({ type: 'fail', runId, caseId, message: e instanceof Error ? e.message : 'failed' });
      setError(`The analysis failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  }, [usable, narrative, caps, onComplete]);

  const cancel = useCallback(() => {
    if (!activeRun.current) return;
    abortRef.current?.abort(); dispatch({ type: 'cancel', runId: activeRun.current, caseId: scopeRef.current }); activeRun.current = null;
  }, []);

  // The comparison model uses the SAME per-object relocation evidence as the measurement, so picture and numbers agree.
  const models = useMemo<ViewModel[]>(() => {
    if (!out) return [];
    const resolver = (layer: string) => evidenceForObject(layer, [], out.relocationSentences);
    return out.pairs.filter((p) => p.validated).map((p) => buildViewModel(p, out.changes, resolver));
  }, [out]);
  const [pairIdx, setPairIdx] = useState(0);
  useEffect(() => { setPairIdx(0); }, [out]);
  const model = models[pairIdx] ?? null;
  const running = run.status === 'running';
  // Geometry drawn from received batches while the run is live (and after, until a comparison model exists).
  const live = useMemo(() => (Object.keys(run.live).length ? buildLiveModel(run.live) : null), [run.live, run.geometryVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const finishedLayers = useMemo(() => (model ? model.layers.map((l) => ({ name: l.name, count: l.total })) : []), [model]);
  const startReplay = useCallback(() => setReplaying(true), []);
  const stopReplay = useCallback(() => { setReplaying(false); setRevealed(null); }, []);

  const restoredChanges: ReconciledChange[] = !out && snap && status?.current ? snap.changes : [];
  const driveDrawings = usable.filter((d) => d.role === 'drawings').length;

  return (
    <section aria-label="Drawing analysis" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4 shadow-sm">
        <div className="max-w-2xl">
          <h3 className="text-lg font-semibold text-foreground">Analyse uploaded drawings and documents</h3>
          <p className="text-sm text-muted-foreground">Reads your files for real (DXF geometry, PDF/DOCX text, OCR, XER programmes), compares the drawing revisions and measures the changes. {driveDrawings} drawing file(s), {usable.length - driveDrawings} other document(s) in this PVR.</p>
          {snap ? <p className="mt-1 text-xs text-muted-foreground">Saved analysis version {snap.version}. A re-run adds a new version; earlier versions are kept and anything built from them is marked out of date.</p> : null}
          {caps && !caps.dwg.configured ? <p className="mt-1 text-xs text-muted-foreground">DWG conversion is not configured on this deployment ({caps.dwg.requirement}). Upload ASCII DXF to measure drawings.</p> : null}
          {caps && !caps.ocrScannedPdf ? <p className="mt-1 text-xs text-muted-foreground">Scanned PDF pages cannot be OCR’d here (rasteriser unavailable); images and text PDFs are read.</p> : null}
        </div>
        <button type="button" onClick={() => void start()} disabled={usable.length === 0 || running} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"><Play size={16} aria-hidden />{running ? 'Analysing…' : out || snap ? 'Re-run analysis' : 'Run analysis'}</button>
      </div>
      {error ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-2 text-destructive">{error}</p> : null}
      {status && !status.current && !out ? <p role="status" className="flex items-start gap-2 rounded-md border border-warning bg-warning/10 px-4 py-2 text-sm text-foreground"><AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden /><span>The saved analysis (v{snap!.version}, {new Date(snap!.savedAt).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC) is out of date: {status.reasons.join(' ')} Re-run the analysis to refresh the results. Dependent mappings and calculations built from it are out of date until then; they are kept as earlier versions.</span></p> : null}

      <LiveAnalysisPreview run={run} finishedLayers={finishedLayers} onCancel={cancel} replaying={replaying} onReplayStart={startReplay} onReplayStop={stopReplay} onReveal={setRevealed} />

      {models.length > 1 ? <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Drawing pairs">{models.map((m, i) => <button key={m.drawingNumber + i} type="button" role="tab" aria-selected={i === pairIdx} onClick={() => setPairIdx(i)} className={`rounded border px-2.5 py-1 text-sm ${i === pairIdx ? 'border-primary bg-primary text-primary-foreground' : 'border-input hover:bg-muted'}`}>{m.drawingNumber || `Pair ${i + 1}`}</button>)}</div> : null}
      {(model || live) && run.status !== 'idle' ? (
        <RealDrawingViewer
          model={model && out ? model : null}
          live={model && out ? null : live}
          streaming={running}
          changes={out ? out.changes : []}
          selectedChangeId={selected}
          onSelectChange={setSelected}
          revealedLayers={replaying ? revealed : null}
          replaying={replaying}
        />
      ) : null}

      {!out && restoredChanges.length > 0 ? (
        <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
          <h3 className="text-base font-semibold text-foreground">Saved results (v{snap!.version}) from {new Date(snap!.savedAt).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC <span className="text-sm font-normal text-muted-foreground">(documents unchanged since)</span></h3>
          <ul className="mt-2 divide-y divide-border text-sm">{restoredChanges.map((c) => <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5"><span className="text-foreground">{c.component} <span className="text-muted-foreground">· {c.description}</span></span><span className="font-data text-foreground">{c.changeQty} {c.unit === 'm2' ? 'm²' : c.unit}</span></li>)}</ul>
          <p className="mt-2 text-xs text-muted-foreground">Re-run the analysis to redraw the drawings in the viewer (geometry is re-read from the stored original files).</p>
        </div>
      ) : null}

      {out && out.documents.length > 0 ? (
        <details className="rounded-lg border border-border bg-card p-4 shadow-sm">
          <summary className="cursor-pointer text-base font-semibold text-foreground">Extracted text with page references ({out.documents.length})</summary>
          <ul className="mt-2 space-y-2 text-sm">{out.documents.map((d) => <li key={d.name}><p className="font-medium text-foreground">{d.name} <span className="text-xs font-normal text-muted-foreground">· {d.method} · {d.pages.length} page(s)/section(s){d.truncated ? ' · truncated' : ''}</span></p>{d.limitation ? <p className="text-xs text-warning">{d.limitation}</p> : null}<ol className="mt-1 max-h-40 space-y-1 overflow-auto">{d.pages.map((p) => <li key={p.page} className="rounded bg-background px-2 py-1 text-xs text-muted-foreground"><span className="font-semibold text-foreground">p.{p.page}{p.confidence !== undefined ? ` (OCR ${p.confidence}%)` : ''}:</span> {p.text.slice(0, 280) || '(no text)'}{p.text.length > 280 ? '…' : ''}</li>)}</ol></li>)}</ul>
        </details>
      ) : null}
      {out && out.schedules.length > 0 ? (
        <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
          <h3 className="text-base font-semibold text-foreground">Programmes read from XER</h3>
          <ul className="mt-1 text-sm text-muted-foreground">{out.schedules.map((s) => <li key={s.fileName}>{s.fileName}: {s.model.activityCount} activities, {s.model.relationships.length} relationships{s.model.dataDate ? `, data date ${s.model.dataDate}` : ''}</li>)}</ul>
        </div>
      ) : null}
    </section>
  );
}

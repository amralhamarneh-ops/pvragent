'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Play } from 'lucide-react';
import { type AnalysisOutput } from '@/lib/drawings/analyse';
import { evidenceForObject } from '@/lib/drawings/compare';
import { loadCapabilities, type ExtractionCapabilities } from '@/lib/drawings/extractClient';
import { type RunState } from '@/lib/drawings/runState';
import { loadSnapshot, snapshotStatus } from '@/lib/drawings/snapshot';
import { buildLiveModel, buildViewModel, type ViewModel } from '@/lib/drawings/viewModel';
import type { ReconciledChange } from '@/lib/drawings/types';
import LiveAnalysisPreview from '@/app/case-workspace/components/LiveAnalysisPreview';
import RealDrawingViewer from '@/app/case-workspace/components/RealDrawingViewer';
import DrawingChangeSheets from '@/app/pvr-demo/DrawingChangeSheets';

export interface PanelDoc { id: string; name: string; sha256: string; role: string; bytes: Uint8Array | null }

interface Props {
  /** Stable id of the open case/draft. Every event and result is tied to it. */
  scopeId: string;
  documents: PanelDoc[];
  narrative: string;
  run: RunState;
  out: AnalysisOutput | null;
  streamGeometry: boolean;
  onStreamGeometry: (enabled: boolean) => void;
  onStart: () => void;
  onCancel: () => void;
}

/** The real assessment owns the run; the preview doesn't start a second parser or alter its results. */
export default function DrawingAnalysisPanel({ scopeId, documents, narrative, run, out, streamGeometry, onStreamGeometry, onStart, onCancel }: Props) {
  const [caps, setCaps] = useState<ExtractionCapabilities | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [revealed, setRevealed] = useState<string[] | null>(null);
  useEffect(() => { const ac = new AbortController(); void loadCapabilities(ac.signal).then(setCaps); return () => ac.abort(); }, []);
  useEffect(() => { setSelected(null); setReplaying(false); setRevealed(null); }, [run.runId]);
  const usable = useMemo(() => documents.filter((d) => ['drawings', 'pvr', 'correspondence', 'schedule', 'contract', 'site'].includes(d.role)), [documents]);
  const snap = useMemo(() => loadSnapshot(scopeId), [scopeId, out]);
  const status = useMemo(() => (snap ? snapshotStatus(snap, documents.map((d) => ({ id: d.id, sha256: d.sha256, role: d.role })), narrative) : null), [snap, documents, narrative]);

  // The comparison model uses the SAME per-object relocation evidence as the measurement, so picture and numbers agree.
  const pairs = useMemo(() => out?.pairs.filter((p) => p.validated) ?? [], [out]);
  const [pairIdx, setPairIdx] = useState(0);
  useEffect(() => { setPairIdx(0); }, [out]);
  const pair = pairs[pairIdx] ?? pairs[0];
  const model = useMemo<ViewModel | null>(() => {
    if (!out || !pair) return null;
    const resolver = (layer: string) => evidenceForObject(layer, [], out.relocationSentences);
    return buildViewModel(pair, out.changes, resolver);
  }, [out, pair]);
  const running = run.status === 'running';
  // The canvas/SVG viewer has its own render budget; do not render each large CAD entity four times as sheet previews.
  const canShowSheets = model !== null && model.entities.length <= 2400;
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
        <label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={streamGeometry} disabled={running} onChange={(e) => onStreamGeometry(e.target.checked)} /> Animate geometry while processing <span className="text-xs">(turn off for large drawings)</span></label>
        <button type="button" onClick={onStart} disabled={(usable.length === 0 && narrative.trim().length <= 10) || running} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"><Play size={16} aria-hidden />{running ? 'Analysing…' : out || snap ? 'Re-run analysis' : 'Run analysis'}</button>
      </div>
      {status && !status.current && !out ? <p role="status" className="flex items-start gap-2 rounded-md border border-warning bg-warning/10 px-4 py-2 text-sm text-foreground"><AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden /><span>The saved analysis (v{snap!.version}, {new Date(snap!.savedAt).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC) is out of date: {status.reasons.join(' ')} Re-run the analysis to refresh the results. Dependent mappings and calculations built from it are out of date until then; they are kept as earlier versions.</span></p> : null}

      <LiveAnalysisPreview run={run} finishedLayers={finishedLayers} onCancel={onCancel} replaying={replaying} onReplayStart={startReplay} onReplayStop={stopReplay} onReveal={setRevealed} streamGeometry={streamGeometry} />

      {pairs.length > 1 ? <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Drawing pairs">{pairs.map((p, i) => <button key={p.revised.fileName + i} type="button" role="tab" aria-selected={i === pairIdx} onClick={() => setPairIdx(i)} className={`rounded border px-2.5 py-1 text-sm ${i === pairIdx ? 'border-primary bg-primary text-primary-foreground' : 'border-input hover:bg-muted'}`}>{p.revised.titleBlock?.drawingNumber || `Pair ${i + 1}`}</button>)}</div> : null}
      {model && out && run.status === 'complete' && canShowSheets && !replaying
        ? <DrawingChangeSheets key={pairIdx} model={model} changes={out.changes} /> : null}
      {model && !canShowSheets && !replaying ? <p className="text-sm text-muted-foreground">This pair uses the interactive viewer below: the full-size drawing has too many entities for duplicate side-by-side sheet previews. Switch revisions or choose a highlighted change to inspect it.</p> : null}
      {out && !model && driveDrawings > 0 ? <p role="status" className="rounded-md border border-border bg-card p-3 text-sm text-muted-foreground">
        No verified revision pair with vector geometry was available. Check the drawing revisions and file reading results before using measurements.
      </p> : null}
      {(model || live) && run.status !== 'idle' && (replaying || !canShowSheets) ? (
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

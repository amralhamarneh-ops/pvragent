'use client';

import React, { useMemo, useState } from 'react';
import LiveAnalysisPreview from './LiveAnalysisPreview';
import RealDrawingViewer from './RealDrawingViewer';
import DrawingChangeSheets from '@/app/pvr-demo/DrawingChangeSheets';
import { initialRun, type RunState } from '@/lib/drawings/runState';
import type { SavedDrawingReplay as Replay } from '@/lib/drawings/replay';
import type { ReconciledChange } from '@/lib/drawings/types';

const FINISHED: RunState = { ...initialRun(), status:'complete' };

export default function SavedDrawingReplay({ replay, changes, showSheets = false }: { replay: Replay; changes: ReconciledChange[]; showSheets?: boolean }) {
  const [pairIndex, setPairIndex] = useState(0);
  const [opened, setOpened] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [reveal, setReveal] = useState<string[] | null>(null);
  const [change, setChange] = useState<string | null>(null);
  const model = replay.models[pairIndex] ?? replay.models[0];
  const layers = useMemo(() => model.layers.map((l) => ({name:l.name,count:l.total})), [model]);
  const start = () => {setOpened(true); setReveal([]); setReplaying(true);};
  const stop = () => {setReplaying(false); setReveal(null);};
  return (
    <section aria-label="Saved drawing comparison" className="space-y-3">
      {replay.models.length > 1 ? <label className="flex items-center gap-2 text-sm">Drawing pair
        <select className="rounded border border-input bg-card p-1.5" disabled={replaying} value={pairIndex} onChange={(e) => {setPairIndex(Number(e.target.value)); setChange(null);}}>
          {replay.models.map((m, i) => <option key={i} value={i}>{m.drawingNumber || m.revisedFile} · {m.originalRevision} → {m.revisedRevision}</option>)}
        </select>
      </label> : null}
      {replay.eligiblePairCount > replay.models.length ? <p className="text-sm text-muted-foreground">Replay stored for {replay.models.length} of {replay.eligiblePairCount} drawing pairs. Large pairs are not stored for replay.</p> : null}
      {showSheets && !replaying ? <DrawingChangeSheets key={pairIndex} model={model} changes={changes} /> : null}
      <LiveAnalysisPreview run={FINISHED} finishedLayers={layers} replayOnly onCancel={stop} replaying={replaying} onReplayStart={start} onReplayStop={stop} onReveal={setReveal} />
      {opened && (!showSheets || replaying) ? <RealDrawingViewer model={model} changes={changes} selectedChangeId={change} onSelectChange={setChange} revealedLayers={replaying ? reveal : null} replaying={replaying} /> : null}
    </section>
  );
}

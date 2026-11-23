'use client';

import React, { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import DrawingViewer from '@/app/case-workspace/components/DrawingViewer';
import ConfidenceBar from '@/components/ui/ConfidenceBar';
import { checkAgainstPvr, drawingHeadline } from '@/lib/mapping/drawingEngine';
import type { DrawingChange } from '@/lib/mapping/types';
import type { StageKey } from '@/lib/mapping/useCaseStore';
import type { StageStatus } from '@/lib/mapping/types';

interface DrawingStageProps {
  status: StageStatus;
  changes: DrawingChange[];
  pvrStated: number;
  onChange: (next: DrawingChange[]) => void;
  onRun: () => void;
  running: boolean;
  onEdited: (stage: StageKey) => void;
}

const PILLS = ['Read files', 'Match revisions', 'Detect changes', 'Quantify', 'Assign zone and discipline', 'Check against PVR'];

export default function DrawingStage({ status, changes, pvrStated, onChange, onRun, running, onEdited }: DrawingStageProps) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState('');
  const [editReason, setEditReason] = useState('');
  const [measure, setMeasure] = useState(false);
  const [measured, setMeasured] = useState<number | null>(null);

  const update = (id: string, p: Partial<DrawingChange>) => {
    onChange(changes.map((c) => (c.id === id ? { ...c, ...p } : c)));
    onEdited('drawing');
  };

  if (status === 'not_started' || status === 'running') {
    return (
      <div className="space-y-5">
        <h1 className="text-headline font-semibold text-foreground">{running ? 'The Drawing agent is comparing Rev B to Rev C.' : 'Compare the two drawing revisions and measure the change.'}</h1>
        <p className="max-w-2xl text-muted-foreground">Measurements come from code tools reading the DXF files. The model never produces a quantity.</p>
        <div className="flex flex-wrap gap-2" aria-label="Pipeline">
          {PILLS.map((p) => (
            <span key={p} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-muted-foreground">
              {running ? <Loader2 size={13} className="animate-spin text-accent" /> : null}{p}
            </span>
          ))}
        </div>
        {running ? <div className="space-y-3" aria-hidden><div className="skeleton h-72 rounded-lg" /><div className="skeleton h-14 rounded-lg" /></div> : <button type="button" onClick={onRun} className="rounded-md bg-primary px-5 py-2.5 font-semibold text-primary-foreground hover:opacity-90">Run drawing analysis</button>}
      </div>
    );
  }

  const check = checkAgainstPvr(changes, pvrStated);
  const groups: { type: DrawingChange['type']; title: string }[] = [{ type: 'added', title: 'Added' }, { type: 'removed', title: 'Removed' }, { type: 'modified', title: 'Modified' }];
  const question = changes.find((c) => c.needsQuestion);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2" aria-label="Pipeline complete">
        {PILLS.map((p) => (<span key={p} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground"><Check size={13} className="text-success" />{p}</span>))}
      </div>
      <div>
        <h1 className="text-headline font-semibold text-foreground">{drawingHeadline(changes, 'Rev C')}</h1>
        <p className="mt-1 max-w-2xl text-muted-foreground">Compared Rev B to Rev C. 16 layers read, units confirmed in metres. Tick what belongs in this PVR.</p>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <DrawingViewer changes={changes} focusId={focusId} onFocus={setFocusId} measureMode={measure} onMeasured={(m) => setMeasured(m)} />

        <div className="space-y-4">
          {groups.map((g) => {
            const list = changes.filter((c) => c.type === g.type);
            if (list.length === 0) return null;
            return (
              <section key={g.type} aria-label={g.title}>
                <h2 className="mb-2 font-semibold text-foreground">{g.title}</h2>
                <ul className="space-y-2">
                  {list.map((c) => (
                    <li key={c.id} className={`rounded-lg border p-3.5 ${c.needsQuestion && c.included ? 'border-warning bg-warning/5' : focusId === c.id ? 'border-accent bg-accent/5' : 'border-border bg-card'}`}>
                      <div className="flex items-start gap-3">
                        <input type="checkbox" aria-label={`Include ${c.title}`} checked={c.included} onChange={(e) => update(c.id, { included: e.target.checked })} className="mt-1 h-4 w-4 accent-[var(--primary)]" />
                        <button type="button" onClick={() => setFocusId(c.id)} className="min-w-0 flex-1 text-left">
                          <span className="flex items-start justify-between gap-3">
                            <span className="font-semibold text-foreground">{c.title}</span>
                            <span className="shrink-0 font-data font-semibold text-foreground">{c.type === 'removed' ? '−' : '+'}{c.value.toLocaleString('en-US')} {c.unit}</span>
                          </span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
                            <span>Layer <span className="font-data">{c.layer}</span>, {c.zone}</span>
                            <ConfidenceBar value={c.confidence} />
                          </span>
                          <span className="mt-1 block text-sm text-muted-foreground">{c.reason}</span>
                        </button>
                      </div>
                      <div className="ml-7 mt-2 flex gap-2">
                        <button type="button" onClick={() => { setEditId(editId === c.id ? null : c.id); setEditVal(String(c.value)); setEditReason(''); }} className="rounded-md border border-input px-2.5 py-1 text-sm font-medium hover:bg-muted">Edit quantity</button>
                      </div>
                      {editId === c.id ? (
                        <form className="ml-7 mt-3 space-y-2 rounded-md border border-border bg-background p-3" onSubmit={(e) => { e.preventDefault(); const v = Number(editVal); if (!Number.isFinite(v) || v < 0 || !editReason.trim()) return; update(c.id, { value: v, editReason: editReason.trim(), confidence: Math.min(c.confidence, 90) }); setEditId(null); }}>
                          <label className="block text-sm font-medium">New quantity ({c.unit})<input value={editVal} onChange={(e) => setEditVal(e.target.value)} inputMode="decimal" className="mt-1 w-full rounded-md border border-input bg-card px-3 py-2 font-data" /></label>
                          <label className="block text-sm font-medium">Reason (required)<input value={editReason} onChange={(e) => setEditReason(e.target.value)} required placeholder="For example: measured on the signed drawing" className="mt-1 w-full rounded-md border border-input bg-card px-3 py-2" /></label>
                          <button type="submit" className="rounded-md bg-primary px-3 py-1.5 font-semibold text-primary-foreground hover:opacity-90">Save quantity</button>
                        </form>
                      ) : null}
                      {c.editReason ? <p className="ml-7 mt-2 text-sm text-muted-foreground">Edited: {c.editReason}</p> : null}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}

          <div className={`flex items-center justify-between gap-3 rounded-lg border p-4 ${check.match ? 'border-success/30 bg-success/10' : 'border-destructive/30 bg-destructive/10'}`}>
            <div>
              <p className="font-semibold text-foreground">PVR check</p>
              <p className="text-foreground">PVR states {check.stated.toLocaleString('en-US')} m, drawing measures {check.measured.toLocaleString('en-US')} m</p>
              <p className="text-sm text-muted-foreground">{check.reason}</p>
            </div>
            <span className={`font-semibold ${check.match ? 'text-success' : 'text-destructive'}`}>{check.match ? 'Match' : 'Mismatch'}</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => { setMeasure((v) => !v); setMeasured(null); }} className={`rounded-md border px-3 py-2 font-medium ${measure ? 'border-warning bg-warning/10' : 'border-input hover:bg-muted'}`}>{measure ? 'Stop measuring' : 'Measure on drawing'}</button>
            {measured !== null ? <span className="text-foreground">Manual measurement: <span className="font-data font-semibold">{measured.toLocaleString('en-US')} m</span></span> : null}
          </div>
        </div>
      </div>

      {question && question.included ? (
        <div className="rounded-lg border-2 border-warning bg-warning/5 p-4" role="group" aria-label="Question from the Drawing agent">
          <p className="font-semibold text-foreground">Include {question.value} street lighting columns?</p>
          <p className="text-muted-foreground">The PVR text does not mention lighting.</p>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => update(question.id, { needsQuestion: undefined, confidence: 92 })} className="rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground hover:opacity-90">Include</button>
            <button type="button" onClick={() => update(question.id, { included: false, needsQuestion: undefined })} className="rounded-md border border-input bg-card px-4 py-2 font-semibold hover:bg-muted">Exclude</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

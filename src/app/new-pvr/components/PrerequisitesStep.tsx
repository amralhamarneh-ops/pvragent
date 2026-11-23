'use client';

import React, { useState } from 'react';
import { Check, CircleDashed, AlertCircle } from 'lucide-react';
import AutomaticAnalysis from '@/app/new-pvr/components/AutomaticAnalysis';
import type { ClassifiedFile, TriageResult } from '@/lib/intake/triage';
import type { AnalysisResult } from '@/lib/drawings/types';

export type ReqState = 'ready' | 'choice' | 'missing';

interface Requirement {
  key: string;
  label: string;
  required: boolean;
  state: ReqState;
  selection: string;
  note: string;
  consequence: string;
  /** Honest readiness wording: Uploaded / Read successfully / Validated. */
  stage?: 'Uploaded' | 'Read successfully' | 'Validated';
}

export interface AnalysisControls {
  result: AnalysisResult | null;
  running: boolean;
  error: string;
  onAnalyse: () => void;
  canAnalyse: boolean;
  cannotReason: string;
  answers: Record<string, string>;
  onAnswer: (id: string, optionId: string) => void;
  manualOpen: boolean;
  onManualOpen: (v: boolean) => void;
  manualQty: string;
  onManualQty: (v: string) => void;
  manualUnit: string;
  onManualUnit: (v: string) => void;
  manualComponent: string;
  onManualComponent: (v: string) => void;
  manualDate: string;
  onManualDate: (v: string) => void;
}

interface PrerequisitesStepProps {
  result: TriageResult;
  files: ClassifiedFile[];
  baseline: string;
  description: string;
  onDescription: (v: string) => void;
  skipped: string[];
  onSkip: (key: string) => void;
  analysis: AnalysisControls;
}

export function buildRequirements(files: ClassifiedFile[], result: TriageResult, baseline: string, description: string, skipped: string[], analysis?: AnalysisResult | null): Requirement[] {
  const by = (r: ClassifiedFile['role']) => files.filter((f) => f.role === r);
  const pvr = by('pvr');
  const drw = by('drawings');
  const boq = by('boq');
  const sch = by('schedule');
  const con = by('contract');
  const cor = by('correspondence');
  const site = by('site');
  const hasText = description.trim().length > 10;

  // Drawing readiness is never inferred from the file count. It follows what the analysis actually did.
  const dState = (n: string) => analysis?.files.find((f) => f.fileName === n || n.endsWith(`/${f.fileName}`))?.stateLabel;
  const validated = drw.filter((d) => dState(d.name) === 'Validated').length;
  const read = drw.filter((d) => dState(d.name) === 'Read successfully').length;
  const stage: Requirement['stage'] = drw.length === 0 ? undefined : validated >= 2 ? 'Validated' : validated + read > 0 ? 'Read successfully' : 'Uploaded';
  const drawNote = drw.length === 0
    ? 'Optional. Without drawings, quantities come from the PVR or narrative and are marked as stated.'
    : !analysis ? `${drw.length} drawing file${drw.length === 1 ? '' : 's'} uploaded. Not yet read: run the automatic analysis below.`
    : validated >= 2 ? 'Original and revised drawings were paired and validated for measurement.' :'Files were found but are not ready for measurement. See the readiness details below.';

  return [
    { key: 'pvr', label: 'Change request', required: true, state: pvr.length > 0 || hasText ? 'ready' : 'missing', selection: pvr[0]?.name ?? (hasText ? 'Typed description' : 'Not provided'), note: pvr[0] ? (result.pvrs[0]?.title ?? '') : hasText ? description.slice(0, 80) : 'Needed to know what changed.', consequence: 'Without a change request the agents cannot tell what to look for.' },
    { key: 'drawings', label: 'Drawings', required: false, state: drw.length === 0 ? 'missing' : 'ready', selection: drw.length ? drw.map((d) => d.name.replace(/\.[^.]+$/, '')).join(', ') : 'Not provided', note: drawNote, stage, consequence: 'Without drawings, quantities come only from the PVR or narrative and are marked as stated, not measured.' },
    { key: 'boq', label: 'BoQ', required: true, state: boq.length > 0 ? 'ready' : 'missing', selection: boq.length ? `${boq.length} BoQ file${boq.length === 1 ? '' : 's'}` : 'Not provided', note: boq.length ? 'Items are read in the BoQ stage' : 'Needed to find affected items.', consequence: 'Without a BoQ no items can be mapped.' },
    { key: 'schedule', label: 'Schedule baseline', required: true, state: sch.length === 0 ? 'missing' : sch.length > 1 && !baseline ? 'choice' : 'ready', selection: sch.length === 0 ? 'Not provided' : (baseline ? baseline.split('/').pop() : sch[0].name) ?? '', note: sch.length > 1 && !baseline ? 'Choose the baseline in the previous step.' : 'Read in the activity stage', consequence: 'Without a baseline schedule, activities cannot be mapped.' },
    { key: 'contract', label: 'Contract', required: false, state: con.length ? 'ready' : 'missing', selection: con.length ? con[0].name.replace(/\.[^.]+$/, '') : 'Not provided', note: 'Needed later for eligibility, not blocking now', consequence: 'Mapping continues. Eligibility cannot be checked until a contract is added.' },
    { key: 'correspondence', label: 'Correspondence', required: false, state: cor.length ? 'ready' : 'missing', selection: cor.length ? cor[0].name.replace(/\.[^.]+$/, '') : 'Not provided (optional)', note: cor.length ? 'Dates in it are labelled by meaning during analysis' : 'Helps establish the event date.', consequence: 'The event date may remain unresolved. This does not block quantities or BOQ matching.' },
    { key: 'site', label: 'Site reports', required: false, state: site.length || skipped.includes('site') ? 'ready' : 'missing', selection: site.length ? site[0].name : skipped.includes('site') ? 'Continuing without' : 'Not provided (optional)', note: 'No effect on mapping. Helps later when checking progress.', consequence: 'No effect on mapping. Progress checks later will use the schedule only.' },
  ];
}

function Row({ r, onSkip, onPaste }: { r: Requirement; onSkip: (k: string) => void; onPaste: () => void }) {
  const [open, setOpen] = useState(false);
  const icon = r.state === 'ready' ? <span className="flex h-6 w-6 items-center justify-center rounded-full bg-success text-success-foreground"><Check size={14} /></span> : r.state === 'choice' ? <AlertCircle size={24} className="text-warning" /> : <CircleDashed size={24} className={r.required ? 'text-destructive' : 'text-muted-foreground'} />;
  const stateLabel = r.stage ?? (r.state === 'ready' ? 'Ready' : r.state === 'choice' ? 'Needs your choice' : 'Missing');
  const tone = r.stage === 'Validated' ? 'bg-success/15 text-success' : r.stage === 'Read successfully' ? 'bg-accent/10 text-accent' : r.stage === 'Uploaded' ? 'bg-muted text-muted-foreground' : r.state === 'ready' ? 'bg-accent/10 text-accent' : r.state === 'choice' ? 'bg-warning/15 text-warning' : 'bg-muted text-muted-foreground';
  return (
    <li className="py-4">
      <div className="grid grid-cols-[28px_minmax(120px,1fr)_minmax(0,2fr)_auto] items-center gap-x-4 gap-y-1">
        <span aria-hidden>{icon}</span>
        <p className="font-semibold text-foreground">{r.label}</p>
        <div className="min-w-0">
          <p className="truncate text-foreground">{r.selection}</p>
          <p className="text-sm text-muted-foreground">{r.note}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-md px-2.5 py-1 text-sm font-medium ${tone}`}>{stateLabel}</span>
          {r.state !== 'ready' ? (
            <button type="button" onClick={() => setOpen((v) => !v)} className="rounded-md border border-input px-3 py-1.5 font-medium hover:bg-muted" aria-expanded={open}>How to fix</button>
          ) : null}
        </div>
      </div>
      {open && r.state !== 'ready' ? (
        <div className="ml-11 mt-3 rounded-md border border-border bg-background p-4">
          <p className="text-muted-foreground">{r.consequence}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {r.key === 'pvr' ? <button type="button" onClick={onPaste} className="rounded-md border border-input bg-card px-3 py-1.5 font-medium hover:bg-muted">Type the description</button> : null}
            <span className="self-center text-sm text-muted-foreground">To add files, go back to the evidence pack.</span>
            {!r.required ? <button type="button" onClick={() => { onSkip(r.key); setOpen(false); }} className="rounded-md px-3 py-1.5 font-medium text-accent hover:bg-accent/10">Continue without</button> : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

export default function PrerequisitesStep({ result, files, baseline, description, onDescription, skipped, onSkip, analysis }: PrerequisitesStepProps) {
  const reqs = buildRequirements(files, result, baseline, description, skipped, analysis.result);
  const required = reqs.filter((r) => r.required);
  const later = reqs.filter((r) => !r.required);
  const missing = required.filter((r) => r.state !== 'ready');
  const focusText = () => document.getElementById('typed-description')?.focus();

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-6">
        <section className="rounded-lg border border-border bg-card p-6 shadow-sm" aria-label="Prerequisites">
          <h2 className="text-lg font-semibold text-foreground">Required for mapping</h2>
          <ul className="mt-1 divide-y divide-border">{required.map((r) => <Row key={r.key} r={r} onSkip={onSkip} onPaste={focusText} />)}</ul>
          <h2 className="mt-6 text-lg font-semibold text-foreground">Needed later</h2>
          <ul className="mt-1 divide-y divide-border">{later.map((r) => <Row key={r.key} r={r} onSkip={onSkip} onPaste={focusText} />)}</ul>
          {result.pvrs.length === 0 ? (
            <div className="mt-4">
              <label htmlFor="typed-description" className="font-semibold text-foreground">Type the change description</label>
              <textarea id="typed-description" value={description} onChange={(e) => onDescription(e.target.value)} rows={2} className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30" />
            </div>
          ) : null}
        </section>

        <AutomaticAnalysis {...analysis} />

        {missing.length > 0 ? <p role="alert" className="rounded-md border border-warning bg-warning/10 px-4 py-3 text-foreground">{missing.map((m) => m.label).join(', ')} {missing.length === 1 ? 'is' : 'are'} needed before the agents can start.</p> : null}
      </div>

      <aside className="h-fit rounded-lg border border-border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-foreground">What happens next</h2>
        <ol className="mt-3 space-y-4">
          {[['Scope & quantities', 'Confirmed changes from the analysis are passed on with their evidence'], ['BOQ & rates', 'Find affected BoQ items for each change'], ['Activities', 'Link them to schedule activities']].map(([t, d], i) => (
            <li key={t} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">{i + 2}</span>
              <div><p className="font-semibold text-foreground">{t}</p><p className="text-muted-foreground">{d}</p></div>
            </li>
          ))}
        </ol>
        <p className="mt-5 text-muted-foreground">You review and confirm each stage. Starting analysis opens the existing case workspace.</p>
      </aside>
    </div>
  );
}

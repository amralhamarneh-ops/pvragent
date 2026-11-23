'use client';

import React, { useState } from 'react';
import { AlertCircle, Check, ChevronDown, ChevronRight, CircleDashed, Loader2, Sparkles } from 'lucide-react';
import { BASIS_LABEL, DATE_LABEL, type AnalysisResult, type ReconciledChange } from '@/lib/drawings/types';

interface Props {
  result: AnalysisResult | null;
  running: boolean;
  error: string;
  onAnalyse: () => void;
  canAnalyse: boolean;
  cannotReason: string;
  /** Answers to targeted questions, keyed by question id. */
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

const STATE_STYLE: Record<string, string> = {
  Validated: 'bg-success/15 text-success',
  'Read successfully': 'bg-accent/10 text-accent',
  Uploaded: 'bg-muted text-muted-foreground',
  'Not supported': 'bg-warning/15 text-foreground',
  'Read failed': 'bg-destructive/10 text-destructive',
};

const unitText = (u: string) => (u === 'm2' ? 'm²' : u === 'm3' ? 'm³' : u);

function BasisBadge({ basis }: { basis: ReconciledChange['basis'] }) {
  const tone = basis === 'measured' ? 'bg-success/15 text-success' : basis === 'derived' ? 'bg-accent/10 text-accent' : basis === 'user_entered' ? 'bg-primary/10 text-primary' : 'bg-muted text-foreground';
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${tone}`}>{BASIS_LABEL[basis]}</span>;
}

function ChangeRow({ c }: { c: ReconciledChange }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="border-t border-border align-top">
        <td className="px-3 py-2"><button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`Details for ${c.component}`} className="text-muted-foreground hover:text-foreground">{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button></td>
        <td className="px-3 py-2"><p className="font-medium text-foreground">{c.component}</p><p className="text-xs text-muted-foreground">{c.description}</p>{c.location ? <p className="text-xs text-muted-foreground">{c.location}</p> : null}</td>
        <td className="px-3 py-2 text-right font-data">{c.originalQty || '—'}</td>
        <td className="px-3 py-2 text-right font-data">{c.revisedQty || '—'}</td>
        <td className="px-3 py-2 text-right font-data font-semibold">{c.changeQty}</td>
        <td className="px-3 py-2">{unitText(c.unit)}</td>
        <td className="px-3 py-2"><BasisBadge basis={c.basis} />{c.conflict ? <span className="ml-1 rounded bg-warning/20 px-2 py-0.5 text-xs font-medium text-foreground">Conflict</span> : null}</td>
      </tr>
      {open ? (
        <tr className="bg-background">
          <td />
          <td colSpan={6} className="px-3 py-3 text-sm">
            <p><span className="font-semibold text-foreground">Measurement basis:</span> <span className="text-muted-foreground">{c.measurementBasis}</span></p>
            <p className="mt-1"><span className="font-semibold text-foreground">Sources:</span> <span className="text-muted-foreground">{c.sources.join(' · ') || '—'}</span></p>
            {c.alternatives.length > 0 ? (
              <div className="mt-2">
                <p className="font-semibold text-foreground">Other values for this change (kept, not overwritten)</p>
                <ul className="mt-1 space-y-1">{c.alternatives.map((a, i) => <li key={i} className="text-muted-foreground"><BasisBadge basis={a.basis} /> <span className="font-data">{a.value} {unitText(a.unit)}</span> · {a.source}{a.quote ? <> · “{a.quote}”</> : null}</li>)}</ul>
              </div>
            ) : null}
            {c.conflict ? <p role="alert" className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-foreground">{c.conflictNote}</p> : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

export default function AutomaticAnalysis(p: Props) {
  const r = p.result;
  const open = r ? r.questions.filter((q) => !p.answers[q.id]) : [];
  return (
    <section aria-label="Automatic analysis" className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h2 className="flex items-center gap-2 text-xl font-semibold text-foreground"><Sparkles size={20} aria-hidden />Automatic analysis</h2>
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-muted-foreground">
              <li>Compare original and revised drawings.</li>
              <li>Identify changed scope and quantities.</li>
              <li>Extract relevant dates.</li>
              <li>Match related BOQ items.</li>
            </ul>
            <p className="mt-2 text-sm text-muted-foreground">No quantity or event date needs to be typed. The uploaded files are read first; you are asked only about what the evidence cannot settle.</p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <button type="button" onClick={p.onAnalyse} disabled={!p.canAnalyse || p.running} className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground">
              {p.running ? <Loader2 size={16} className="animate-spin" aria-hidden /> : null}{p.running ? 'Analysing…' : r ? 'Analyse again' : 'Analyse documents and identify changes'}
            </button>
            {!p.canAnalyse && p.cannotReason ? <span className="max-w-xs text-right text-sm text-muted-foreground">{p.cannotReason}</span> : null}
          </div>
        </div>
        {p.error ? <p role="alert" className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-destructive">{p.error}</p> : null}
      </div>

      {r ? (
        <>
          <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-foreground">Document readiness</h3>
            <p className="text-sm text-muted-foreground">Uploaded means the file is here. Read successfully means its contents were parsed. Validated means a drawing pair passed the unit, alignment and layer checks needed for measuring.</p>
            <ul className="mt-2 divide-y divide-border">
              {r.files.length === 0 ? <li className="py-2 text-muted-foreground">No drawing or text files to read. Only the narrative was analysed.</li> : r.files.map((f) => (
                <li key={f.fileName} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 py-2">
                  <div className="min-w-0"><p className="truncate font-medium text-foreground">{f.fileName} <span className="text-sm font-normal text-muted-foreground">· {f.role}</span></p><p className="text-sm text-muted-foreground">{f.detail}</p></div>
                  <span className={`rounded-md px-2.5 py-1 text-sm font-medium ${STATE_STYLE[f.stateLabel] ?? 'bg-muted'}`}>{f.stateLabel}</span>
                </li>
              ))}
            </ul>
            {r.pairs.length > 0 ? (
              <div className="mt-3 rounded-md bg-background p-3 text-sm">
                {r.pairs.map((pr) => (
                  <div key={pr.revised.fileName}>
                    <p className="font-semibold text-foreground">Pair: {pr.original.fileName} (rev {pr.original.titleBlock?.revision}) → {pr.revised.fileName} (rev {pr.revised.titleBlock?.revision})</p>
                    <ul className="list-disc pl-5 text-muted-foreground">{pr.basis.map((b) => <li key={b}>{b}</li>)}{pr.blockers.map((b) => <li key={b} className="text-foreground">Blocked: {b}</li>)}</ul>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-foreground">Changes identified <span className="text-sm font-normal text-muted-foreground">({r.changes.length})</span></h3>
            {r.changes.length === 0 ? <p className="mt-2 text-muted-foreground">No quantified change could be established from the evidence yet. See the questions and limitations below. BOQ matching can still use your narrative.</p> : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="text-muted-foreground"><tr><th className="w-8 px-3 py-2" /><th className="px-3 py-2 font-medium">Change</th><th className="px-3 py-2 text-right font-medium">Original</th><th className="px-3 py-2 text-right font-medium">Revised</th><th className="px-3 py-2 text-right font-medium">Change</th><th className="px-3 py-2 font-medium">Unit</th><th className="px-3 py-2 font-medium">Basis</th></tr></thead>
                  <tbody>{r.changes.map((c) => <ChangeRow key={c.id} c={c} />)}</tbody>
                </table>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-foreground">Dates found and what they mean</h3>
            {r.dates.length === 0 ? <p className="mt-2 text-muted-foreground">No dates were found in the readable evidence.</p> : (
              <ul className="mt-2 divide-y divide-border text-sm">
                {r.dates.map((d, i) => <li key={`${d.iso}-${i}`} className="grid grid-cols-[110px_minmax(0,1fr)] gap-3 py-2"><span className="font-data text-foreground">{d.iso}</span><span><span className="font-medium text-foreground">{DATE_LABEL[d.meaning]}</span><span className="block text-muted-foreground">{d.source} · “{d.context}”</span></span></li>)}
              </ul>
            )}
            <p className="mt-3 rounded-md bg-background px-3 py-2 text-sm text-foreground">
              {r.proposedEventDate ? <>Proposed {DATE_LABEL[r.proposedEventDate.meaning].toLowerCase()}: <span className="font-data font-semibold">{r.proposedEventDate.iso}</span> from {r.proposedEventDate.source} (“{r.proposedEventDate.context}”). Drawing and submission dates were not used.</> : <><span className="font-semibold">Date unresolved.</span> No explicit event or instruction date was found. This does not block drawing comparison, quantities or BOQ matching; it is needed only when the schedule is assessed, and the programme update is chosen separately.</>}
            </p>
          </div>

          <div className="rounded-lg border-2 border-warning bg-warning/5 p-6">
            <h3 className="text-lg font-semibold text-foreground">Needs your input <span className="text-sm font-normal text-muted-foreground">({open.length})</span></h3>
            {open.length === 0 ? <p className="mt-2 text-muted-foreground">Nothing further is needed from you at this stage.</p> : (
              <ul className="mt-2 space-y-3">
                {open.map((q) => (
                  <li key={q.id} className="rounded-md border border-border bg-card p-4">
                    <p className="flex items-start gap-2 font-semibold text-foreground"><AlertCircle size={18} className="mt-0.5 shrink-0 text-warning" aria-hidden />{q.title}</p>
                    <p className="mt-1 text-sm text-foreground">{q.issue}</p>
                    {q.evidence.length ? <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">{q.evidence.slice(0, 5).map((e) => <li key={e}>{e}</li>)}</ul> : null}
                    <p className="mt-1 text-sm text-muted-foreground">{q.proposal}{q.blocksComparison ? '' : ' This does not block the rest of the analysis.'}</p>
                    <div className="mt-2 flex flex-wrap gap-2">{q.options.map((o) => <button key={o.id} type="button" onClick={() => p.onAnswer(q.id, o.id)} className="rounded-md border border-input bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted">{o.label}</button>)}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-foreground">What this backend can and cannot do</h3>
            <div className="mt-2 grid gap-4 text-sm md:grid-cols-2">
              <div><p className="font-semibold text-foreground">Formats processed</p><ul className="list-disc pl-5 text-muted-foreground">{r.capability.supportedFormats.map((x) => <li key={x}>{x}</li>)}</ul></div>
              <div><p className="font-semibold text-foreground">Operations implemented</p><ul className="list-disc pl-5 text-muted-foreground">{r.capability.operations.map((x) => <li key={x}>{x}</li>)}</ul></div>
            </div>
            {r.capability.unsupported.length > 0 ? <div className="mt-3 text-sm"><p className="font-semibold text-foreground">Not processed in this upload</p><ul className="list-disc pl-5 text-muted-foreground">{r.capability.unsupported.map((u) => <li key={u.fileName}><span className="text-foreground">{u.fileName}</span>: {u.reason}</li>)}</ul></div> : null}
            <details className="mt-3 text-sm"><summary className="cursor-pointer font-medium text-foreground">Processing log ({r.events.length} steps)</summary><ol className="mt-1 list-decimal space-y-0.5 pl-5 text-muted-foreground">{r.events.map((e, i) => <li key={i}><span className="font-medium text-foreground">{e.step}:</span> {e.detail}</li>)}</ol></details>
          </div>
        </>
      ) : null}

      <details open={p.manualOpen} onToggle={(e) => p.onManualOpen((e.currentTarget as HTMLDetailsElement).open)} className="rounded-lg border border-border bg-card p-6 shadow-sm">
        <summary className="cursor-pointer text-lg font-semibold text-foreground">Add information manually <span className="text-sm font-normal text-muted-foreground">(optional)</span></summary>
        <p className="mt-2 text-sm text-muted-foreground">Use this only to override a value or answer a specific gap. Anything entered here is labelled User-entered and never replaces a measured value silently.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <div className="sm:col-span-2"><label htmlFor="m-comp" className="text-sm font-medium text-foreground">Change component</label><input id="m-comp" value={p.manualComponent} onChange={(e) => p.onManualComponent(e.target.value)} placeholder="For example: ROAD-CL (as listed above)" className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2" /></div>
          <div><label htmlFor="m-qty" className="text-sm font-medium text-foreground">Quantity</label><input id="m-qty" inputMode="decimal" value={p.manualQty} onChange={(e) => p.onManualQty(e.target.value)} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-data" /></div>
          <div><label htmlFor="m-unit" className="text-sm font-medium text-foreground">Unit</label><select id="m-unit" value={p.manualUnit} onChange={(e) => p.onManualUnit(e.target.value)} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2"><option value="m">m</option><option value="m2">m²</option><option value="m3">m³</option><option value="nr">nr</option></select></div>
          <div className="sm:col-span-2"><label htmlFor="m-date" className="text-sm font-medium text-foreground">Event or instruction date, if you know it</label><input id="m-date" type="date" value={p.manualDate} onChange={(e) => p.onManualDate(e.target.value)} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-data" /></div>
        </div>
      </details>
    </section>
  );
}

export function ReadyIcon({ ok }: { ok: boolean }) {
  return ok ? <span className="flex h-6 w-6 items-center justify-center rounded-full bg-success text-success-foreground"><Check size={14} /></span> : <CircleDashed size={24} className="text-muted-foreground" />;
}

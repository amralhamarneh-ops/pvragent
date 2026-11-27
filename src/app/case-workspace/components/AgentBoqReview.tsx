'use client';

import React, { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, CircleHelp, Loader2, Sparkles } from 'lucide-react';
import { formatSigned } from '@/lib/boq/calc';
import { planConversion } from '@/lib/boq/units';
import type { NeedsInput, RelatedLine, UserAnswers } from '@/lib/boq/matchEngine';
import { outcomeOf, type AgentEvent, type AgentRun } from '@/lib/boq/agentClient';
import type { EvidenceDoc } from '@/lib/boq/scope';
import { CostSummaryPanel, DeferModal, ExcludeModal, ExcludedSection, ManualRateModal, ResolutionButtons } from '@/app/case-workspace/components/LineResolutionControls';
import type { LineResolution } from '@/lib/boq/resolutions';

interface AgentBoqReviewProps {
  run: AgentRun | null;
  running: boolean;
  events: AgentEvent[];
  error: string;
  stale: boolean;
  evidence: EvidenceDoc[];
  narrative: string;
  onNarrative: (v: string) => void;
  onAddEvidence: (files: FileList) => void;
  onAnalyse: () => void;
  confirmed: boolean;
  onConfirm: () => void;
  answers: UserAnswers;
  onAnswers: (a: UserAnswers) => void;
  hasBoq: boolean;
  /** Called with the component id and the new resolution (undefined = cleared/restored). */
  onResolve: (componentId: string, next: LineResolution | undefined) => void;
  scheduleStale: boolean;
  costStale: boolean;
  partialAccepted: boolean;
  onContinuePartial: () => void;
}

const STATUS_LABEL: Record<RelatedLine['status'], string> = { ready: 'Ready', needs_input: 'Needs input', unpriced: 'Unpriced', blocked: 'Blocked' };
const STATUS_TONE: Record<RelatedLine['status'], string> = { ready: 'bg-secondary text-secondary-foreground', needs_input: 'bg-warning/20 text-foreground', unpriced: 'bg-warning/20 text-foreground', blocked: 'bg-destructive/10 text-destructive' };

export default function AgentBoqReview(p: AgentBoqReviewProps) {
  const outcome = useMemo(() => (p.run ? outcomeOf(p.run, p.answers) : null), [p.run, p.answers]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [manualFor, setManualFor] = useState<string | null>(null);
  const [excludeFor, setExcludeFor] = useState<string | null>(null);
  const [deferFor, setDeferFor] = useState<string | null>(null);

  const unresolved = outcome ? outcome.needs.length : 0;
  const valued = outcome ? outcome.lines.filter((l) => l.valued) : [];
  const canAnalyse = p.hasBoq && (p.narrative.trim().length > 0 || p.evidence.some((e) => e.extracted)) && !p.running;
  const manualLine = outcome && manualFor ? outcome.lines.find((l) => l.componentId === manualFor && l.role === 'primary') ?? null : null;
  const manualComp = p.run && manualFor ? p.run.scope.components.find((c) => c.id === manualFor) ?? null : null;
  const manualQty = manualFor ? ((p.run?.drawingQuantitiesOnly ? null : p.answers.quantity[manualFor]) ?? manualComp?.quantity ?? null) : null;
  const excludeComp = p.run && excludeFor ? p.run.scope.components.find((c) => c.id === excludeFor) ?? null : null;
  const deferComp = p.run && deferFor ? p.run.scope.components.find((c) => c.id === deferFor) ?? null : null;
  const deferredRows = p.run
    ? p.run.scope.components.flatMap((c) => {
        const r = p.answers.resolutions?.[c.id];
        return r && r.kind === 'deferred' ? [{ componentId: c.id, name: c.name, reason: r.reason, by: r.by, at: r.at }] : [];
      })
    : [];
  const excludedRows = outcome && p.run
    ? p.run.scope.components.flatMap((c) => {
        const r = p.answers.resolutions?.[c.id];
        if (!r || r.kind !== 'excluded') return [];
        const l = outcome.lines.find((x) => x.componentId === c.id && x.role === 'primary');
        const detail = l ? `${l.item.ref} ${l.item.description} · ${l.item.sourceFile} · ${l.item.sheet}!${l.item.rowNumber}` : 'No BOQ item was matched. Original evidence retained.';
        return [{ componentId: c.id, name: c.name, scope: r.scope, reason: r.reason, by: r.by, at: r.at, detail }];
      })
    : [];

  const set = (patch: Partial<UserAnswers>) => p.onAnswers({ ...p.answers, ...patch });

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-border bg-card p-5 shadow-sm" aria-labelledby="ev-title">
        <h2 id="ev-title" className="flex items-center gap-2 text-lg font-semibold text-foreground"><Sparkles size={18} aria-hidden />Change evidence</h2>
        <p className="mt-1 text-sm text-muted-foreground">Describe the change or add the PVR text. The agent reads it, works out the changed scope, then searches every imported BOQ file.</p>
        <label htmlFor="narr" className="mt-3 block text-sm text-muted-foreground">Narrative</label>
        <textarea id="narr" rows={4} value={p.narrative} onChange={(e) => p.onNarrative(e.target.value)} placeholder="For example: Extend access road R4 by 2,000 m with 7 m wide asphalt pavement, kerbs both sides and street lighting." className="mt-0.5 w-full rounded-md border border-input bg-card px-3 py-2 text-foreground" />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-input bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted">
            Add PVR / specification files
            <input type="file" multiple className="sr-only" aria-label="Add change evidence files" onChange={(e) => { if (e.target.files) p.onAddEvidence(e.target.files); e.target.value = ''; }} />
          </label>
          <span className="text-xs text-muted-foreground">Text files (.txt, .md, .csv, .json, .eml) are read. PDF, Word and drawings are listed but not read here.</span>
        </div>
        {p.evidence.length > 0 ? (
          <ul className="mt-3 space-y-1 text-sm" aria-label="Evidence files">
            {p.evidence.map((e) => (
              <li key={e.name} className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-2 py-0.5 text-xs font-medium ${e.extracted ? 'bg-secondary text-secondary-foreground' : 'bg-warning/20 text-foreground'}`}>{e.extracted ? 'Read' : 'Not read'}</span>
                <span className="text-foreground">{e.name}</span>
                {e.note ? <span className="text-muted-foreground">· {e.note}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {!p.hasBoq ? <p className="mt-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">Import a BOQ first. The agent prioritizes your uploaded BOQ rates. After review, a missing rate can use a cited processed PVR rate for a pilot only.</p> : null}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {!p.run || p.stale ? (
            <button type="button" onClick={p.onAnalyse} disabled={!canAnalyse} className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground">
              {p.running ? <Loader2 size={16} className="animate-spin" aria-hidden /> : null}{p.running ? 'Analysing…' : p.run ? 'Re-analyse change and match BOQ' : 'Analyse change and match BOQ'}
            </button>
          ) : (
            <button type="button" onClick={p.onConfirm} disabled={p.confirmed || valued.length === 0} className="rounded-md bg-primary px-5 py-2.5 font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground">
              {p.confirmed ? 'Assessment confirmed' : 'Confirm assessment'}
            </button>
          )}
          {p.run && !p.stale && unresolved > 0 && !p.confirmed ? <span className="text-sm text-foreground">{unresolved} unresolved item{unresolved === 1 ? '' : 's'} will be recorded with the confirmation.</span> : null}
          {p.run && !p.stale ? <button type="button" onClick={p.onAnalyse} disabled={p.running} className="text-sm text-accent hover:underline">Re-run analysis</button> : null}
          {p.run && !p.stale && !p.confirmed && unresolved > 0 && valued.length > 0 ? <button type="button" onClick={p.onContinuePartial} disabled={p.partialAccepted} className="rounded-md border border-input bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-60">{p.partialAccepted ? 'Continuing with partial assessment' : 'Continue with partial assessment'}</button> : null}
        </div>
        {p.stale && p.run ? <p role="status" className="mt-2 text-sm text-foreground">The evidence or the active BOQ changed since the last analysis. Run the analysis again to refresh the matches.</p> : null}
        {p.error ? <p role="alert" className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-destructive">{p.error}</p> : null}
      </section>

      {p.events.length > 0 ? (
        <section className="rounded-lg border border-border bg-card p-4 shadow-sm" aria-label="Processing events">
          <h3 className="text-sm font-semibold text-foreground">Processing log <span className="font-normal text-muted-foreground">(actual steps, as they ran)</span></h3>
          <ol className="mt-2 space-y-1 text-sm">
            {p.events.map((e, i) => <li key={`${e.at}-${i}`} className="flex gap-2"><span className="font-data text-xs text-muted-foreground">{e.at.slice(11, 19)}</span><span className="font-medium text-foreground">{e.step}</span><span className="text-muted-foreground">{e.detail}{e.ms !== undefined ? ` · ${e.ms} ms` : ''}</span></li>)}
          </ol>
        </section>
      ) : null}

      {p.run && outcome ? (
        <>
          <section className="rounded-lg border border-border bg-card p-5 shadow-sm" aria-labelledby="cu-title">
            <h2 id="cu-title" className="text-lg font-semibold text-foreground">A. Change understood</h2>
            <p className="mt-1 text-foreground">{p.run.scope.summary || 'No summary was returned.'}</p>
            <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {p.run.scope.location ? <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Location</dt><dd className="text-foreground">{p.run.scope.location}</dd></div> : null}
              {p.run.scope.packageName ? <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Package</dt><dd className="text-foreground">{p.run.scope.packageName}</dd></div> : null}
            </dl>
            <ul className="mt-3 divide-y divide-border rounded-md border border-border">
              {p.run.scope.components.map((c) => (
                <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2 text-sm">
                  <span><span className="font-medium text-foreground">{c.name}</span> <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{c.action}</span>{c.potential ? <span className="ml-1 rounded bg-warning/20 px-1.5 py-0.5 text-xs text-foreground">Potentially affected</span> : null}
                    <span className="block text-muted-foreground">{[c.discipline, c.material, c.specification, c.location].filter(Boolean).join(' · ')}</span></span>
                  <span className="text-right">{c.quantity ? <><span className="tabular text-foreground">{c.quantity.value} {c.quantity.unit}</span><span className="block text-xs text-muted-foreground">{c.quantity.origin === 'measured_from_geometry' ? 'Measured from drawings' : c.quantity.origin === 'user_entered' ? 'User-entered' : c.quantity.origin === 'derived_from_stated' ? 'Derived' : 'Stated in document'} · “{c.quantity.quote}”</span></> : <span className="text-warning">No quantity in the evidence</span>}</span>
                </li>
              ))}
            </ul>
            {p.run.scope.limitations.length > 0 ? <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"><p className="font-semibold text-foreground">Limitations</p><ul className="list-disc pl-5 text-muted-foreground">{p.run.scope.limitations.map((l) => <li key={l}>{l}</li>)}</ul></div> : null}
            {p.run.scope.missingInformation.length > 0 ? <p className="mt-2 text-sm text-muted-foreground">Missing information: {p.run.scope.missingInformation.join('; ')}</p> : null}
          </section>

          <section className="rounded-lg border border-border bg-card p-5 shadow-sm" aria-labelledby="rb-title">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="rb-title" className="text-lg font-semibold text-foreground">B. Related BOQ items</h2>
              {outcome.total !== null ? <p className="text-lg font-bold tabular text-foreground">{formatSigned(outcome.total, outcome.currency)} <span className="text-sm font-normal text-muted-foreground">{outcome.summary.fullyPriced ? 'total' : 'priced subtotal'} across {outcome.pricedCount} priced line{outcome.pricedCount === 1 ? '' : 's'}</span></p> : <p className="text-sm text-muted-foreground">No priced lines yet.</p>}
            </div>
            <p className="text-sm text-muted-foreground">Rates come from your uploaded BOQ files. Alternative candidates are shown but never valued.</p>
            <CostSummaryPanel summary={outcome.summary} scheduleStale={p.scheduleStale} costStale={p.costStale} />
            {outcome.lines.length === 0 ? <p className="mt-3 text-muted-foreground">No BOQ items were matched. See “Needs your input”.</p> : (
              <div className="mt-3 overflow-x-auto rounded-md border border-border">
                <table className="w-full min-w-[980px] text-sm">
                  <thead className="bg-muted text-left text-muted-foreground"><tr><th className="w-8 px-2 py-2" /><th className="px-2 py-2">Change component</th><th className="px-2 py-2">BOQ ref</th><th className="px-2 py-2">Description</th><th className="px-2 py-2">Bill / file</th><th className="px-2 py-2">Unit</th><th className="px-2 py-2 text-right">Change qty</th><th className="px-2 py-2 text-right">Rate</th><th className="px-2 py-2 text-right">Assessed</th><th className="px-2 py-2">Status</th></tr></thead>
                  <tbody>
                    {outcome.lines.map((l) => {
                      const ok = l.calc && l.calc.ok ? l.calc : null;
                      const isOpen = !!open[l.key];
                      return (
                        <React.Fragment key={l.key}>
                          <tr className={`border-t border-border align-top ${l.valued ? '' : 'bg-muted/40 text-muted-foreground'}`}>
                            <td className="px-2 py-2"><button type="button" aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} details for ${l.item.ref}`} onClick={() => setOpen((o) => ({ ...o, [l.key]: !o[l.key] }))} className="text-muted-foreground hover:text-foreground">{isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button></td>
                            <td className="px-2 py-2 text-foreground">{l.componentName}{l.role === 'alternative' ? <span className="block text-xs text-muted-foreground">Alternative{l.alternativesFor ? ` to ${l.alternativesFor}` : ''}</span> : null}</td>
                            <td className="px-2 py-2 font-data text-foreground">{l.item.ref}</td>
                            <td className="px-2 py-2 text-foreground">{l.item.description}</td>
                            <td className="px-2 py-2"><span className="block text-foreground">{l.item.bill}</span><span className="block text-xs text-muted-foreground">{l.item.sourceFile}</span></td>
                            <td className="px-2 py-2 text-foreground">{l.item.unit || '—'}</td>
                            <td className="px-2 py-2 text-right tabular text-foreground">{l.quantityText}<span className="block text-xs text-muted-foreground">{l.quantityOrigin}</span></td>
                            <td className="px-2 py-2 text-right tabular text-foreground">{l.item.rate.state === 'value' ? l.item.rate.value : <span className="text-warning">{l.item.rate.state === 'missing' ? 'No rate' : 'Invalid'}</span>}</td>
                            <td className="px-2 py-2 text-right tabular font-semibold text-foreground">{l.manual && l.valued ? formatSigned(l.manual.amountSigned, l.manual.rate.currency) : ok && l.valued ? formatSigned(ok.signedAmount, ok.currency) : '—'}</td>
                            <td className="px-2 py-2"><span className={`whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${STATUS_TONE[l.status]}`}>{l.excluded ? (l.excluded.scope === 'cost_only' ? 'Cost excluded' : 'Excluded') : l.deferred ? 'Deferred' : l.manual ? (l.manual.rate.processedPvr ? 'Processed PVR · Pilot' : 'Manual rate · Proposed') : l.leftUnresolved ? 'Unresolved' : l.valued ? STATUS_LABEL[l.status] : 'Not valued'}</span></td>
                          </tr>
                          {isOpen ? (
                            <tr className="border-t border-border bg-background">
                              <td />
                              <td colSpan={9} className="px-2 py-3">
                                <div className="grid gap-3 text-sm md:grid-cols-2">
                                  <div><p className="font-semibold text-foreground">Why it matches</p><p className="text-muted-foreground">{l.why || 'No explanation returned.'}</p>{l.matchBasis.length > 0 ? <ul className="mt-1 list-disc pl-5 text-muted-foreground">{l.matchBasis.map((b) => <li key={b}>{b}</li>)}</ul> : null}{l.specConflict ? <p className="mt-1 text-warning">{l.specConflict}</p> : null}</div>
                                  <div><p className="font-semibold text-foreground">Source references</p><p className="font-data text-muted-foreground">{l.item.sourceFile} · {l.item.sheet}!{l.item.rowNumber}{l.item.rate.cell ? ` · rate ${l.item.rate.cell}` : ''}{l.item.cells.ref ? ` · ref ${l.item.cells.ref}` : ''}</p>{l.section ? <p className="text-muted-foreground">Section: {l.section}</p> : null}{l.preambleNote ? <p className="mt-1 text-muted-foreground">{l.preambleNote}</p> : null}</div>
                                  <div className="md:col-span-2"><p className="font-semibold text-foreground">Quantity derivation</p>{ok ? <><p className="font-data text-muted-foreground">{ok.conversion.derivation}</p><p className="font-data text-muted-foreground">{ok.formula}</p></> : <p className="text-muted-foreground">{l.statusNote || 'Not calculated.'}</p>}<p className="text-xs text-muted-foreground">{l.quantityOrigin}{l.quantitySource ? ` · ${l.quantitySource}` : ''}</p></div>
                                </div>
                                {!p.run?.drawingQuantitiesOnly && <div className="mt-2 flex flex-wrap gap-2">
                                  <button type="button" onClick={() => setEditing(editing === l.key ? null : l.key)} className="rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted">Edit quantity</button>
                                </div>}
                                {l.role === 'primary' && !l.excluded && !l.deferred ? <ResolutionButtons line={l} run={p.run!} onChooseRow={(rowId) => { p.onResolve(l.componentId, undefined); set({ chosenRow: { ...p.answers.chosenRow, [l.componentId]: rowId } }); }} onManual={() => setManualFor(l.componentId)} onExclude={() => setExcludeFor(l.componentId)} onDefer={() => setDeferFor(l.componentId)} onUnresolved={() => p.onResolve(l.componentId, { kind: 'unresolved', at: new Date().toISOString() })} /> : null}
                                {l.manual ? <p className="mt-2 text-xs text-muted-foreground">{l.manual.rate.processedPvr ? `Processed PVR · Pilot — ${l.manual.rate.processedPvr.file}, page ${l.manual.rate.processedPvr.page}, ${l.manual.rate.processedPvr.row} —` : 'Manual rate · Proposed —'} {l.manual.rate.currency} {l.manual.rate.value}/{l.manual.rate.unit} · {l.manual.rate.reason} · entered by {l.manual.rate.enteredBy} on {l.manual.rate.enteredAt.slice(0, 16).replace('T', ' ')}{l.manual.rate.reference ? ` · ref ${l.manual.rate.reference}` : ''}. Not commercially approved.</p> : null}
                                {l.manual ? <button type="button" onClick={() => p.onResolve(l.componentId, undefined)} className="mt-1 text-xs text-accent hover:underline">Remove manual rate</button> : null}
                                {!p.run?.drawingQuantitiesOnly && editing === l.key ? <QuantityEditor componentId={l.componentId} line={l} answers={p.answers} onChange={set} /> : null}
                              </td>
                            </tr>
                          ) : null}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {outcome.unmatched.length > 0 ? (
              <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
                <p className="font-semibold text-foreground">New item / rate required</p>
                <ul className="list-disc pl-5 text-muted-foreground">{outcome.unmatched.map((u) => <li key={u.componentId}><span className="text-foreground">{u.name}</span> — {u.reason}
                  <span className="ml-2 inline-flex flex-wrap gap-2 align-middle">
                    <button type="button" onClick={() => setManualFor(u.componentId)} className="rounded-md border border-input bg-card px-2 py-0.5 text-xs font-medium text-foreground hover:bg-muted">{p.run?.drawingQuantitiesOnly?'Cite processed PVR rate':'Enter manual rate'}</button>
                    <button type="button" onClick={() => setExcludeFor(u.componentId)} className="rounded-md border border-input bg-card px-2 py-0.5 text-xs font-medium text-foreground hover:bg-muted">Exclude from this assessment</button>
                  </span></li>)}</ul>
              </div>
            ) : null}
            <ExcludedSection lines={excludedRows} onRestore={(id) => p.onResolve(id, undefined)} />
            {deferredRows.length > 0 ? (
              <div className="mt-3 rounded-md border border-border" aria-label="Deferred items">
                <p className="px-3 py-2 text-sm font-semibold text-foreground">Deferred valuation ({deferredRows.length})</p>
                <ul className="divide-y divide-border border-t border-border">
                  {deferredRows.map((d) => (
                    <li key={d.componentId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                      <span><span className="font-medium text-foreground">{d.name}</span> <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">Deferred</span>
                        <span className="block text-xs text-muted-foreground">Reason: {d.reason} · {d.by} · {d.at.slice(0, 16).replace('T', ' ')}. Scope and schedule impact are retained.</span></span>
                      <button type="button" onClick={() => p.onResolve(d.componentId, undefined)} className="rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted">Restore to valuation</button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <ManualRateModal key={`mr-${manualFor ?? 'none'}`} open={!!manualFor} processedOnly={!!p.run?.drawingQuantitiesOnly} line={manualLine ?? (manualComp ? ({ componentName: manualComp.name } as RelatedLine) : null)} currency={outcome.currency || 'AED'} quantity={manualQty ? { value: manualQty.value, unit: manualQty.unit } : null} scope={manualComp} direction={manualComp?.action === 'omit' ? 'omission' : 'addition'} existing={manualFor && p.answers.resolutions?.[manualFor]?.kind === 'manual_rate' ? (p.answers.resolutions[manualFor] as Extract<LineResolution, { kind: 'manual_rate' }>).manual : undefined} onClose={() => setManualFor(null)} onSave={(m) => { if (manualFor) p.onResolve(manualFor, { kind: 'manual_rate', manual: m }); setManualFor(null); }} />
            <ExcludeModal key={`ex-${excludeFor ?? 'none'}`} open={!!excludeFor} line={excludeComp ? { componentName: excludeComp.name } : null} onClose={() => setExcludeFor(null)} onSave={(r) => { if (excludeFor) p.onResolve(excludeFor, r); setExcludeFor(null); }} />
            <DeferModal key={`df-${deferFor ?? 'none'}`} open={!!deferFor} line={deferComp ? { componentName: deferComp.name } : null} onClose={() => setDeferFor(null)} onSave={(r) => { if (deferFor) p.onResolve(deferFor, r); setDeferFor(null); }} />
            {outcome.rejectedModelRefs.length > 0 ? <p className="mt-2 text-xs text-muted-foreground">{outcome.rejectedModelRefs.length} model reference(s) were discarded because they were not in the uploaded BOQ set or the retrieved candidates.</p> : null}
          </section>

          <section className="rounded-lg border border-border bg-card p-5 shadow-sm" aria-labelledby="ni-title">
            <h2 id="ni-title" className="flex items-center gap-2 text-lg font-semibold text-foreground"><CircleHelp size={18} aria-hidden />C. Needs your input <span className="text-sm font-normal text-muted-foreground">({outcome.needs.length})</span></h2>
            {outcome.needs.length === 0 ? <p className="mt-2 text-muted-foreground">Nothing is unresolved. Every valued line has a rate, a supported quantity and compatible units.</p> : (
              <ul className="mt-3 space-y-3">
                {outcome.needs.map((n) => <NeedCard key={n.id} need={n} run={p.run!} answers={p.answers} onChange={set} />)}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

function QuantityEditor({ componentId, line, answers, onChange }: { componentId: string; line: RelatedLine; answers: UserAnswers; onChange: (p: Partial<UserAnswers>) => void }) {
  const cur = answers.quantity[componentId] ?? { value: '', unit: line.item.unit };
  return (
    <div className="mt-2 flex flex-wrap items-end gap-2 rounded-md border border-border bg-card p-3">
      <div><label className="text-xs text-muted-foreground" htmlFor={`q-${line.key}`}>Quantity <span className="rounded bg-secondary px-1 text-secondary-foreground">User-entered</span></label><input id={`q-${line.key}`} inputMode="decimal" value={cur.value} onChange={(e) => onChange({ quantity: { ...answers.quantity, [componentId]: { ...cur, value: e.target.value } } })} className="mt-0.5 block w-28 rounded-md border border-input bg-card px-2 py-1 text-right tabular text-foreground" /></div>
      <div><label className="text-xs text-muted-foreground" htmlFor={`u-${line.key}`}>Unit</label><input id={`u-${line.key}`} value={cur.unit} onChange={(e) => onChange({ quantity: { ...answers.quantity, [componentId]: { ...cur, unit: e.target.value } } })} className="mt-0.5 block w-20 rounded-md border border-input bg-card px-2 py-1 text-foreground" /></div>
      <button type="button" onClick={() => { const q = { ...answers.quantity }; delete q[componentId]; onChange({ quantity: q }); }} className="text-xs text-accent hover:underline">Clear</button>
    </div>
  );
}

function NeedCard({ need, run, answers, onChange }: { need: NeedsInput; run: AgentRun; answers: UserAnswers; onChange: (p: Partial<UserAnswers>) => void }) {
  const comp = run.scope.components.find((c) => c.id === need.componentId);
  const [qty, setQty] = useState({ value: '', unit: '' });
  const [deriv, setDeriv] = useState<Record<string, { value: string; unit: string }>>({});
  const [basis, setBasis] = useState('');
  const lineItem = need.kind === 'missing_dimension' ? run.set.items.find((i) => (run.shortlist[need.componentId ?? ''] ?? []).some((c) => c.item.id === i.id)) : null;
  const primary = need.componentId ? outcomeOf(run, answers).lines.find((l) => l.componentId === need.componentId && l.valued) : undefined;
  const plan = need.kind === 'missing_dimension' && comp?.quantity && primary ? planConversion(comp.quantity.unit, primary.item.unit) : null;
  void lineItem;

  const choose = (optId: string, rowId?: string) => {
    if (!need.componentId) return;
    if (need.kind === 'potential') { onChange({ includePotential: { ...answers.includePotential, [need.componentId]: optId === 'include' } }); return; }
    if (rowId) { onChange({ chosenRow: { ...answers.chosenRow, [need.componentId]: rowId } }); return; }
    if (need.kind === 'no_item' && optId === 'keep') onChange({ chosenRow: { ...answers.chosenRow, [need.componentId]: '__none__' } });
  };

  return (
    <li className="rounded-md border border-warning/40 bg-warning/5 p-4">
      <p className="flex items-center gap-2 font-semibold text-foreground"><AlertTriangle size={15} className="text-warning" aria-hidden />{need.title}</p>
      <p className="mt-1 text-sm text-foreground">{need.issue}</p>
      {need.evidence.length > 0 ? <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">{need.evidence.slice(0, 4).map((e) => <li key={e}>{e}</li>)}</ul> : null}
      <p className="mt-1 text-sm text-muted-foreground">Proposed: {need.proposal}</p>

      {!run.drawingQuantitiesOnly && need.kind === 'missing_dimension' && plan && plan.kind === 'needs_derivation' && need.componentId ? (
        <div className="mt-2 rounded-md border border-border bg-card p-3">
          <div className="flex flex-wrap gap-3">
            {plan.required.map((name) => (
              <div key={name} className="flex gap-1"><div><label className="text-xs capitalize text-muted-foreground" htmlFor={`${need.id}-${name}`}>{name}</label><input id={`${need.id}-${name}`} inputMode="decimal" value={deriv[name]?.value ?? ''} onChange={(e) => setDeriv((d) => ({ ...d, [name]: { value: e.target.value, unit: d[name]?.unit ?? 'm' } }))} className="mt-0.5 block w-24 rounded-md border border-input bg-card px-2 py-1 text-right tabular text-foreground" /></div><div><label className="text-xs text-muted-foreground" htmlFor={`${need.id}-${name}-u`}>Unit</label><input id={`${need.id}-${name}-u`} value={deriv[name]?.unit ?? 'm'} onChange={(e) => setDeriv((d) => ({ ...d, [name]: { value: d[name]?.value ?? '', unit: e.target.value } }))} className="mt-0.5 block w-16 rounded-md border border-input bg-card px-2 py-1 text-foreground" /></div></div>
            ))}
          </div>
          <label className="mt-2 block text-xs text-muted-foreground" htmlFor={`${need.id}-basis`}>Source of these values, or the assumption you confirm</label>
          <input id={`${need.id}-basis`} value={basis} onChange={(e) => setBasis(e.target.value)} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1 text-foreground" placeholder="For example: Drawing R4-01 typical section" />
          <button type="button" disabled={plan.required.some((n) => !deriv[n]?.value?.trim()) || !basis.trim()} onClick={() => onChange({ derivation: { ...answers.derivation, [need.componentId!]: { inputs: Object.fromEntries(plan.required.map((n) => [n, { value: deriv[n].value, unit: deriv[n].unit || 'm' }])), basis } } })} className="mt-2 rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground">Apply derivation</button>
        </div>
      ) : null}

      {run.drawingQuantitiesOnly && (need.kind === 'missing_quantity' || need.kind === 'missing_dimension') ?
        <p className="mt-2 text-sm font-medium">Supply matching original and revised drawings with verified units, and rerun the takeoff. Review entries and benchmark quantities cannot price this line.</p> : null}
      {!run.drawingQuantitiesOnly && need.kind === 'missing_quantity' && need.componentId ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div><label className="text-xs text-muted-foreground" htmlFor={`${need.id}-q`}>Quantity</label><input id={`${need.id}-q`} inputMode="decimal" value={qty.value} onChange={(e) => setQty({ ...qty, value: e.target.value })} className="mt-0.5 block w-28 rounded-md border border-input bg-card px-2 py-1 text-right tabular text-foreground" /></div>
          <div><label className="text-xs text-muted-foreground" htmlFor={`${need.id}-u`}>Unit</label><input id={`${need.id}-u`} value={qty.unit} onChange={(e) => setQty({ ...qty, unit: e.target.value })} className="mt-0.5 block w-20 rounded-md border border-input bg-card px-2 py-1 text-foreground" /></div>
          <button type="button" disabled={!qty.value.trim() || !qty.unit.trim()} onClick={() => onChange({ quantity: { ...answers.quantity, [need.componentId!]: qty } })} className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground">Use this quantity (user-entered)</button>
        </div>
      ) : null}

      {['no_item', 'ambiguous_candidates', 'potential', 'overlap'].includes(need.kind) && need.options.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Response options">
          {need.options.map((o) => (
            <button key={o.id + (o.rowId ?? '')} type="button" onClick={() => {
              if (need.kind === 'overlap') { const drop = need.options.filter((x) => x.rowId && x.rowId !== o.rowId).map((x) => x.rowId!); onChange({ excluded: { ...answers.excluded, ...Object.fromEntries(drop.map((d) => [d, true])) } }); return; }
              choose(o.id, o.rowId);
            }} className="rounded-md border border-input bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted">{o.label}</button>
          ))}
        </div>
      ) : null}
    </li>
  );
}

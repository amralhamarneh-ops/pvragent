'use client';

import React, { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Undo2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { formatSigned } from '@/lib/boq/calc';
import { priceWithManualRate, type CostSummary, type ExclusionScope, type LineResolution, type ManualRate } from '@/lib/boq/resolutions';
import type { RelatedLine } from '@/lib/boq/matchEngine';
import type { AgentRun } from '@/lib/boq/agentClient';

const ACTOR = 'Current user';

export function ResolutionButtons({ line, run, onChooseRow, onManual, onExclude, onUnresolved, onDefer }: {
  line: RelatedLine;
  run: AgentRun;
  onChooseRow: (rowId: string) => void;
  onManual: () => void;
  onExclude: () => void;
  onUnresolved: () => void;
  onDefer?: () => void;
}) {
  const [pick, setPick] = useState(false);
  const cands = run.shortlist[line.componentId] ?? [];
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" role="group" aria-label={`Resolve ${line.componentName}`}>
      <span className="relative">
        <button type="button" aria-expanded={pick} onClick={() => setPick((v) => !v)} className="rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted">Choose another BOQ rate</button>
        {pick ? (
          <select aria-label={`Choose another BOQ rate for ${line.componentName}`} defaultValue="" className="ml-2 rounded-md border border-input bg-card px-2 py-1 text-xs text-foreground" onChange={(e) => { if (e.target.value) { onChooseRow(e.target.value); setPick(false); } }}>
            <option value="">Choose a candidate…</option>
            {cands.map((c) => <option key={c.item.id} value={c.item.id}>{c.item.ref} · {c.item.description.slice(0, 40)} ({c.item.unit}) · {c.item.sourceFile}</option>)}
          </select>
        ) : null}
      </span>
      <button type="button" onClick={onManual} className="rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted">Enter manual rate</button>
      <button type="button" onClick={onExclude} className="rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted">Exclude from this assessment</button>
      {onDefer ? <button type="button" onClick={onDefer} className="rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted">Defer valuation</button> : null}
      <button type="button" onClick={onUnresolved} className="rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted">Leave unresolved</button>
    </div>
  );
}

export function ManualRateModal({ open, line, currency, quantity, direction, existing, onClose, onSave }: {
  open: boolean;
  line: RelatedLine | null;
  currency: string;
  /** The change quantity and unit that will be priced. */
  quantity: { value: string; unit: string } | null;
  direction: 'addition' | 'omission';
  existing?: ManualRate;
  onClose: () => void;
  onSave: (m: ManualRate) => void;
}) {
  const [rate, setRate] = useState(existing?.value ?? '');
  const [cur, setCur] = useState(existing?.currency ?? currency);
  const [unit, setUnit] = useState(existing?.unit ?? quantity?.unit ?? '');
  const [reason, setReason] = useState(existing?.reason ?? '');
  const [reference, setReference] = useState(existing?.reference ?? '');
  const [attachment, setAttachment] = useState(existing?.attachmentName ?? '');
  const [inc, setInc] = useState(existing?.inclusions ?? { labour: true, materials: true, plant: true, overheads: true, profit: true });
  const [rateBasis, setRateBasis] = useState(existing?.rateBasis ?? '');
  const [exclNote, setExclNote] = useState(existing?.exclusionsNote ?? '');
  const [zeroBasis, setZeroBasis] = useState(existing?.zeroBasis ?? '');

  const priced = useMemo(() => {
    if (!quantity) return null;
    return priceWithManualRate({ quantity: quantity.value, quantityUnit: quantity.unit, rate, rateUnit: unit, currency: cur, direction, zeroBasis, requireZeroBasis: true });
  }, [quantity, rate, unit, cur, direction, zeroBasis]);

  if (!line) return null;
  const rateBlank = rate.trim() === '';
  const isZero = !rateBlank && /^0+(\.0+)?$/.test(rate.replace(/,/g, '').trim());
  const canSave = !!priced && priced.ok && reason.trim().length > 0 && rateBasis.trim().length > 0;

  const save = () => {
    if (!canSave) return;
    onSave({ value: rate.replace(/,/g, '').trim(), currency: cur.trim() || currency, unit: unit.trim(), reason: reason.trim(), reference: reference.trim(), attachmentName: attachment, inclusions: inc, exclusionsNote: exclNote.trim(), rateBasis: rateBasis.trim(), zeroBasis: isZero ? zeroBasis.trim() : '', enteredBy: ACTOR, enteredAt: new Date().toISOString(), status: 'proposed' });
  };

  return (
    <Modal open={open} title={`Manual rate · ${line.componentName}`} onClose={onClose} footer={
      <>
        <button type="button" onClick={onClose} className="rounded-md border border-input bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted">Cancel</button>
        <button type="button" disabled={!canSave} onClick={save} className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground">Save as proposed rate</button>
      </>
    }>
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">Case-specific override. The source BOQ is not changed and this rate is not reused in other cases. It is saved as <span className="font-medium text-foreground">Manual rate · Proposed</span> and is not commercially approved.</p>
        <div className="grid grid-cols-3 gap-2">
          <div><label htmlFor="mr-rate" className="text-xs text-muted-foreground">Rate</label><input id="mr-rate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-right tabular text-foreground" /></div>
          <div><label htmlFor="mr-cur" className="text-xs text-muted-foreground">Currency</label><input id="mr-cur" value={cur} onChange={(e) => setCur(e.target.value)} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground" /></div>
          <div><label htmlFor="mr-unit" className="text-xs text-muted-foreground">Per unit</label><input id="mr-unit" value={unit} onChange={(e) => setUnit(e.target.value)} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground" /></div>
        </div>
        {rateBlank ? <p className="text-xs text-muted-foreground">Leaving the rate blank keeps the item unpriced. Enter 0 only for an explicit zero rate, and state why below.</p> : null}
        {isZero ? <div><label htmlFor="mr-zero" className="text-xs text-muted-foreground">Basis for a zero rate (required)</label><input id="mr-zero" value={zeroBasis} onChange={(e) => setZeroBasis(e.target.value)} placeholder="For example: free-issue by the employer" className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground" /></div> : null}
        <div><label htmlFor="mr-reason" className="text-xs text-muted-foreground">Reason for the manual rate (required)</label><input id="mr-reason" value={reason} onChange={(e) => setReason(e.target.value)} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground" /></div>
        <div className="grid grid-cols-2 gap-2">
          <div><label htmlFor="mr-basis" className="text-xs text-muted-foreground">Rate basis (required)</label>
            <select id="mr-basis" value={rateBasis} onChange={(e) => setRateBasis(e.target.value)} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground">
              <option value="">Choose…</option><option>Quotation</option><option>Similar BOQ item</option><option>Market rate</option><option>Daywork</option><option>Engineer&apos;s estimate</option><option>Contractor proposal</option><option>Other</option>
            </select></div>
          <div><label htmlFor="mr-excl" className="text-xs text-muted-foreground">Rate excludes (optional)</label><input id="mr-excl" value={exclNote} onChange={(e) => setExclNote(e.target.value)} placeholder="Nothing is added to cover this" className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground" /></div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div><label htmlFor="mr-ref" className="text-xs text-muted-foreground">Source / reference (optional)</label><input id="mr-ref" value={reference} onChange={(e) => setReference(e.target.value)} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground" /></div>
          <div><label htmlFor="mr-att" className="text-xs text-muted-foreground">Supporting attachment (optional)</label><input id="mr-att" type="file" onChange={(e) => setAttachment(e.target.files?.[0]?.name ?? '')} className="mt-0.5 w-full text-xs text-foreground" />{attachment ? <p className="text-xs text-muted-foreground">{attachment} (name recorded; file not uploaded)</p> : null}</div>
        </div>
        <fieldset>
          <legend className="text-xs text-muted-foreground">Rate includes</legend>
          <div className="mt-1 flex flex-wrap gap-3">
            {(['labour', 'materials', 'plant', 'overheads', 'profit'] as const).map((k) => (
              <label key={k} className="flex items-center gap-1.5 capitalize"><input type="checkbox" checked={inc[k]} onChange={(e) => setInc({ ...inc, [k]: e.target.checked })} className="h-4 w-4 accent-[var(--accent)]" />{k}</label>
            ))}
          </div>
        </fieldset>
        <div aria-live="polite" className="rounded-md border border-border bg-background px-3 py-2">
          {!quantity ? <p className="text-warning">This component has no quantity yet, so no amount can be shown. Enter a quantity first.</p> : priced && priced.ok ? (
            <>
              <p className="text-muted-foreground">Quantity × rate</p>
              <p className="font-data text-foreground">{priced.formula}</p>
              <p className="mt-1 text-lg font-bold tabular text-foreground">{formatSigned(priced.signedAmount, priced.currency)}</p>
            </>
          ) : priced && !priced.ok ? (
            <p role="alert" className="flex items-start gap-2 text-foreground"><AlertTriangle size={15} className="mt-0.5 text-destructive" aria-hidden />{priced.message}</p>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

export function ExcludeModal({ open, line, onClose, onSave }: {
  open: boolean;
  line: { componentName: string } | null;
  onClose: () => void;
  onSave: (r: Extract<LineResolution, { kind: 'excluded' }>) => void;
}) {
  const [scope, setScope] = useState<ExclusionScope>('cost_only');
  const [reason, setReason] = useState('');
  if (!line) return null;
  return (
    <Modal open={open} title={`Exclude · ${line.componentName}`} onClose={onClose} footer={
      <>
        <button type="button" onClick={onClose} className="rounded-md border border-input bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted">Cancel</button>
        <button type="button" disabled={reason.trim() === ''} onClick={() => { onSave({ kind: 'excluded', scope, reason: reason.trim(), by: ACTOR, at: new Date().toISOString() }); setReason(''); setScope('cost_only'); }} className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground">Exclude</button>
      </>
    }>
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">The BOQ row and original evidence are kept. You can restore the line at any time.</p>
        <fieldset className="space-y-2">
          <legend className="text-xs text-muted-foreground">Scope of exclusion</legend>
          <label className="flex items-start gap-2"><input type="radio" name="ex-scope" checked={scope === 'cost_only'} onChange={() => setScope('cost_only')} className="mt-1 h-4 w-4 accent-[var(--accent)]" /><span><span className="font-medium text-foreground">Exclude from cost only (default)</span><span className="block text-muted-foreground">Keeps the scope and its schedule impact. Shown as “Cost excluded”.</span></span></label>
          <label className="flex items-start gap-2"><input type="radio" name="ex-scope" checked={scope === 'scenario'} onChange={() => setScope('scenario')} className="mt-1 h-4 w-4 accent-[var(--accent)]" /><span><span className="font-medium text-foreground">Exclude from this scenario entirely</span><span className="block text-muted-foreground">Removes its cost and schedule effects from this scenario. Schedule results will need recalculation. Activities shared with other included scope are kept.</span></span></label>
        </fieldset>
        <div><label htmlFor="ex-reason" className="text-xs text-muted-foreground">Reason (required)</label><input id="ex-reason" value={reason} onChange={(e) => setReason(e.target.value)} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground" /></div>
      </div>
    </Modal>
  );
}

export function DeferModal({ open, line, onClose, onSave }: {
  open: boolean;
  line: { componentName: string } | null;
  onClose: () => void;
  onSave: (r: Extract<LineResolution, { kind: 'deferred' }>) => void;
}) {
  const [reason, setReason] = useState('');
  if (!line) return null;
  return (
    <Modal open={open} title={`Defer valuation · ${line.componentName}`} onClose={onClose} footer={
      <>
        <button type="button" onClick={onClose} className="rounded-md border border-input bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted">Cancel</button>
        <button type="button" disabled={reason.trim() === ''} onClick={() => { onSave({ kind: 'deferred', reason: reason.trim(), by: ACTOR, at: new Date().toISOString() }); setReason(''); }} className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground">Defer</button>
      </>
    }>
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">The scope stays in the assessment and keeps its schedule impact. It carries no amount, is not treated as zero, and the total is shown as partial until it is valued.</p>
        <div><label htmlFor="df-reason" className="text-xs text-muted-foreground">Reason (required)</label><input id="df-reason" value={reason} onChange={(e) => setReason(e.target.value)} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground" /></div>
      </div>
    </Modal>
  );
}

export function CostSummaryPanel({ summary, scheduleStale, costStale }: { summary: CostSummary; scheduleStale: boolean; costStale: boolean }) {
  const f = (v: string | null) => (v === null ? '—' : formatSigned(v, summary.currency));
  return (
    <div className="mt-3 rounded-md border border-border bg-background p-3" aria-label="Cost summary">
      <div className="grid gap-3 text-sm sm:grid-cols-5">
        <div><p className="text-muted-foreground">{summary.fullyPriced ? 'Total (fully priced)' : 'Priced subtotal (partial)'}</p><p className="text-lg font-bold tabular text-foreground">{f(summary.pricedSubtotal)}</p><p className="text-xs text-muted-foreground">{summary.pricedCount} priced line{summary.pricedCount === 1 ? '' : 's'}</p></div>
        <div><p className="text-muted-foreground">Unpriced scope</p><p className="text-lg font-bold tabular text-foreground">{summary.unpricedIncluded}</p><p className="text-xs text-muted-foreground">no value assigned</p></div>
        <div><p className="text-muted-foreground">Deferred</p><p className="text-lg font-bold tabular text-foreground">{summary.deferredCount}</p><p className="text-xs text-muted-foreground">valuation postponed</p></div>
        <div><p className="text-muted-foreground">Excluded items</p><p className="text-lg font-bold tabular text-foreground">{summary.excludedCount}</p><p className="text-xs text-muted-foreground">{summary.excludedCostOnly} cost only · {summary.excludedScenario} scenario</p></div>
        <div><p className="text-muted-foreground">Manual · Proposed</p><p className="text-lg font-bold tabular text-foreground">{f(summary.manualProposedAmount)}</p><p className="text-xs text-muted-foreground">{summary.manualProposedCount} line{summary.manualProposedCount === 1 ? '' : 's'}, not approved</p></div>
      </div>
      {!summary.fullyPriced ? <p className="mt-2 text-sm text-foreground">Partial assessment: this subtotal is not the complete variation value. Unpriced and deferred scope has no value assigned.</p> : null}
      {summary.manualProposedCount > 0 ? <p className="mt-1 text-sm text-muted-foreground">The subtotal includes manual rates that remain proposed.</p> : null}
      {costStale ? <p role="status" className="mt-1 text-sm text-foreground">Cost changed since the last confirmation. Confirm the assessment again to save it.</p> : null}
      {scheduleStale ? <p role="alert" className="mt-1 text-sm text-foreground">Scope changed for the whole scenario. Schedule results are stale and need recalculation.</p> : null}
    </div>
  );
}

export function ExcludedSection({ lines, onRestore }: {
  lines: { componentId: string; name: string; scope: ExclusionScope; reason: string; by: string; at: string; detail: string }[];
  onRestore: (componentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (lines.length === 0) return null;
  return (
    <div className="mt-3 rounded-md border border-border">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold text-foreground">
        {open ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}Excluded items ({lines.length})
      </button>
      {open ? (
        <ul className="divide-y divide-border border-t border-border">
          {lines.map((l) => (
            <li key={l.componentId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span>
                <span className="font-medium text-foreground">{l.name}</span>{' '}
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">{l.scope === 'cost_only' ? 'Cost excluded' : 'Excluded from scenario'}</span>
                <span className="block text-muted-foreground">{l.detail}</span>
                <span className="block text-xs text-muted-foreground">Reason: {l.reason} · {l.by} · {l.at.slice(0, 16).replace('T', ' ')}</span>
              </span>
              <button type="button" onClick={() => onRestore(l.componentId)} className="inline-flex items-center gap-1 rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted"><Undo2 size={13} aria-hidden />Restore</button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

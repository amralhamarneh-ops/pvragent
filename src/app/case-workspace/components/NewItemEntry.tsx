'use client';

import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { formatSigned } from '@/lib/boq/calc';
import { EMPTY_DRAFT, RATE_BASIS_LABEL, draftFromItem, itemFromDraft, previewDraft, validateDraft, type AssessmentItem, type ItemDraft, type NewItemChangeType, type RateBasis } from '@/lib/boq/newItem';
import { checkItemDimension } from '@/lib/boq/valuation';
import { retrieveCandidates } from '@/lib/boq/retrieve';
import type { BoqSet } from '@/lib/boq/matchEngine';
import type { BoqItemRecord } from '@/lib/boq/types';

const ACTOR = 'Current user';

interface Props {
  open: boolean;
  caseId: string;
  currency: string;
  /** Initial values, e.g. prefilled from an identified scope component. */
  initial: ItemDraft | null;
  existing?: AssessmentItem;
  set: BoqSet | null;
  scopeOptions: { id: string; label: string }[];
  onClose: () => void;
  onSaveItem: (item: AssessmentItem) => void;
  onAddBoqItem: (item: BoqItemRecord, componentId: string) => void;
  newId: () => string;
}

export default function NewItemEntry(p: Props) {
  const [mode, setMode] = useState<'existing' | 'new'>(p.initial || p.existing ? 'new' : 'existing');
  const [d, setD] = useState<ItemDraft>(() => (p.existing ? { ...EMPTY_DRAFT, ...draftFromItem(p.existing) } : { ...EMPTY_DRAFT, currency: p.currency, ...(p.initial ?? {}) }));
  const [q, setQ] = useState('');
  const [linkFor, setLinkFor] = useState(p.initial?.linkedScope ?? p.scopeOptions[0]?.id ?? '');
  const [touched, setTouched] = useState(false);

  const issues = useMemo(() => validateDraft(d), [d]);
  const preview = useMemo(() => previewDraft(d), [d]);
  const dim = useMemo(() => checkItemDimension(d.changeUnit, d.uom, d.supporting), [d.changeUnit, d.uom, d.supporting]);
  const isZeroRate = !d.unpriced && /^0+(\.0+)?$/.test(d.rate.replace(/,/g, '').trim());
  const setSupport = (name: string, patch: Partial<{ value: string; unit: string; evidence: string }>) =>
    setD((cur) => {
      const rest = cur.supporting.filter((s) => s.name !== name);
      const prev = cur.supporting.find((s) => s.name === name) ?? { name, value: '', unit: 'm', evidence: '' };
      return { ...cur, supporting: [...rest, { ...prev, ...patch }] };
    });
  const hits = useMemo(() => {
    if (!p.set || q.trim().length < 2) return [] as BoqItemRecord[];
    const r = retrieveCandidates(p.set.items, p.set.context, { name: q, discipline: '', workType: '', material: '', specification: '', location: '', searchTerms: [q], expectedUnit: '' }, 8);
    return r.map((x) => x.item);
  }, [p.set, q]);

  const set = <K extends keyof ItemDraft>(k: K, v: ItemDraft[K]) => setD((cur) => ({ ...cur, [k]: v }));
  const err = (f: keyof ItemDraft) => (touched ? issues.find((i) => i.field === f)?.message : undefined);

  const save = () => {
    setTouched(true);
    if (issues.length > 0) return;
    p.onSaveItem(itemFromDraft(d, p.caseId, p.existing?.id ?? p.newId(), ACTOR, p.existing));
  };

  return (
    <Modal open={p.open} title={p.existing ? 'Edit assessment item' : 'Add scope item'} onClose={p.onClose} footer={
      mode === 'new' ? (
        <>
          <button type="button" onClick={p.onClose} className="rounded-md border border-input bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted">Cancel</button>
          <button type="button" onClick={save} className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90">Save assessment item</button>
        </>
      ) : <button type="button" onClick={p.onClose} className="rounded-md border border-input bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted">Close</button>
    }>
      <div className="space-y-3 text-sm">
        {!p.existing ? (
          <div role="tablist" aria-label="Item source" className="flex overflow-hidden rounded-md border border-input">
            <button type="button" role="tab" aria-selected={mode === 'existing'} onClick={() => setMode('existing')} className={`flex-1 px-3 py-1.5 font-medium ${mode === 'existing' ? 'bg-primary text-primary-foreground' : 'bg-card text-foreground hover:bg-muted'}`}>Add existing BOQ item</button>
            <button type="button" role="tab" aria-selected={mode === 'new'} onClick={() => setMode('new')} className={`flex-1 px-3 py-1.5 font-medium ${mode === 'new' ? 'bg-primary text-primary-foreground' : 'bg-card text-foreground hover:bg-muted'}`}>Create new assessment item</button>
          </div>
        ) : null}

        {mode === 'existing' ? (
          <div className="space-y-2">
            <p className="text-muted-foreground">Search every uploaded BOQ file. The row stays in its source file; nothing is copied back.</p>
            {p.scopeOptions.length > 0 ? (
              <div><label htmlFor="ni-link-e" className="text-xs text-muted-foreground">Attach to scope</label>
                <select id="ni-link-e" value={linkFor} onChange={(e) => setLinkFor(e.target.value)} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground">{p.scopeOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></div>
            ) : <p className="text-warning">No scope has been identified yet. Run the analysis first, or create a new assessment item.</p>}
            <div className="relative"><Search size={15} className="pointer-events-none absolute left-3 top-2.5 text-muted-foreground" aria-hidden /><input aria-label="Search all BOQ files" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by reference or description" className="w-full rounded-md border border-input bg-card py-2 pl-9 pr-3 text-foreground" /></div>
            <ul className="max-h-56 divide-y divide-border overflow-auto rounded-md border border-border">
              {hits.length === 0 ? <li className="px-3 py-3 text-muted-foreground">{q.trim().length < 2 ? 'Type at least two characters.' : 'No matching item in the uploaded BOQ files.'}</li> : hits.map((i) => (
                <li key={i.id} className="flex items-start justify-between gap-2 px-3 py-2">
                  <span><span className="font-data text-foreground">{i.ref}</span> <span className="text-foreground">{i.description}</span><span className="block text-xs text-muted-foreground">{i.sourceFile} · {i.sheet}!{i.rowNumber} · {i.unit || 'no unit'} · {i.rate.state === 'value' ? `${i.currency} ${i.rate.value}` : 'no rate'}</span></span>
                  <button type="button" disabled={!linkFor} onClick={() => p.onAddBoqItem(i, linkFor)} className="shrink-0 rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50">Add</button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-muted-foreground">Case-specific. The source BOQ is not changed. Saved as <span className="font-medium text-foreground">Proposed</span>; nothing here is commercially approved.</p>
            {d.prefillSource ? <p className="rounded-md bg-secondary px-3 py-1.5 text-xs text-secondary-foreground">{d.prefillSource}</p> : null}
            <div><label htmlFor="ni-desc" className="text-xs text-muted-foreground">Description</label><input id="ni-desc" value={d.description} onChange={(e) => set('description', e.target.value)} aria-invalid={!!err('description')} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground" />{err('description') ? <p role="alert" className="text-xs text-destructive">{err('description')}</p> : null}</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div><label htmlFor="ni-uom" className="text-xs text-muted-foreground">UOM</label><input id="ni-uom" value={d.uom} onChange={(e) => set('uom', e.target.value)} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground" />{err('uom') ? <p role="alert" className="text-xs text-destructive">{err('uom')}</p> : null}</div>
              <div><label htmlFor="ni-qty" className="text-xs text-muted-foreground">Quantity</label><input id="ni-qty" inputMode="decimal" disabled={d.quantityUnknown} value={d.quantityUnknown ? '' : d.quantity} onChange={(e) => set('quantity', e.target.value)} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-right tabular text-foreground disabled:bg-muted" />{err('quantity') ? <p role="alert" className="text-xs text-destructive">{err('quantity')}</p> : null}</div>
              <div><label htmlFor="ni-rate" className="text-xs text-muted-foreground">Rate</label><input id="ni-rate" inputMode="decimal" disabled={d.unpriced} value={d.unpriced ? '' : d.rate} onChange={(e) => set('rate', e.target.value)} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-right tabular text-foreground disabled:bg-muted" />{err('rate') ? <p role="alert" className="text-xs text-destructive">{err('rate')}</p> : null}</div>
              <div><label htmlFor="ni-cur" className="text-xs text-muted-foreground">Currency</label><input id="ni-cur" value={d.currency} onChange={(e) => set('currency', e.target.value)} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground" /></div>
            </div>
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2"><input type="checkbox" checked={d.quantityUnknown} onChange={(e) => set('quantityUnknown', e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />Quantity not known yet</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={d.unpriced} onChange={(e) => set('unpriced', e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />Leave unpriced</label>
            </div>
            {isZeroRate ? <div><label htmlFor="ni-zero" className="text-xs text-muted-foreground">Basis for a zero rate (required)</label><input id="ni-zero" value={d.zeroBasis} onChange={(e) => set('zeroBasis', e.target.value)} placeholder="For example: free-issue by the employer" className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground" />{err('zeroBasis') ? <p role="alert" className="text-xs text-destructive">{err('zeroBasis')}</p> : null}</div> : null}
            {d.changeUnit ? (
              <div className="rounded-md border border-border bg-background px-3 py-2">
                <p className="text-xs text-muted-foreground">Linked change quantity is in <span className="font-medium text-foreground">{d.changeUnit}</span>; this item is priced per <span className="font-medium text-foreground">{d.uom || '…'}</span>.</p>
                {!dim.ok ? (
                  <div className="mt-1 space-y-2">
                    <p role="alert" className="text-xs text-destructive">{dim.message}</p>
                    {dim.kind === 'needs_dimensions' ? dim.required.map((name) => {
                      const s = d.supporting.find((x) => x.name === name);
                      return (
                        <div key={name} className="grid grid-cols-[1fr_5rem] gap-2 sm:grid-cols-[6rem_1fr_5rem_1fr]">
                          <span className="self-center text-xs capitalize text-foreground">{name}</span>
                          <input aria-label={`${name} value`} inputMode="decimal" value={s?.value ?? ''} onChange={(e) => setSupport(name, { value: e.target.value })} className="rounded-md border border-input bg-card px-2 py-1 text-right tabular text-foreground" />
                          <input aria-label={`${name} unit`} value={s?.unit ?? 'm'} onChange={(e) => setSupport(name, { unit: e.target.value })} className="rounded-md border border-input bg-card px-2 py-1 text-foreground" />
                          <input aria-label={`${name} evidence`} placeholder="Where does this come from?" value={s?.evidence ?? ''} onChange={(e) => setSupport(name, { evidence: e.target.value })} className="col-span-2 rounded-md border border-input bg-card px-2 py-1 text-foreground sm:col-span-1" />
                        </div>
                      );
                    }) : null}
                  </div>
                ) : <p className="mt-1 text-xs text-muted-foreground">{dim.note}</p>}
              </div>
            ) : null}
            <div><label htmlFor="ni-inex" className="text-xs text-muted-foreground">Rate includes / excludes (optional)</label><input id="ni-inex" value={d.inclusionsExclusions} onChange={(e) => set('inclusionsExclusions', e.target.value)} placeholder="Nothing is added automatically to cover an exclusion" className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground" /></div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div><label htmlFor="ni-type" className="text-xs text-muted-foreground">Change type</label>
                <select id="ni-type" value={d.changeType} onChange={(e) => set('changeType', e.target.value as NewItemChangeType)} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground">
                  <option value="addition">Addition</option><option value="omission">Omission</option><option value="substitution">Substitution</option><option value="rework">Rework</option>
                </select></div>
              <div><label htmlFor="ni-loc" className="text-xs text-muted-foreground">Location</label><input id="ni-loc" value={d.location} onChange={(e) => set('location', e.target.value)} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground" /></div>
              <div><label htmlFor="ni-scope" className="text-xs text-muted-foreground">Linked scope / drawing change</label>
                <select id="ni-scope" value={d.linkedScope} onChange={(e) => { const o = p.scopeOptions.find((x) => x.id === e.target.value); setD((c) => ({ ...c, linkedScope: e.target.value, linkedScopeLabel: o?.label ?? '' })); }} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground">
                  <option value="">Not linked</option>{p.scopeOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select></div>
              <div><label htmlFor="ni-basis" className="text-xs text-muted-foreground">Rate basis</label>
                <select id="ni-basis" value={d.rateBasis} onChange={(e) => set('rateBasis', e.target.value as RateBasis | '')} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground">
                  <option value="">Not stated</option>{(Object.keys(RATE_BASIS_LABEL) as RateBasis[]).map((k) => <option key={k} value={k}>{RATE_BASIS_LABEL[k]}</option>)}
                </select>{err('rateBasis') ? <p role="alert" className="text-xs text-destructive">{err('rateBasis')}</p> : null}</div>
            </div>
            <div><label htmlFor="ni-ref" className="text-xs text-muted-foreground">Supporting reference</label><input id="ni-ref" value={d.supportingReference} onChange={(e) => set('supportingReference', e.target.value)} placeholder="Quotation no., drawing, email, clause" className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground" /></div>
            <div aria-live="polite" className="rounded-md border border-border bg-background px-3 py-2">
              <p className="text-muted-foreground">Quantity × rate</p>
              <p className="font-data text-foreground">{preview.formula}</p>
              {preview.signedAmount !== null ? <p className="mt-1 text-lg font-bold tabular text-foreground">{formatSigned(preview.signedAmount, d.currency)}</p> : <p className="mt-1 text-sm font-semibold text-warning">{preview.state === 'unpriced' ? 'Unpriced - not zero' : 'No amount'}</p>}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

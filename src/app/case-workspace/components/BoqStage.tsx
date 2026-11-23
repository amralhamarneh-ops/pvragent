'use client';

import React, { useMemo, useState } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import ConfidenceBar from '@/components/ui/ConfidenceBar';
import { BOQ_BILLS, BOQ_ITEMS, findBoqItem, textSimilarity, toAlternative } from '@/lib/mapping/boqEngine';
import type { BoqMapping, BoqStatus, StageStatus } from '@/lib/mapping/types';
import type { StageKey } from '@/lib/mapping/useCaseStore';

interface BoqStageProps {
  status: StageStatus;
  boq: BoqMapping[];
  bills: number[];
  onBills: (b: number[]) => void;
  onChange: (next: BoqMapping[]) => void;
  onRun: () => void;
  running: boolean;
  onEdited: (stage: StageKey) => void;
  explanations: Record<string, string>;
  explainNote: string;
}

const STATUS_LABEL: Record<BoqStatus, string> = { confirmed: 'Confirmed from BoQ', needs_confirmation: 'Needs confirmation', inferred: 'Inferred' };
const STATUS_CLASS: Record<BoqStatus, string> = { confirmed: 'bg-success/10 text-success', needs_confirmation: 'bg-warning/20 text-foreground', inferred: 'bg-accent/10 text-accent' };
const GROUPS: { cls: BoqMapping['class']; title: string }[] = [
  { cls: 'addition', title: 'Additions' },
  { cls: 'omission', title: 'Omissions' },
  { cls: 'abortive', title: 'Abortive works' },
  { cls: 'new', title: 'Not in BoQ' },
];

export default function BoqStage({ status, boq, bills, onBills, onChange, onRun, running, onEdited, explanations, explainNote }: BoqStageProps) {
  const [open, setOpen] = useState<string | null>('BM-01');
  const [query, setQuery] = useState('');
  const [addNote, setAddNote] = useState('');

  const update = (id: string, p: Partial<BoqMapping>) => { onChange(boq.map((m) => (m.id === id ? { ...m, ...p } : m))); onEdited('boq'); };
  const counts = useMemo(() => ({
    sel: boq.filter((m) => m.included).length,
    add: boq.filter((m) => m.included && m.class === 'addition').length,
    om: boq.filter((m) => m.included && m.class === 'omission').length,
    ab: boq.filter((m) => m.included && m.class === 'abortive').length,
    nw: boq.filter((m) => m.included && m.class === 'new').length,
  }), [boq]);

  const results = useMemo(() => {
    const q = query.trim();
    if (q.length < 2) return [];
    return BOQ_ITEMS.map((i) => ({ i, s: i.ref.includes(q) ? 1 : textSimilarity(q, i.description) })).filter((r) => r.s > 0.05).sort((a, b) => b.s - a.s).slice(0, 4).map((r) => r.i);
  }, [query]);

  const swap = (m: BoqMapping, altRef: string) => {
    const alt = findBoqItem(altRef);
    if (!alt) return;
    const old = findBoqItem(m.boqRef);
    const nextAlts = [...m.alternatives.filter((a) => a.boqRef !== altRef), ...(old ? [toAlternative({ item: old, score: 0.6, unitOk: true }, 'Swapped out by you.')] : [])].slice(0, 3);
    update(m.id, { boqRef: alt.ref, description: alt.description, bill: alt.bill, unit: alt.unit, rateRef: alt.rate, preamble: alt.preamble, status: 'needs_confirmation', confidence: Math.min(m.confidence, 84), alternatives: nextAlts, sources: `Bill ${alt.bill}, sheet ${alt.sheet}, cell ${alt.cell}. Swapped by you.` });
  };

  const addItem = (ref: string) => {
    const it = findBoqItem(ref);
    if (!it) return;
    if (boq.some((m) => m.boqRef === it.ref)) { setAddNote(`${it.ref} is already in the list.`); return; }
    const base = boq.find((m) => m.unit === it.unit) ?? boq[0];
    const row: BoqMapping = {
      id: `BM-M${boq.length + 1}`, changeIds: base?.changeIds ?? [], boqRef: it.ref, description: it.description, bill: it.bill, class: 'addition', unit: it.unit, quantity: base?.unit === it.unit ? base.quantity : 0,
      quantityCalc: base?.unit === it.unit ? `Taken from the same drawing change as ${base.boqRef}. Check before confirming.` : 'No drawing quantity uses this unit. Enter a quantity.', rateRef: it.rate, status: 'needs_confirmation', confidence: 70,
      rationale: `Added by you. ${it.description} is priced per ${it.unit} in Bill ${it.bill}. The agent could only link it to the change through ${base ? `the ${base.description.toLowerCase()} change` : 'your selection'}.`,
      preamble: it.preamble, alternatives: [], sources: `Bill ${it.bill}, sheet ${it.sheet}, cell ${it.cell}. Added manually.`, included: true,
    };
    onChange([...boq, row]);
    onEdited('boq');
    setQuery('');
    setAddNote(`Added ${it.ref}. The agent relates it to the change through shared units and zone.`);
  };

  if (status === 'not_started' || status === 'running') {
    return (
      <div className="space-y-5">
        <h1 className="text-headline font-semibold text-foreground">{running ? 'The BoQ agent is reading all bills as one tree.' : 'Find the BoQ items this change affects.'}</h1>
        <p className="max-w-2xl text-muted-foreground">The agent chooses which bills to search and tells you why. You can include or exclude bills before running.</p>
        <BillChips bills={bills} onBills={onBills} disabled={running} />
        {running ? <div className="space-y-3" aria-hidden><div className="skeleton h-20 rounded-lg" /><div className="skeleton h-64 rounded-lg" /></div> : <button type="button" onClick={onRun} className="rounded-md bg-primary px-5 py-2.5 font-semibold text-primary-foreground hover:opacity-90">Run BoQ mapping</button>}
        {running ? <p className="flex items-center gap-2 text-muted-foreground"><Loader2 size={15} className="animate-spin" />Searching bills</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-headline font-semibold text-foreground">{counts.sel} BoQ items are affected by this change.</h1>
        <p className="mt-1 max-w-2xl text-muted-foreground">{counts.add} additions, {counts.om} omission, {counts.ab} abortive work and {counts.nw} item that is not in the BoQ. Open a row to see why it was chosen.</p>
      </div>
      <BillChips bills={bills} onBills={onBills} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[[counts.sel, 'Items selected'], [counts.add, 'Additions'], [counts.om, 'Omissions'], [counts.ab, 'Abortive'], [counts.nw, 'Not in BoQ']].map(([n, l]) => (
          <div key={l as string} className="rounded-lg border border-border bg-card px-4 py-3"><p className="font-data text-2xl font-semibold text-foreground">{n}</p><p className="text-muted-foreground">{l}</p></div>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[820px] text-table">
          <thead>
            <tr className="border-b border-border bg-background text-left text-muted-foreground">
              <th className="w-10 px-3 py-3"><span className="sr-only">Include</span></th>
              <th className="px-2 py-3 font-medium">BoQ ref</th><th className="px-2 py-3 font-medium">Description</th><th className="px-2 py-3 font-medium">Bill</th><th className="px-2 py-3 font-medium">Unit</th>
              <th className="px-2 py-3 text-right font-medium">Quantity</th><th className="px-2 py-3 text-right font-medium">Contract rate (AED)</th><th className="px-2 py-3 font-medium">Status</th><th className="px-2 py-3 font-medium">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {GROUPS.map((g) => {
              const rows = boq.filter((m) => m.class === g.cls);
              if (rows.length === 0) return null;
              return (
                <React.Fragment key={g.cls}>
                  <tr className="bg-background"><td colSpan={9} className="px-4 py-2.5 font-semibold text-foreground">{g.title}</td></tr>
                  {rows.map((m) => {
                    const isOpen = open === m.id;
                    const why = explanations[m.id] ?? m.rationale;
                    return (
                      <React.Fragment key={m.id}>
                        <tr className="border-t border-border align-top">
                          <td className="px-3 py-3"><input type="checkbox" aria-label={`Include ${m.description}`} checked={m.included} onChange={(e) => update(m.id, { included: e.target.checked })} className="h-4 w-4 accent-[var(--primary)]" /></td>
                          <td className="px-2 py-3 font-data font-semibold">{m.boqRef}</td>
                          <td className="px-2 py-3">
                            <button type="button" onClick={() => setOpen(isOpen ? null : m.id)} aria-expanded={isOpen} className="flex items-start gap-1 text-left text-foreground hover:text-accent"><ChevronDown size={14} className={`mt-1 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />{m.description}</button>
                          </td>
                          <td className="px-2 py-3 font-data">{m.bill}</td><td className="px-2 py-3">{m.unit}</td>
                          <td className="px-2 py-3 text-right">
                            <input aria-label={`Quantity for ${m.boqRef}`} defaultValue={m.quantity} key={`${m.id}-${m.quantity}`} inputMode="decimal" onBlur={(e) => { const v = Number(e.target.value.replace(/,/g, '')); if (Number.isFinite(v) && v >= 0 && v !== m.quantity) update(m.id, { quantity: v, quantityCalc: `${m.quantityCalc} Edited by you to ${v.toLocaleString('en-US')} ${m.unit}.`, confidence: Math.min(m.confidence, 88) }); }} className="w-24 rounded-md border border-input bg-background px-2 py-1 text-right font-data font-semibold" />
                          </td>
                          <td className="px-2 py-3 text-right font-data text-muted-foreground">{m.rateRef === null ? '—' : m.rateRef.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                          <td className="px-2 py-3"><span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-sm font-medium ${m.class === 'new' ? 'bg-destructive/10 text-destructive' : STATUS_CLASS[m.status]}`}>{m.class === 'new' ? 'Rate needed' : STATUS_LABEL[m.status]}</span></td>
                          <td className="px-2 py-3"><ConfidenceBar value={m.confidence} /></td>
                        </tr>
                        {isOpen ? (
                          <tr className="border-t border-border bg-background/60">
                            <td colSpan={9} className="px-5 py-4">
                              <div className="grid gap-5 md:grid-cols-2">
                                <div><h3 className="font-semibold text-foreground">Why this item</h3><p className="mt-1 text-foreground">{why}</p></div>
                                <div><h3 className="font-semibold text-foreground">How the quantity was worked out</h3><p className="mt-1 rounded-md bg-muted px-3 py-2 font-data text-sm text-foreground">{m.quantityCalc}</p></div>
                                <div><h3 className="font-semibold text-foreground">Preamble clauses that apply</h3><p className="mt-1 text-foreground">{m.preamble}</p></div>
                                <div><h3 className="font-semibold text-foreground">Sources</h3><p className="mt-1 text-foreground">{m.sources}</p></div>
                              </div>
                              {m.alternatives.length > 0 ? (
                                <div className="mt-4">
                                  <h3 className="font-semibold text-foreground">Other candidates</h3>
                                  <ul className="mt-2 space-y-2">
                                    {m.alternatives.slice(0, 3).map((a) => (
                                      <li key={a.boqRef} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2">
                                        <span><span className="font-data font-semibold">{a.boqRef}</span> {a.description} ({a.confidence}%)<span className="block text-sm text-muted-foreground">Not chosen: {a.rejectedBecause}</span></span>
                                        {m.class !== 'new' && a.unit === m.unit ? <button type="button" onClick={() => swap(m, a.boqRef)} className="rounded-md border border-input px-3 py-1.5 font-medium hover:bg-muted">Swap</button> : <span className="text-sm text-muted-foreground">Unit {a.unit} does not fit</span>}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              ) : null}
                            </td>
                          </tr>
                        ) : null}
                      </React.Fragment>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {explainNote ? <p className="text-sm text-muted-foreground" role="status">{explainNote}</p> : null}

      <section className="rounded-lg border border-border bg-card p-4" aria-label="Add an item from the BoQ">
        <label htmlFor="boq-search" className="font-semibold text-foreground">Add an item from the BoQ</label>
        <input id="boq-search" value={query} onChange={(e) => { setQuery(e.target.value); setAddNote(''); }} placeholder="Search by text or reference, for example kerb or 3.3" className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30" />
        {results.length > 0 ? (
          <ul className="mt-2 divide-y divide-border rounded-md border border-border">
            {results.map((r) => (
              <li key={r.ref} className="flex items-center justify-between gap-3 px-3 py-2"><span><span className="font-data font-semibold">{r.ref}</span> {r.description} <span className="text-muted-foreground">(Bill {r.bill}, {r.unit})</span></span><button type="button" onClick={() => addItem(r.ref)} className="rounded-md border border-input px-3 py-1.5 font-medium hover:bg-muted">Add</button></li>
            ))}
          </ul>
        ) : query.trim().length >= 2 ? <p className="mt-2 text-muted-foreground">No BoQ item matches &quot;{query}&quot;. Try a shorter word or a bill number.</p> : null}
        {addNote ? <p className="mt-2 text-foreground" role="status">{addNote}</p> : null}
      </section>
    </div>
  );
}

function BillChips({ bills, onBills, disabled = false }: { bills: number[]; onBills: (b: number[]) => void; disabled?: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? BOQ_BILLS : BOQ_BILLS.filter((b) => bills.includes(b.number) || b.relevantByDefault);
  const hidden = BOQ_BILLS.length - shown.length;
  return (
    <div>
      <h2 className="mb-2 font-semibold text-foreground">Bills searched</h2>
      <div className="flex flex-wrap gap-2">
        {shown.map((b) => {
          const on = bills.includes(b.number);
          return (
            <button key={b.number} type="button" disabled={disabled} aria-pressed={on} onClick={() => onBills(on ? bills.filter((x) => x !== b.number) : [...bills, b.number].sort((x, y) => x - y))} className={`rounded-full border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-60 ${on ? 'border-accent/30 bg-accent/10 text-foreground' : 'border-border bg-card text-muted-foreground line-through'}`}>
              Bill {b.number} {b.title}
            </button>
          );
        })}
        {hidden > 0 ? <button type="button" onClick={() => setAll(true)} className="rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted">+ {hidden} more bills</button> : all ? <button type="button" onClick={() => setAll(false)} className="rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted">Show fewer</button> : null}
      </div>
    </div>
  );
}

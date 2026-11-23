'use client';

import React, { useMemo, useState } from 'react';
import { AlertTriangle, Layers, Link2 } from 'lucide-react';
import { formatSigned } from '@/lib/boq/calc';
import { checkAggregation, totalsFor, valueGroup, valueReplacement, type AggLine, type AggregationGroup, type OverlapIssue, type ReplacementMethod, type TotalsLine } from '@/lib/boq/valuation';
import type { SharedLine } from '@/lib/mapping/sharedLines';

const ACTOR = 'Current user';

interface Props {
  lines: SharedLine[];
  issues: OverlapIssue[];
  groups: AggregationGroup[];
  onGroups: (g: AggregationGroup[]) => void;
  replacements: { id: string; method: ReplacementMethod; by: string; at: string }[];
  onReplacements: (r: { id: string; method: ReplacementMethod; by: string; at: string }[]) => void;
  /** Disposition of every line, from the shared outcome and the user's decisions. */
  totalsLines: TotalsLine[];
  stale: boolean;
  staleMessages: string[];
}

export default function ValuationPanel(p: Props) {
  const [pick, setPick] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [remId, setRemId] = useState('');
  const [addId, setAddId] = useState('');

  const byId = useMemo(() => new Map(p.lines.map((l) => [l.lineId, l])), [p.lines]);
  const aggLines = useMemo(() => new Map<string, AggLine>(p.lines.map((l) => [l.lineId, { lineId: l.lineId, sourceKey: l.sourceKey, unit: l.work.unit, quantity: l.work.quantity, signedAmount: l.signedAmount }])), [p.lines]);
  const totals = useMemo(() => totalsFor(p.totalsLines), [p.totalsLines]);
  const shared = p.lines.filter((l) => l.sharesSourceWith.length > 0);
  const chosen = Object.keys(pick).filter((k) => pick[k]);
  const grouped = new Set(p.groups.flatMap((g) => g.memberLineIds));

  const combine = () => {
    setError('');
    const chk = checkAggregation(chosen.map((id) => aggLines.get(id)).filter((x): x is AggLine => !!x));
    if (!chk.ok) { setError(chk.message); return; }
    if (!reason.trim()) { setError('State why these changes are being combined.'); return; }
    if (chosen.some((id) => grouped.has(id))) { setError('One of these lines is already in a combined group. Separate that group first.'); return; }
    p.onGroups([...p.groups, { id: `grp-${Date.now().toString(36)}`, memberLineIds: chosen, reason: reason.trim(), by: ACTOR, at: new Date().toISOString() }]);
    setPick({}); setReason('');
  };

  const addReplacement = () => {
    setError('');
    const method: ReplacementMethod = { kind: 'explicit', removedLineId: remId, addedLineId: addId };
    const res = valueReplacement(method, new Map(p.lines.map((l) => [l.lineId, { signedAmount: l.signedAmount }])));
    if (!res.ok) { setError(res.message); return; }
    p.onReplacements([...p.replacements, { id: `rep-${Date.now().toString(36)}`, method, by: ACTOR, at: new Date().toISOString() }]);
    setRemId(''); setAddId('');
  };

  return (
    <section className="rounded-lg border border-border bg-card p-5 shadow-sm" aria-labelledby="val-title">
      <h2 id="val-title" className="flex items-center gap-2 text-lg font-semibold text-foreground"><Layers size={18} aria-hidden />Valuation integrity</h2>

      {p.stale ? (
        <div role="alert" className="mt-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <p className="font-semibold text-foreground">Saved results are out of date.</p>
          <ul className="list-disc pl-5 text-muted-foreground">{p.staleMessages.map((m) => <li key={m}>{m}</li>)}</ul>
          <p className="mt-1 text-muted-foreground">Earlier decisions are kept as history. Review the affected lines and confirm the assessment again.</p>
        </div>
      ) : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {totals.perCurrency.map((t) => (
          <div key={t.currency} className="rounded-md border border-border bg-background p-3 text-sm" aria-label={`Totals in ${t.currency}`}>
            <p className="text-muted-foreground">{t.complete ? `Total in ${t.currency}` : `Priced subtotal in ${t.currency} (partial)`}</p>
            <p className="text-lg font-bold tabular text-foreground">{t.pricedSubtotal === null ? '—' : formatSigned(t.pricedSubtotal, t.currency)}</p>
            <p className="text-xs text-muted-foreground">{t.pricedCount} priced · {t.unpricedCount} unpriced · {t.deferredCount} deferred · {t.excludedCount} excluded{t.heldCount ? ` · ${t.heldCount} held for overlap` : ''}</p>
          </div>
        ))}
      </div>
      {totals.mixedCurrency ? <p role="status" className="mt-2 text-sm text-foreground">More than one currency is present. Totals are kept separate; no exchange rate or date has been provided, so they are not combined.</p> : null}
      <p className="mt-1 text-xs text-muted-foreground">{totals.scheduleScopeRetained} line(s) keep their schedule scope; {totals.scheduleScopeRemoved} removed from the scenario. A cost-only exclusion or a deferral never removes schedule scope.</p>

      {p.issues.length > 0 ? (
        <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-3" aria-label="Possible double counting">
          <p className="flex items-center gap-2 text-sm font-semibold text-foreground"><AlertTriangle size={15} className="text-warning" aria-hidden />Possible double counting ({p.issues.length})</p>
          <ul className="mt-1 space-y-1 text-sm text-foreground">
            {p.issues.map((i, n) => (
              <li key={`${i.kind}-${n}`}>{i.message}<span className="block text-xs text-muted-foreground">Lines: {i.lineIds.map((id) => byId.get(id)?.name ?? id).join(' · ')}. The first is valued; the others are held out of the subtotal until you resolve this.</span></li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-4">
        <h3 className="flex items-center gap-2 text-base font-semibold text-foreground"><Link2 size={16} aria-hidden />Changes sharing a BOQ row ({shared.length})</h3>
        {shared.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">No two changes use the same BOQ row.</p> : (
          <>
            <p className="mt-1 text-sm text-muted-foreground">Each change keeps its own line, quantity and amount. Combine them only if you choose to; every underlying change stays recorded.</p>
            <ul className="mt-2 divide-y divide-border rounded-md border border-border text-sm">
              {shared.map((l) => (
                <li key={l.lineId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <label className="flex items-start gap-2">
                    <input type="checkbox" disabled={grouped.has(l.lineId)} checked={!!pick[l.lineId]} onChange={(e) => setPick((c) => ({ ...c, [l.lineId]: e.target.checked }))} className="mt-1 h-4 w-4 accent-[var(--accent)]" aria-label={`Select ${l.name} to combine`} />
                    <span><span className="text-foreground">{l.name}</span> <span className="text-muted-foreground">· {l.work.location || 'no location'} · {l.work.action}</span>
                      <span className="block font-data text-xs text-muted-foreground">{l.source} · {l.work.quantity ?? 'no quantity'} {l.work.unit}</span></span>
                  </label>
                  <span className="tabular text-foreground">{l.signedAmount === null ? 'Unpriced' : formatSigned(l.signedAmount, l.currency)}{grouped.has(l.lineId) ? <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">Combined</span> : null}</span>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <div className="min-w-[14rem] flex-1"><label htmlFor="agg-reason" className="text-xs text-muted-foreground">Reason for combining</label><input id="agg-reason" value={reason} onChange={(e) => setReason(e.target.value)} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground" /></div>
              <button type="button" disabled={chosen.length < 2} onClick={combine} className="rounded-md border border-input bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50">Combine selected ({chosen.length})</button>
            </div>
          </>
        )}
        {p.groups.length > 0 ? (
          <ul className="mt-3 space-y-2 text-sm" aria-label="Combined groups">
            {p.groups.map((g) => {
              const v = valueGroup(g, aggLines);
              return (
                <li key={g.id} className="rounded-md border border-border bg-background p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-foreground">Combined: {g.memberLineIds.map((id) => byId.get(id)?.name ?? id).join(' + ')}</span>
                    <button type="button" onClick={() => p.onGroups(p.groups.filter((x) => x.id !== g.id))} className="rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted">Separate</button>
                  </div>
                  {'error' in v ? <p role="alert" className="text-destructive">{v.error}</p> : <p className="font-data text-xs text-muted-foreground">Combined quantity {v.combinedQuantity} · {v.signedAmount === null ? 'unpriced' : `amount ${v.signedAmount}`} · reason: {g.reason}. Underlying changes: {g.memberLineIds.length}.</p>}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      <div className="mt-4">
        <h3 className="text-base font-semibold text-foreground">Replacement (removed work and added work)</h3>
        <p className="mt-1 text-sm text-muted-foreground">A replacement is not a simple addition. Pick the omission line for the work removed and the addition line for the work added; the net is stated from both.</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <div><label htmlFor="rep-rem" className="text-xs text-muted-foreground">Removed work (omission)</label>
            <select id="rep-rem" value={remId} onChange={(e) => setRemId(e.target.value)} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground"><option value="">Choose…</option>{p.lines.filter((l) => l.work.action === 'omit' || l.signedAmount?.startsWith('-')).map((l) => <option key={l.lineId} value={l.lineId}>{l.name}</option>)}</select></div>
          <div><label htmlFor="rep-add" className="text-xs text-muted-foreground">Added work (addition)</label>
            <select id="rep-add" value={addId} onChange={(e) => setAddId(e.target.value)} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground"><option value="">Choose…</option>{p.lines.filter((l) => l.work.action !== 'omit').map((l) => <option key={l.lineId} value={l.lineId}>{l.name}</option>)}</select></div>
        </div>
        <button type="button" disabled={!remId || !addId} onClick={addReplacement} className="mt-2 rounded-md border border-input bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50">Record replacement</button>
        {p.replacements.length > 0 ? (
          <ul className="mt-2 space-y-1 text-sm" aria-label="Recorded replacements">
            {p.replacements.map((r) => {
              const res = valueReplacement(r.method, new Map(p.lines.map((l) => [l.lineId, { signedAmount: l.signedAmount }])));
              return (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2">
                  <span className="text-foreground">{res.ok ? <>Net replacement <span className="font-data">{res.formula}</span></> : res.message}</span>
                  <button type="button" onClick={() => p.onReplacements(p.replacements.filter((x) => x.id !== r.id))} className="rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted">Remove</button>
                </li>
              );
            })}
          </ul>
        ) : null}
        {error ? <p role="alert" className="mt-2 text-sm text-destructive">{error}</p> : null}
      </div>
    </section>
  );
}

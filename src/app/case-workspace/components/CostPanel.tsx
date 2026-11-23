'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { D, formatMoney } from '@/lib/assessment/decimal';
import { RATE_SOURCE_LABEL, type CostLineResult } from '@/lib/assessment/types';
import { validateRate } from '@/lib/assessment/rates';
import { DEFAULT_RATE_POLICY } from '@/lib/assessment/rates';
import type { AssessmentStore } from '@/lib/assessment/useAssessment';
import DemoLineActions, { type DemoDecision } from '@/app/case-workspace/components/DemoLineActions';

const KIND_LABEL: Record<CostLineResult['kind'], string> = { addition: 'Addition', omission: 'Omission', abortive: 'Abortive / rework', adjustment: 'Adjustment', unpriced: 'Unpriced' };

function Money({ v, cur }: { v: string | null; cur: string }) {
  if (v === null) return <span className="font-medium text-warning">Unpriced</span>;
  return <span className="font-data">{formatMoney(D(v), cur)}</span>;
}

export default function CostPanel({ a }: { a: AssessmentStore }) {
  const { cost, state, patch } = a;
  const cur = cost.currency;
  const rateOptions = state.rates;
  const setRate = (ref: string, id: string) => patch({ rateByRef: { ...state.rateByRef, [ref]: id === '' ? undefined : id } });
  const decisions = state.lineDecisions ?? {};
  const decide = (lineId: string, d: DemoDecision | undefined) => {
    const next = { ...decisions };
    if (d) next[lineId] = d; else delete next[lineId];
    patch({ lineDecisions: next });
  };
  const costExcluded = (id: string) => decisions[id]?.kind === 'excluded_cost' || decisions[id]?.kind === 'excluded_scenario';
  const excludedLines = cost.lines.filter((l) => costExcluded(l.componentId));

  return (
    <div className="space-y-6">
      <section aria-label="Assessed cost" className="rounded-lg border border-border bg-card p-5">
        <h3 className="text-lg font-semibold text-foreground">{cost.isComplete ? 'Assessed net cost' : 'Priced subtotal only. Some scope is not yet priced.'}</h3>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div><p className="text-muted-foreground">Additions</p><p className="text-xl font-semibold"><Money v={cost.additions} cur={cur} /></p></div>
          <div><p className="text-muted-foreground">Omissions</p><p className="text-xl font-semibold">− <Money v={cost.omissions} cur={cur} /></p></div>
          <div><p className="text-muted-foreground">Abortive / rework</p><p className="text-xl font-semibold"><Money v={cost.abortive} cur={cur} /></p></div>
          <div><p className="text-muted-foreground">Justified adjustments</p><p className="text-xl font-semibold"><Money v={cost.adjustmentsTotal} cur={cur} /></p></div>
        </div>
        <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-t border-border pt-4">
          <div>
            <p className="text-muted-foreground">{cost.isComplete ? 'Net assessed cost' : 'Priced subtotal'} (additions − omissions + abortive + justified adjustments)</p>
            <p className="text-3xl font-semibold text-foreground"><Money v={cost.netAssessed} cur={cur} /></p>
          </div>
          <div className="text-right">
            <p className="text-muted-foreground">Unpriced scope</p>
            <p className="text-xl font-semibold text-foreground">{cost.unpricedLines.length} item{cost.unpricedLines.length === 1 ? '' : 's'} unresolved</p>
          </div>
        </div>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          {(['proposed', 'assessed', 'approved'] as const).map((k) => (
            <div key={k} className="rounded-md bg-muted px-3 py-2"><dt className="capitalize text-muted-foreground">{k} (by rate status)</dt><dd className="font-data">{formatMoney(D(cost.approvalSummary[k]), cur)}</dd></div>
          ))}
        </dl>
        {cost.tax ? <p className="mt-3 text-muted-foreground">{cost.tax.label} at {cost.tax.ratePct}%: <span className="font-data">{formatMoney(D(cost.tax.amount), cur)}</span>. Shown separately from the base assessment.</p> : <p className="mt-3 text-muted-foreground">No tax is applied. Enter a rate below to show it separately.</p>}
        {[...cost.warnings, ...cost.blockers].map((w) => (
          <p key={w} className="mt-2 flex items-start gap-2 text-foreground"><AlertTriangle size={16} className="mt-1 shrink-0 text-warning" />{w}</p>
        ))}
      </section>

      <section aria-label="Cost lines" className="rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b border-border bg-muted text-foreground">
              <tr><th className="px-3 py-2">BoQ ref</th><th className="px-3 py-2">Work</th><th className="px-3 py-2">Type</th><th className="px-3 py-2 text-right">Quantity</th><th className="px-3 py-2">Rate</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2">Rate includes</th></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {cost.lines.map((l) => (
                <tr key={l.id} className={l.kind === 'unpriced' || l.excludedFromTotals ? 'bg-warning/5' : ''}>
                  <td className="px-3 py-2 font-data">{l.boqRef}</td>
                  <td className="px-3 py-2"><p className="font-medium text-foreground">{l.description}</p>{l.issues.map((i) => <p key={i} className="text-muted-foreground">{i}</p>)}</td>
                  <td className="px-3 py-2">{KIND_LABEL[l.kind]}{l.excludedFromTotals && l.amount ? <span className="block text-warning">Held out: overlap</span> : null}</td>
                  <td className="px-3 py-2 text-right font-data">{l.quantity} {l.unit}{l.convertedQuantity && l.convertedQuantity !== l.quantity ? <span className="block text-muted-foreground">= {l.convertedQuantity} {l.rateUnit}</span> : null}</td>
                  <td className="px-3 py-2">
                    <label className="sr-only" htmlFor={`rate-${l.componentId}`}>Rate for {l.boqRef}</label>
                    <select id={`rate-${l.componentId}`} value={state.rateByRef[l.boqRef] ?? ''} onChange={(e) => setRate(l.boqRef, e.target.value)} className="w-full rounded-md border border-input bg-card px-2 py-1.5">
                      <option value="">No rate selected</option>
                      {rateOptions.map((r) => <option key={r.id} value={r.id}>{r.id} · {RATE_SOURCE_LABEL[r.source]} · {r.value} {r.currency}/{r.unit}</option>)}
                    </select>
                    {l.rateSource ? <p className="mt-1 text-muted-foreground">{RATE_SOURCE_LABEL[l.rateSource]} · {l.approval}</p> : null}
                  </td>
                  <td className="px-3 py-2 text-right"><Money v={l.amount} cur={cur} /></td>
                  <td className="px-3 py-2">{l.rateComponents ? <><p>{l.rateComponents.included.join(', ') || 'Not stated'}</p>{l.rateComponents.excluded.length ? <p className="text-warning">Excludes: {l.rateComponents.excluded.join(', ')}</p> : null}</> : <span className="text-muted-foreground">Unknown until a rate is chosen</span>}</td>
                </tr>
              ))}
              {cost.lines.length === 0 ? <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">No BoQ items were confirmed in Mapping v1. Confirm the BoQ mapping first.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      {cost.replacements.length ? (
        <section aria-label="Replacements" className="rounded-lg border border-border bg-card p-5">
          <h3 className="font-semibold text-foreground">Replacements: omitted and replacement scope together</h3>
          {cost.replacements.map((r) => <p key={r.group} className="mt-2 font-data">{r.group}: omitted {r.omitted}, added {r.added}, net {r.net} {cur}{r.complete ? '' : ' (incomplete)'}</p>)}
        </section>
      ) : null}

      <section aria-label="Rate policy" className="rounded-lg border border-border bg-card p-5">
        <h3 className="font-semibold text-foreground">Project rate policy</h3>
        <p className="mt-1 text-muted-foreground">{DEFAULT_RATE_POLICY.name}. Approved by {DEFAULT_RATE_POLICY.approvedBy}. This sets the order sources are offered in; it is not a statement of contractual entitlement.</p>
        <ol className="mt-3 flex flex-wrap gap-2">{DEFAULT_RATE_POLICY.order.map((s, i) => <li key={s} className="rounded-full bg-muted px-3 py-1">{i + 1}. {RATE_SOURCE_LABEL[s]}</li>)}</ol>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="border-b border-border"><tr><th className="py-2 pr-3">Rate</th><th className="pr-3">Source</th><th className="pr-3">Date</th><th className="pr-3">Unit</th><th className="pr-3">Includes / excludes</th><th className="pr-3">Approval</th><th>Check</th></tr></thead>
            <tbody className="divide-y divide-border">
              {state.rates.map((r) => {
                const v = validateRate(r, DEFAULT_RATE_POLICY);
                const setC = (k: 'specification' | 'location' | 'timing', val: boolean) => patch({ rates: state.rates.map((x) => (x.id === r.id ? { ...x, comparability: { ...(x.comparability ?? { specification: null, location: null, timing: null, note: '' }), [k]: val } } : x)) });
                return (
                  <tr key={r.id}>
                    <td className="py-2 pr-3 font-data">{r.id}<span className="block text-muted-foreground">{r.value} {r.currency}</span></td>
                    <td className="pr-3">{RATE_SOURCE_LABEL[r.source]}<span className="block text-muted-foreground">{r.sourceRef}</span></td>
                    <td className="pr-3 font-data">{r.date}</td><td className="pr-3 font-data">{r.unit}</td>
                    <td className="pr-3">{r.inclusions.join(', ')}<span className="block text-warning">{r.exclusions.length ? `Excludes ${r.exclusions.join(', ')}` : ''}</span></td>
                    <td className="pr-3 capitalize">{r.approval}</td>
                    <td>
                      {r.source === 'historical_benchmark' ? (
                        <fieldset className="space-y-1"><legend className="sr-only">Comparability review for {r.id}</legend>
                          {(['specification', 'location', 'timing'] as const).map((k) => (
                            <label key={k} className="flex items-center gap-2 capitalize"><input type="checkbox" checked={r.comparability?.[k] === true} onChange={(e) => setC(k, e.target.checked)} />{k} comparable</label>
                          ))}
                        </fieldset>
                      ) : null}
                      <p className={v.ok ? 'text-success' : 'text-warning'}>{v.ok ? 'Usable' : v.problems[0]}</p>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-muted-foreground">These rates are clearly labelled synthetic. Replace them from the priced BoQ before relying on any total. AI may suggest a rate source or build-up structure but never supplies a price.</p>
      </section>

      <section aria-label="Adjustments and tax" className="rounded-lg border border-border bg-card p-5">
        <h3 className="font-semibold text-foreground">Adjustments and tax (off unless justified)</h3>
        {state.adjustments.map((adj) => (
          <div key={adj.id} className="mt-3 grid gap-3 md:grid-cols-[auto_1fr_1fr]">
            <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={adj.enabled} onChange={(e) => patch({ adjustments: state.adjustments.map((x) => (x.id === adj.id ? { ...x, enabled: e.target.checked } : x)) })} />{adj.label} ({adj.value}% of base)</label>
            <input aria-label="Evidence" placeholder="Evidence (contract clause or document)" value={adj.evidence} onChange={(e) => patch({ adjustments: state.adjustments.map((x) => (x.id === adj.id ? { ...x, evidence: e.target.value } : x)) })} className="rounded-md border border-input bg-card px-3 py-2" />
            <input aria-label="Justification" placeholder="Why it applies to this change" value={adj.justification} onChange={(e) => patch({ adjustments: state.adjustments.map((x) => (x.id === adj.id ? { ...x, justification: e.target.value } : x)) })} className="rounded-md border border-input bg-card px-3 py-2" />
          </div>
        ))}
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2">Tax rate % (separate)<input value={state.taxRatePct} onChange={(e) => patch({ taxRatePct: e.target.value })} inputMode="decimal" placeholder="blank = not shown" className="w-32 rounded-md border border-input bg-card px-3 py-2" /></label>
          <label className="flex items-center gap-2">Decimal places<select value={state.roundingPlaces} onChange={(e) => patch({ roundingPlaces: Number(e.target.value) })} className="rounded-md border border-input bg-card px-3 py-2">{[0, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        </div>
      </section>
    </div>
  );
}

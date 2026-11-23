import { D, Dec, sumDec } from './decimal';
import type { BuildUpRow, Comparability, RatePolicy, RateRecord, RateSourceType } from './types';

export const DEFAULT_RATE_POLICY: RatePolicy = {
  id: 'policy-fir-roads-v1',
  name: 'Fahid Island Roads rate policy v1 (configurable workflow, not a contractual entitlement rule)',
  approvedBy: 'Project Commercial Manager (policy configuration)',
  order: ['contract_rate', 'derived_pro_rata', 'historical_benchmark', 'first_principles', 'daywork', 'quotation'],
  enabled: { contract_rate: true, derived_pro_rata: true, historical_benchmark: true, first_principles: true, daywork: true, quotation: true },
  currency: 'AED',
  rounding: { places: 2, mode: 'half_up' },
};

export interface RateValidation {
  ok: boolean;
  problems: string[];
  warnings: string[];
}

/** A rate must record source, date, currency, unit, scope, derivation and approval status. */
export function validateRate(r: RateRecord, policy: RatePolicy): RateValidation {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!policy.enabled[r.source]) problems.push(`Rate source "${r.source}" is not enabled in the project rate policy.`);
  if (!r.sourceRef.trim()) problems.push('Rate has no source reference.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) problems.push('Rate has no valid date (YYYY-MM-DD).');
  if (!r.currency.trim()) problems.push('Rate has no currency.');
  if (!r.unit.trim()) problems.push('Rate has no unit.');
  if (!r.derivation.trim()) problems.push('Rate has no recorded derivation.');
  try {
    if (D(r.value).isNeg()) problems.push('Rate value is negative.');
  } catch {
    problems.push('Rate value is not a valid number.');
  }
  if (r.currency !== policy.currency && !r.fxAssumption) {
    problems.push(`Rate is in ${r.currency} but the assessment currency is ${policy.currency}. Record a currency-conversion assumption.`);
  }
  if (r.source === 'historical_benchmark') {
    const c = r.comparability;
    if (!c || c.specification === null || c.location === null || c.timing === null) {
      problems.push('Historical rate needs an explicit comparability review for specification, location and timing.');
    } else if (!c.specification || !c.location || !c.timing) {
      warnings.push('Historical rate failed at least one comparability check. Do not use without an adjustment that is recorded.');
    }
  }
  if (r.source === 'first_principles' && (!r.buildUp || r.buildUp.length === 0)) {
    problems.push('First-principles rate has no build-up rows.');
  }
  if (r.approval !== 'approved') warnings.push(`Rate approval status is "${r.approval}".`);
  return { ok: problems.length === 0, problems, warnings };
}

export function comparabilityComplete(c: Comparability | undefined): boolean {
  return !!c && c.specification !== null && c.location !== null && c.timing !== null;
}

export interface BuildUpResult {
  rows: { id: string; component: string; description: string; base: Dec; waste: Dec; total: Dec }[];
  subtotal: Dec;
  overheads: Dec;
  profit: Dec;
  unitRate: Dec;
  outputQuantity: Dec;
}

/**
 * First-principles build-up: each row is quantity × unit cost, plus waste.
 * Mark-ups are applied only when stated on the record. Result is per `outputQuantity` of the rate unit.
 */
export function computeBuildUp(rows: BuildUpRow[], markups: { overheadsPct: string; profitPct: string } | undefined, outputQuantity: string): BuildUpResult {
  const out = D(outputQuantity);
  if (out.isZero() || out.isNeg()) throw new Error('Build-up output quantity must be greater than zero.');
  const rowResults = rows.map((r) => {
    const base = D(r.quantity).mul(r.unitCost);
    const waste = base.mul(D(r.wastePct || '0').div(100));
    return { id: r.id, component: r.component, description: r.description, base, waste, total: base.add(waste) };
  });
  const subtotal = sumDec(rowResults.map((r) => r.total));
  const overheads = markups ? subtotal.mul(D(markups.overheadsPct || '0').div(100)) : Dec.zero();
  const profit = markups ? subtotal.add(overheads).mul(D(markups.profitPct || '0').div(100)) : Dec.zero();
  const total = subtotal.add(overheads).add(profit);
  return { rows: rowResults, subtotal, overheads, profit, unitRate: total.div(out), outputQuantity: out };
}

/** Pro-rata derivation: base rate × (new quantity ÷ reference quantity) is NOT assumed; only an explicit factor is applied. */
export function deriveProRata(baseRate: string, factor: string): Dec {
  return D(baseRate).mul(factor);
}

export function convertRate(r: RateRecord, policyCurrency: string): { value: Dec; note: string } {
  if (r.currency === policyCurrency) return { value: D(r.value), note: 'No conversion needed.' };
  if (!r.fxAssumption) throw new Error(`Missing currency conversion assumption for ${r.currency} to ${policyCurrency}.`);
  const fx = r.fxAssumption;
  if (fx.from !== r.currency || fx.to !== policyCurrency) throw new Error('Conversion assumption does not match the rate currency pair.');
  return { value: D(r.value).mul(fx.rate), note: `Converted ${r.currency} to ${policyCurrency} at ${fx.rate} (${fx.date}). Source precision retained.` };
}

export function policyRank(policy: RatePolicy, s: RateSourceType): number {
  return policy.order.indexOf(s);
}

/** Candidate rates for a unit, ordered by project policy. This only orders choices; a human selects. */
export function candidateRates(rates: RateRecord[], unit: string, policy: RatePolicy): RateRecord[] {
  return rates
    .filter((r) => r.unit === unit && policy.enabled[r.source])
    .sort((a, b) => policyRank(policy, a.source) - policyRank(policy, b.source));
}

/** Seeded, clearly labelled synthetic rates. Not live project values. */
export function syntheticRates(): RateRecord[] {
  return [
    { id: 'RT-01', source: 'contract_rate', sourceRef: 'Contract BoQ Bill 2 item 2.10', date: '2025-11-01', currency: 'AED', unit: 'm2', value: '86.50', inclusions: ['labour', 'materials', 'plant', 'waste'], exclusions: ['overheads', 'profit'], derivation: 'Rate as printed in the priced BoQ.', adjustments: 'None', approval: 'approved' },
    { id: 'RT-02', source: 'contract_rate', sourceRef: 'Contract BoQ Bill 2 item 2.05', date: '2025-11-01', currency: 'AED', unit: 'm2', value: '41.20', inclusions: ['labour', 'materials', 'plant'], exclusions: ['waste'], derivation: 'Rate as printed in the priced BoQ.', adjustments: 'None', approval: 'approved' },
    { id: 'RT-03', source: 'contract_rate', sourceRef: 'Contract BoQ Bill 1 item 1.04', date: '2025-11-01', currency: 'AED', unit: 'm', value: '1240.00', inclusions: ['labour', 'materials', 'plant', 'waste'], exclusions: [], derivation: 'Rate as printed in the priced BoQ.', adjustments: 'None', approval: 'approved' },
    { id: 'RT-04', source: 'contract_rate', sourceRef: 'Contract BoQ Bill 3 item 3.02', date: '2025-11-01', currency: 'AED', unit: 'm', value: '58.75', inclusions: ['labour', 'materials', 'plant'], exclusions: ['waste'], derivation: 'Rate as printed in the priced BoQ.', adjustments: 'None', approval: 'approved' },
    { id: 'RT-05', source: 'historical_benchmark', sourceRef: 'Zone A Roads BoQ 2024, item 5.03', date: '2024-03-01', currency: 'AED', unit: 'nr', value: '2150.00', inclusions: ['labour', 'materials', 'plant'], exclusions: ['overheads'], derivation: 'Taken from a completed package. Not yet reviewed for this change.', adjustments: 'None', approval: 'proposed', comparability: { specification: null, location: null, timing: null, note: '' } },
  ];
}

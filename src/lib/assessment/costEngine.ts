import { D, Dec, sumDec } from './decimal';
import { convertRate, validateRate } from './rates';
import type {
  Adjustment,
  ApprovalState,
  CalcSettings,
  CostLineResult,
  CostResult,
  RatePolicy,
  RateRecord,
  ScopeComponent,
} from './types';

export interface CostInput {
  components: ScopeComponent[];
  rates: RateRecord[];
  adjustments: Adjustment[];
  policy: RatePolicy;
  settings: CalcSettings;
}

/** Linear unit pairs with exact conversion factors. Dimensional changes (m2 to m3) are never converted implicitly. */
const DIMENSION: Record<string, string> = { m: 'length', km: 'length', mm: 'length', m2: 'area', 'm²': 'area', m3: 'volume', 'm³': 'volume', nr: 'count', no: 'count', t: 'mass', kg: 'mass', item: 'lump', sum: 'lump' };
const TO_BASE: Record<string, string> = { m: '1', km: '1000', mm: '0.001', m2: '1', 'm²': '1', m3: '1', 'm³': '1', nr: '1', no: '1', t: '1000', kg: '1', item: '1', sum: '1' };

export function normaliseUnit(u: string): string {
  return u.trim().toLowerCase().replace('²', '2').replace('³', '3');
}

export interface UnitCheck {
  ok: boolean;
  factor: Dec | null;
  reason: string;
}

/**
 * DEMO ENGINE ONLY. This module prices the synthetic Fahid Island demo. It is not used by real cases:
 * real cases use src/lib/boq/units.ts, which separates same-dimension conversion, dimensional derivation
 * (length x width = area, with inputs and a stated basis) and unsupported conversions.
 *
 * To avoid keeping a weaker second rule set, a bare "explicit factor" is no longer allowed to bridge
 * different known dimensions (for example m2 -> m3 or m -> m2). Those need the derivation inputs that the
 * real engine requires, and the demo engine does not collect them, so the line stays unpriced.
 */
export function checkUnits(quantityUnit: string, rateUnit: string, explicitFactor?: string, note?: string): UnitCheck {
  const q = normaliseUnit(quantityUnit);
  const r = normaliseUnit(rateUnit);
  if (q === r) return { ok: true, factor: D(1), reason: 'Units match.' };
  const dq = DIMENSION[q];
  const dr = DIMENSION[r];
  if (dq && dr && dq !== dr) {
    return { ok: false, factor: null, reason: `${quantityUnit} (${dq}) cannot be priced with a rate per ${rateUnit} (${dr}). A generic factor cannot bridge dimensions: supply the width, thickness or depth through the real-case derivation.` };
  }
  if (explicitFactor && explicitFactor.trim() !== '') {
    // Only reachable when at least one unit is unrecognised. A recorded basis is mandatory.
    if (!note || !note.trim()) return { ok: false, factor: null, reason: `Conversion from ${quantityUnit} to ${rateUnit} needs a recorded basis.` };
    return { ok: true, factor: D(explicitFactor), reason: `Demo-only explicit conversion ${quantityUnit} to ${rateUnit}: ${note}` };
  }
  if (!dq || !dr) return { ok: false, factor: null, reason: `Unknown unit pair ${quantityUnit} to ${rateUnit}. Provide an explicit conversion.` };
  const f = D(TO_BASE[q]).div(TO_BASE[r]);
  return { ok: true, factor: f, reason: `Converted ${quantityUnit} to ${rateUnit} (factor ${f.toString()}).` };
}

function parseQty(s: string): Dec | null {
  try {
    return D(s);
  } catch {
    return null;
  }
}

/** Detect overlapping charges: same workKey as two different kinds, or a rate that bundles another charged component. */
export function detectOverlaps(components: ScopeComponent[]): Map<string, string[]> {
  const issues = new Map<string, string[]>();
  const add = (id: string, msg: string) => issues.set(id, [...(issues.get(id) ?? []), msg]);
  const byKey = new Map<string, ScopeComponent[]>();
  for (const c of components) byKey.set(c.workKey, [...(byKey.get(c.workKey) ?? []), c]);
  for (const [key, group] of byKey) {
    const chargeKinds = new Set(group.filter((g) => g.kind !== 'omission').map((g) => g.kind));
    if (chargeKinds.has('addition') && chargeKinds.has('abortive')) {
      for (const g of group.filter((x) => x.kind === 'addition' || x.kind === 'abortive')) add(g.id, `Work "${key}" is charged as both an addition and abortive/rework. Keep one.`);
    }
    const same = group.filter((g) => g.kind === 'addition');
    if (same.length > 1) for (const g of same) add(g.id, `Work "${key}" is charged more than once as an addition.`);
    const abortiveDup = group.filter((g) => g.kind === 'abortive');
    if (abortiveDup.length > 1) for (const g of abortiveDup) add(g.id, `Work "${key}" has duplicate abortive/rework charges.`);
  }
  for (const c of components) {
    for (const bundled of c.bundledWorkKeys ?? []) {
      const dupe = components.find((o) => o.id !== c.id && o.workKey === bundled && o.kind !== 'omission');
      if (dupe) {
        add(c.id, `Rate for "${c.boqRef}" already bundles "${bundled}", which is also charged on ${dupe.boqRef}.`);
        add(dupe.id, `"${bundled}" is already bundled in the rate of ${c.boqRef}.`);
      }
    }
  }
  return issues;
}

export function calculateCost(input: CostInput): CostResult {
  const { components, rates, adjustments, policy, settings } = input;
  const places = settings.rounding.places;
  const mode = settings.rounding.mode;
  const overlaps = detectOverlaps(components);
  const lines: CostLineResult[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];

  for (const c of components) {
    const issues: string[] = [...(overlaps.get(c.id) ?? [])];
    const rate = c.rateId ? rates.find((r) => r.id === c.rateId) ?? null : null;
    const base: Omit<CostLineResult, 'amount' | 'kind' | 'excludedFromTotals' | 'convertedQuantity' | 'rate' | 'rateSource' | 'rateComponents' | 'approval' | 'rateUnit'> = {
      id: `L-${c.id}`, componentId: c.id, boqRef: c.boqRef, description: c.description, quantity: c.quantity, unit: c.unit, currency: settings.currency, rateId: c.rateId, issues, replacementGroup: c.replacementGroup,
    };
    const q = parseQty(c.quantity);
    const unpriced = (why: string): CostLineResult => ({
      ...base, kind: 'unpriced', amount: null, excludedFromTotals: true, convertedQuantity: null, rate: null, rateSource: null, rateComponents: null, approval: 'proposed', rateUnit: c.rateUnit ?? c.unit,
      issues: [...issues, why],
    });
    if (q === null || q.isNeg()) { lines.push(unpriced('Quantity is missing or invalid. Line is unresolved, not zero.')); continue; }
    if (!rate) { lines.push(unpriced('No rate selected. Line stays unpriced until a rate source is recorded.')); continue; }
    const v = validateRate(rate, policy);
    if (!v.ok) { lines.push(unpriced(`Rate ${rate.id} is not usable: ${v.problems.join(' ')}`)); continue; }
    const uc = checkUnits(c.unit, rate.unit, c.conversionFactor, c.conversionNote);
    if (!uc.ok || !uc.factor) { lines.push(unpriced(uc.reason)); continue; }
    let rateValue: Dec;
    try {
      rateValue = convertRate(rate, settings.currency).value;
    } catch (e) {
      lines.push(unpriced((e as Error).message));
      continue;
    }
    const converted = q.mul(uc.factor);
    const raw = converted.mul(rateValue);
    const amount = raw.round(places, mode);
    const lineIssues = [...issues, ...(v.warnings ?? [])];
    if (uc.reason !== 'Units match.') lineIssues.push(uc.reason);
    if (rate.exclusions.length > 0) lineIssues.push(`Rate excludes: ${rate.exclusions.join(', ')}. Nothing has been added automatically.`);
    const overlapped = issues.length > 0;
    lines.push({
      ...base, kind: c.kind, amount: amount.toString(), convertedQuantity: converted.toString(), rate: rateValue.toString(), rateSource: rate.source, rateComponents: { included: rate.inclusions, excluded: rate.exclusions },
      approval: rate.approval, rateUnit: rate.unit, issues: lineIssues, excludedFromTotals: overlapped,
    });
  }

  const priced = lines.filter((l) => l.amount !== null);
  const counted = priced.filter((l) => !l.excludedFromTotals);
  const held = priced.filter((l) => l.excludedFromTotals);
  if (held.length) blockers.push(`${held.length} line(s) are held out of the total because of possible overlapping charges. Resolve them to include.`);

  const sumKind = (k: CostLineResult['kind']) => sumDec(counted.filter((l) => l.kind === k).map((l) => D(l.amount as string)));
  const additions = sumKind('addition');
  const omissions = sumKind('omission');
  const abortive = sumKind('abortive');
  const base = additions.sub(omissions).add(abortive);

  const adjLines = adjustments
    .filter((a) => a.enabled)
    .map((a) => {
      const amt = (a.mode === 'percent_of_base' ? base.mul(D(a.value).div(100)) : D(a.value)).round(places, mode);
      return { a, amt };
    })
    .filter(({ a }) => {
      if (!a.evidence.trim() || !a.justification.trim()) {
        warnings.push(`Adjustment "${a.label}" is enabled but has no evidence or justification, so it was not applied.`);
        return false;
      }
      return true;
    });
  const adjTotal = sumDec(adjLines.map((x) => x.amt));
  const net = base.add(adjTotal);

  const unpricedLines = lines.filter((l) => l.kind === 'unpriced');
  const groups = Array.from(new Set(lines.filter((l) => l.replacementGroup).map((l) => l.replacementGroup as string)));
  const replacements = groups.map((g) => {
    const gl = lines.filter((l) => l.replacementGroup === g);
    const om = sumDec(gl.filter((l) => l.kind === 'omission' && l.amount && !l.excludedFromTotals).map((l) => D(l.amount as string)));
    const ad = sumDec(gl.filter((l) => l.kind === 'addition' && l.amount && !l.excludedFromTotals).map((l) => D(l.amount as string)));
    const complete = gl.every((l) => l.amount !== null && !l.excludedFromTotals);
    return { group: g, omitted: om.toString(), added: ad.toString(), net: ad.sub(om).toString(), complete };
  });

  let tax: CostResult['tax'] = null;
  if (settings.taxRatePct !== null && settings.taxRatePct !== '') {
    const t = net.mul(D(settings.taxRatePct).div(100)).round(places, mode);
    tax = { label: settings.taxLabel, ratePct: settings.taxRatePct, amount: t.toString(), grossIncludingTax: net.add(t).toString() };
  }

  const approvalSummary: Record<ApprovalState, string> = { proposed: '0', assessed: '0', approved: '0' };
  (['proposed', 'assessed', 'approved'] as ApprovalState[]).forEach((s) => {
    const part = counted.filter((l) => l.approval === s);
    const signed = sumDec(part.map((l) => (l.kind === 'omission' ? D(l.amount as string).neg() : D(l.amount as string))));
    approvalSummary[s] = signed.toString();
  });

  if (unpricedLines.length) warnings.push(`${unpricedLines.length} line(s) are unpriced. The total below is a priced subtotal only.`);

  return {
    lines, additions: additions.toString(), omissions: omissions.toString(), abortive: abortive.toString(), adjustmentsTotal: adjTotal.toString(),
    adjustmentLines: adjLines.map(({ a, amt }) => ({ id: a.id, label: a.label, amount: amt.toString(), type: a.type, evidence: a.evidence })),
    netAssessed: net.toString(), pricedLineCount: counted.length, unpricedLines, isComplete: unpricedLines.length === 0 && held.length === 0,
    tax, replacements, warnings, blockers, currency: settings.currency, approvalSummary,
  };
}

/** Map confirmed BoQ mappings (Mapping v1) to scope components. Quantities carry their own source units. */
export function componentsFromMapping(
  boq: { id: string; changeIds: string[]; boqRef: string; description: string; class: 'omission' | 'addition' | 'abortive' | 'new'; unit: string; quantity: number; included: boolean; preamble?: string }[],
  rateByRef: Record<string, string | undefined>,
): ScopeComponent[] {
  return boq.filter((b) => b.included).map((b) => ({
    id: b.id,
    workKey: `${b.boqRef}`,
    boqRef: b.boqRef,
    description: b.description,
    kind: b.class === 'new' ? 'addition' : b.class,
    quantity: String(b.quantity),
    unit: b.unit,
    rateId: rateByRef[b.boqRef] ?? null,
    changeIds: b.changeIds,
    basis: 'derived',
    preamble: b.preamble,
  }));
}

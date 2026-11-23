import { D } from '../assessment/decimal';
import { dimensionOf, planConversion } from './units';
import { validateDecimalText } from './calc';

/**
 * Deterministic valuation helpers for the real-case workflow. Nothing here calls a model and nothing uses floating
 * point for money. The model proposes; these functions decide identity, overlap, aggregation and arithmetic.
 */

// ---------- Line identity ----------

/**
 * A costed line is identified by WHAT changed (the change component) and WHERE its price comes from (the source).
 * Two changes that use the same BOQ row therefore have two different lines. The source key alone is never the key.
 *   <sourceKey>#<componentKey>
 */
export function sourceKeyOf(parts: { importId?: string; sheet?: string; rowNumber?: number; newItemId?: string }): string {
  if (parts.newItemId) return `new|${parts.newItemId}`;
  if (parts.importId && parts.sheet !== undefined && parts.rowNumber !== undefined) return `${parts.importId}|${parts.sheet}|${parts.rowNumber}`;
  return 'unmatched';
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Stable component key built from the change's own content, so it survives a re-run that renumbers model ids. */
export function componentKeyOf(c: { name: string; action: string; location: string }): string {
  return [slug(c.name), slug(c.action), slug(c.location)].filter(Boolean).join('~') || 'component';
}

export function lineIdOf(sourceKey: string, componentKey: string): string {
  return `${sourceKey}#${componentKey}`;
}

/** Make keys unique when two different changes would otherwise produce the same key. Never drops a line. */
export function uniqueKeys(keys: string[]): string[] {
  const seen = new Map<string, number>();
  return keys.map((k) => {
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n === 1 ? k : `${k}~${n}`;
  });
}

// ---------- Aggregation ----------

export interface AggregationGroup {
  id: string;
  /** The line ids that were explicitly combined. Every member stays recorded. */
  memberLineIds: string[];
  reason: string;
  by: string;
  at: string;
}

export interface AggLine {
  lineId: string;
  sourceKey: string;
  unit: string;
  /** Signed-once quantity in the line's own unit, or null when unknown. */
  quantity: string | null;
  signedAmount: string | null;
}

export type AggregationCheck = { ok: true; sourceKey: string; unit: string; combinedQuantity: string } | { ok: false; message: string };

/**
 * Lines may only be aggregated when they price from the same source row and the same unit. The combined quantity is
 * the exact decimal sum; the underlying lines are retained by the caller and are never deleted.
 */
export function checkAggregation(lines: AggLine[]): AggregationCheck {
  if (lines.length < 2) return { ok: false, message: 'Choose at least two lines to combine.' };
  const src = new Set(lines.map((l) => l.sourceKey));
  if (src.size !== 1 || src.has('unmatched')) return { ok: false, message: 'Only lines priced from the same BOQ row can be combined.' };
  const units = new Set(lines.map((l) => l.unit.trim().toLowerCase()));
  if (units.size !== 1) return { ok: false, message: 'The lines use different units, so their quantities cannot be added.' };
  if (lines.some((l) => l.quantity === null || !validateDecimalText(l.quantity))) return { ok: false, message: 'A line has no usable quantity, so the combined quantity is unknown.' };
  const total = lines.reduce((a, l) => a.add(D(l.quantity as string)), D('0'));
  return { ok: true, sourceKey: lines[0].sourceKey, unit: lines[0].unit, combinedQuantity: total.toString() };
}

export interface ValuedGroup { groupId: string; memberLineIds: string[]; signedAmount: string | null; combinedQuantity: string }

/**
 * Value a group once: the amount of the first priced member's rate applied to the combined quantity is equivalent to
 * summing members that share a row and unit, so the group amount is the plain decimal sum of its members.
 */
export function valueGroup(group: AggregationGroup, byId: Map<string, AggLine>): ValuedGroup | { groupId: string; error: string } {
  const members = group.memberLineIds.map((id) => byId.get(id)).filter((x): x is AggLine => !!x);
  if (members.length !== group.memberLineIds.length) return { groupId: group.id, error: 'A combined line is no longer present. The group needs review.' };
  const chk = checkAggregation(members);
  if (!chk.ok) return { groupId: group.id, error: chk.message };
  const priced = members.every((m) => m.signedAmount !== null);
  const amount = priced ? members.reduce((a, m) => a.add(D(m.signedAmount as string)), D('0')).toString() : null;
  return { groupId: group.id, memberLineIds: group.memberLineIds, signedAmount: amount, combinedQuantity: chk.combinedQuantity };
}

// ---------- Duplicate valuation and composite overlap ----------

export interface OverlapLine {
  lineId: string;
  /** Component the line was priced for. */
  componentKey: string;
  sourceKey: string;
  /** What the line prices, e.g. the BOQ description. */
  description: string;
  /** Normalised work keys this line's rate covers (itself plus anything its rate bundles). */
  covers: string[];
  /** Linked change (scope id) when the line is a manually added item. Used to stop double valuation. */
  linkedComponentKey?: string;
  origin: 'boq' | 'new_item' | 'manual_rate';
  included: boolean;
}

export interface OverlapIssue { kind: 'same_source_same_work' | 'composite_rate' | 'manual_linked_duplicate'; lineIds: string[]; message: string }

const BUNDLE_WORDS = /\b(including|inclusive of|incl\.?|complete with|together with|with all|comprising)\b/i;

/** Work keys named in a composite rate's own wording after "including ...". Deterministic text check, not a model call. */
export function bundledPhrases(description: string): string[] {
  const m = description.match(BUNDLE_WORDS);
  if (!m || m.index === undefined) return [];
  const tail = description.slice(m.index + m[0].length);
  return tail.split(/,|;|\band\b|&/i).map((s) => slug(s)).filter((s) => s.length >= 3);
}

/**
 * Detect duplicate valuation.
 *  - Two included lines for the same change AND the same source row: one change priced twice.
 *  - A composite rate that names another included line's work in its own wording (e.g. "asphalt including tack coat").
 *  - A manually added item linked to a change that is already priced from a BOQ row or manual rate.
 * Several changes sharing one row is NOT an issue: that is normal and each keeps its own line.
 */
export function detectValuationOverlaps(lines: OverlapLine[]): OverlapIssue[] {
  const out: OverlapIssue[] = [];
  const active = lines.filter((l) => l.included);

  const byPair = new Map<string, OverlapLine[]>();
  for (const l of active) byPair.set(`${l.sourceKey}|${l.componentKey}`, [...(byPair.get(`${l.sourceKey}|${l.componentKey}`) ?? []), l]);
  for (const [, g] of byPair) if (g.length > 1 && g[0].sourceKey !== 'unmatched') out.push({ kind: 'same_source_same_work', lineIds: g.map((x) => x.lineId), message: 'The same change is priced more than once from the same BOQ row. Keep one.' });

  for (const a of active) {
    if (a.origin !== 'boq') continue;
    const phrases = bundledPhrases(a.description);
    if (phrases.length === 0) continue;
    for (const b of active) {
      if (b.lineId === a.lineId || b.componentKey === a.componentKey) continue;
      const hit = phrases.find((p) => b.covers.some((c) => c.includes(p) || p.includes(c)));
      if (hit) out.push({ kind: 'composite_rate', lineIds: [a.lineId, b.lineId], message: `The rate for “${a.description.slice(0, 70)}” already includes “${hit.replace(/-/g, ' ')}”, which is also priced separately. Value it once.` });
    }
  }

  const priced = new Map<string, OverlapLine[]>();
  for (const l of active) if (l.origin !== 'new_item') priced.set(l.componentKey, [...(priced.get(l.componentKey) ?? []), l]);
  for (const l of active) {
    if (l.origin !== 'new_item' || !l.linkedComponentKey) continue;
    const others = priced.get(l.linkedComponentKey);
    if (others && others.length) out.push({ kind: 'manual_linked_duplicate', lineIds: [l.lineId, ...others.map((o) => o.lineId)], message: 'This added item is linked to a change that is already priced. Keep either the matched line or the added item, not both.' });
  }

  // Merge identical issues
  const seen = new Set<string>();
  return out.filter((i) => { const k = `${i.kind}:${[...i.lineIds].sort().join(',')}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Line ids that must be held out of the priced subtotal until the overlap is resolved. The first line in each issue is kept. */
export function heldOutByOverlap(issues: OverlapIssue[]): Set<string> {
  const held = new Set<string>();
  for (let i of issues) for (const id of i.lineIds.slice(1)) held.add(id);
  return held;
}

// ---------- Replacement ----------

export type ReplacementMethod =
  | { kind: 'explicit'; removedLineId: string; addedLineId: string }
  | { kind: 'rate_difference'; evidence: string; oldRate: string; newRate: string; unit: string; quantity: string; currency: string };

export type ReplacementResult =
  | { ok: true; method: 'explicit' | 'rate_difference'; signedAmount: string; formula: string }
  | { ok: false; message: string };

/**
 * A replacement is never a simple addition. Either both the removed and the added work are valued explicitly
 * (removed is an omission, added is an addition), or a rate-difference method is used with its evidence stated.
 */
export function valueReplacement(method: ReplacementMethod, byId: Map<string, { signedAmount: string | null }>): ReplacementResult {
  if (method.kind === 'explicit') {
    const rem = byId.get(method.removedLineId); const add = byId.get(method.addedLineId);
    if (!rem || !add) return { ok: false, message: 'Both the removed work and the added work must be present as lines.' };
    if (rem.signedAmount === null || add.signedAmount === null) return { ok: false, message: 'One side of the replacement is unpriced, so the net cannot be stated.' };
    const removed = D(rem.signedAmount); const added = D(add.signedAmount);
    if (removed.gt(D('0'))) return { ok: false, message: 'The removed work must be an omission (a negative amount).' };
    if (added.lt(D('0'))) return { ok: false, message: 'The added work must be an addition (a positive amount).' };
    const net = added.add(removed);
    return { ok: true, method: 'explicit', signedAmount: net.toString(), formula: `added ${added.toString()} + removed ${removed.toString()} = ${net.toString()}` };
  }
  if (!method.evidence.trim()) return { ok: false, message: 'A rate-difference replacement needs the evidence that the rates are comparable.' };
  for (const v of [method.oldRate, method.newRate, method.quantity]) if (!validateDecimalText(v) || D(v).isNeg()) return { ok: false, message: 'Rates and quantity must be non-negative numbers.' };
  const diff = D(method.newRate).sub(D(method.oldRate));
  const amount = diff.mul(D(method.quantity));
  return { ok: true, method: 'rate_difference', signedAmount: amount.toString(), formula: `(${method.newRate} − ${method.oldRate}) ${method.currency}/${method.unit} × ${method.quantity} ${method.unit} = ${amount.toString()} ${method.currency}` };
}

// ---------- Dimension validation for manual items ----------

export interface DerivationEvidence { name: string; value: string; unit: string; evidence: string }

export type DimensionCheck =
  | { ok: true; factor: string; note: string }
  | { ok: false; kind: 'incompatible' | 'needs_dimensions'; message: string; required: string[] };

/**
 * Check that an item unit can price a change quantity. Same dimension converts exactly. Length to area and area to
 * volume are only allowed with the supporting dimension AND its evidence; nothing is assumed.
 */
export function checkItemDimension(changeUnit: string, itemUnit: string, supporting: DerivationEvidence[] = []): DimensionCheck {
  if (!changeUnit.trim() || !itemUnit.trim()) return { ok: true, factor: '1', note: 'No unit comparison possible yet.' };
  const plan = planConversion(changeUnit, itemUnit);
  if (plan.kind === 'identity') return { ok: true, factor: '1', note: 'Units match.' };
  if (plan.kind === 'same_dimension') return { ok: true, factor: plan.factor, note: `Same-dimension conversion, factor ${plan.factor}.` };
  if (plan.kind === 'invalid') return { ok: false, kind: 'incompatible', message: plan.reason, required: [] };
  const missing = plan.required.filter((n) => {
    const s = supporting.find((x) => x.name === n);
    return !s || !s.evidence.trim() || !validateDecimalText(s.value) || D(s.value).isNeg() || D(s.value).isZero();
  });
  if (missing.length) {
    return { ok: false, kind: 'needs_dimensions', message: `${changeUnit} (${dimensionOf(changeUnit)}) cannot price ${itemUnit} (${dimensionOf(itemUnit)}) without ${missing.join(', ')} and where each comes from. ${plan.explanation}`, required: missing };
  }
  return { ok: true, factor: 'derived', note: `Derivation permitted with ${supporting.map((s) => `${s.name} ${s.value} ${s.unit} (${s.evidence})`).join('; ')}.` };
}

// ---------- Rate state ----------

export type RateState = { state: 'unpriced' } | { state: 'zero'; basisRequired: true; basis: string } | { state: 'value'; value: string };

/** Blank is unpriced. An explicit zero is a different state and must carry a basis. */
export function classifyRate(text: string, zeroBasis: string): { ok: true; rate: RateState } | { ok: false; message: string } {
  const t = text.replace(/,/g, '').trim();
  if (t === '') return { ok: true, rate: { state: 'unpriced' } };
  if (!validateDecimalText(t) || D(t).isNeg()) return { ok: false, message: 'The rate must be a non-negative number.' };
  if (D(t).isZero()) {
    if (!zeroBasis.trim()) return { ok: false, message: 'An explicit zero rate needs a stated basis (for example “free-issue by employer”). Leave the rate blank to keep it unpriced.' };
    return { ok: true, rate: { state: 'zero', basisRequired: true, basis: zeroBasis.trim() } };
  }
  return { ok: true, rate: { state: 'value', value: t } };
}

// ---------- Status of every line for the totals ----------

export type LineDisposition = 'priced' | 'unpriced' | 'excluded' | 'deferred' | 'held_overlap';

export interface TotalsLine {
  lineId: string;
  currency: string;
  signedAmount: string | null;
  disposition: LineDisposition;
  /** 'cost_only' keeps the schedule scope; 'scenario' removes it. Deferral never removes schedule scope. */
  excludedScope?: 'cost_only' | 'scenario';
}

export interface CurrencyTotals {
  currency: string;
  pricedSubtotal: string | null;
  pricedCount: number;
  unpricedCount: number;
  excludedCount: number;
  deferredCount: number;
  heldCount: number;
  /** Complete only when every included line is priced; otherwise a partial subtotal. */
  complete: boolean;
}

export interface TotalsSummary {
  perCurrency: CurrencyTotals[];
  /** More than one currency: no combined figure is produced without an explicit exchange rate. */
  mixedCurrency: boolean;
  scheduleScopeRetained: number;
  scheduleScopeRemoved: number;
}

/** Totals per currency. Different currencies are never added together. Deferred and excluded scope is counted, not hidden. */
export function totalsFor(lines: TotalsLine[]): TotalsSummary {
  const currencies = Array.from(new Set(lines.map((l) => l.currency).filter(Boolean)));
  const perCurrency = currencies.map<CurrencyTotals>((cur) => {
    const ls = lines.filter((l) => l.currency === cur);
    const priced = ls.filter((l) => l.disposition === 'priced' && l.signedAmount !== null);
    const unpriced = ls.filter((l) => l.disposition === 'unpriced');
    const deferred = ls.filter((l) => l.disposition === 'deferred');
    const held = ls.filter((l) => l.disposition === 'held_overlap');
    const excluded = ls.filter((l) => l.disposition === 'excluded');
    const sum = priced.reduce((a, l) => a.add(D(l.signedAmount as string)), D('0'));
    return { currency: cur, pricedSubtotal: priced.length ? sum.toString() : null, pricedCount: priced.length, unpricedCount: unpriced.length, excludedCount: excluded.length, deferredCount: deferred.length, heldCount: held.length, complete: priced.length > 0 && unpriced.length === 0 && deferred.length === 0 && held.length === 0 };
  });
  const excluded = lines.filter((l) => l.disposition === 'excluded');
  return {
    perCurrency,
    mixedCurrency: currencies.length > 1,
    scheduleScopeRetained: lines.filter((l) => l.disposition !== 'excluded' || l.excludedScope === 'cost_only').length,
    scheduleScopeRemoved: excluded.filter((l) => l.excludedScope === 'scenario').length,
  };
}

// ---------- Source fingerprint and stale detection ----------

export interface SourceFingerprint { boq: string; scope: string; mapping: string; documents: string; createdAt: string }

/** Small deterministic hash (FNV-1a, 32-bit) for change detection only. Not a security hash. */
export function fingerprint(parts: unknown): string {
  const s = typeof parts === 'string' ? parts : JSON.stringify(parts);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

export function makeFingerprint(args: { boqSignature: string; scopeKeys: string[]; mapping: unknown; documents: string[] }): SourceFingerprint {
  return {
    boq: fingerprint(args.boqSignature),
    scope: fingerprint([...args.scopeKeys].sort()),
    mapping: fingerprint(args.mapping),
    documents: fingerprint([...args.documents].sort()),
    createdAt: new Date().toISOString(),
  };
}

export type StaleReason = 'boq' | 'scope' | 'mapping' | 'documents';

/** Which inputs changed since the decisions were made. An empty list means the saved results are still current. */
export function staleReasons(saved: SourceFingerprint | null, now: SourceFingerprint): StaleReason[] {
  if (!saved) return [];
  const out: StaleReason[] = [];
  if (saved.boq !== now.boq) out.push('boq');
  if (saved.scope !== now.scope) out.push('scope');
  if (saved.mapping !== now.mapping) out.push('mapping');
  if (saved.documents !== now.documents) out.push('documents');
  return out;
}

export const STALE_LABEL: Record<StaleReason, string> = {
  boq: 'The BOQ rates, quantities or files changed.',
  scope: 'The change scope or drawing quantities changed.',
  mapping: 'The BOQ mapping changed.',
  documents: 'The source documents changed.',
};

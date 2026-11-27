import { D } from '../assessment/decimal';
import { canonUnit, dimensionOf, planConversion } from './units';
import { validateDecimalText } from './calc';

/**
 * Per-line cost resolutions for the real uploaded-BOQ workflow.
 * Keyed by change component id and stored per case. Nothing here edits the source BOQ.
 */

export type ExclusionScope = 'cost_only' | 'scenario';

export interface ManualRate {
  /** Decimal text. "0" is an explicit zero and then `zeroBasis` is required; a blank value is never stored. */
  value: string;
  /** Present only for explicit, case-scoped processed-PVR fallback. */
  processedPvr?: { file: string; page: string; row: string; scopeKey: string };
  currency: string;
  /** Unit the rate is expressed per, e.g. m3. */
  unit: string;
  reason: string;
  reference: string;
  attachmentName: string;
  inclusions: { labour: boolean; materials: boolean; plant: boolean; overheads: boolean; profit: boolean };
  /** Free-text statement of anything the rate leaves out. Nothing is added automatically to cover it. */
  exclusionsNote?: string;
  /** How the rate was arrived at (quotation, similar item, estimate...). */
  rateBasis?: string;
  /** Why an explicit zero rate is correct. Required when value is 0. */
  zeroBasis?: string;
  enteredBy: string;
  enteredAt: string;
  /** Always proposed. No approval workflow exists for this, so none is implied. */
  status: 'proposed';
}

export type RateScope = { id: string; name: string; action: string; location: string; specification: string };
export const processedPvrScopeKey = (scope: RateScope) => JSON.stringify(
  [scope.id, scope.name, scope.action, scope.location, scope.specification].map((s) => s.trim().toLowerCase()),
);
export function validProcessedPvrRate(rate: ManualRate, scope: RateScope, quantityUnit: string, caseCurrency: string): boolean {
  const p = rate.processedPvr;
  return !!p && !!p.file.trim() && /^\d+$/.test(p.page.trim()) && Number(p.page) > 0 && !!p.row.trim()
    && !!quantityUnit.trim() && !!rate.unit.trim() && sameRateUnit(quantityUnit, rate.unit)
    && rate.currency.trim().toUpperCase() === caseCurrency.trim().toUpperCase()
    && p.scopeKey === processedPvrScopeKey(scope);
}

export type LineResolution =
  | { kind: 'manual_rate'; manual: ManualRate }
  | { kind: 'excluded'; scope: ExclusionScope; reason: string; by: string; at: string }
  | { kind: 'deferred'; reason: string; by: string; at: string }
  | { kind: 'unresolved'; at: string };

export type Resolutions = Record<string, LineResolution>;

export const EMPTY_RESOLUTIONS: Resolutions = {};

export type ManualPriceResult =
  | { ok: true; quantity: string; quantityUnit: string; rate: string; rateUnit: string; currency: string; amount: string; signedAmount: string; formula: string }
  | { ok: false; kind: 'invalid_rate' | 'invalid_quantity' | 'dimension_mismatch' | 'unsupported_unit'; message: string };

/**
 * Price a quantity with a manual rate. The rate unit must be dimensionally compatible with the quantity unit.
 * Same-dimension units (e.g. mm to m) convert through the existing conversion logic. Different dimensions are
 * rejected: a rate per m2 can never price an m3 quantity.
 */
export function priceWithManualRate(args: { quantity: string; quantityUnit: string; rate: string; rateUnit: string; currency: string; direction: 'addition' | 'omission'; zeroBasis?: string; requireZeroBasis?: boolean }): ManualPriceResult {
  const rateText = args.rate.replace(/,/g, '').trim();
  if (rateText === '') return { ok: false, kind: 'invalid_rate', message: 'Enter a rate. A blank rate stays unpriced; enter 0 only if the work is genuinely free of charge.' };
  if (!validateDecimalText(rateText) || D(rateText).isNeg()) return { ok: false, kind: 'invalid_rate', message: 'Enter the rate as a non-negative number.' };
  if (args.requireZeroBasis && D(rateText).isZero() && !(args.zeroBasis ?? '').trim()) return { ok: false, kind: 'invalid_rate', message: 'An explicit zero rate needs a stated basis (for example free-issue by the employer). Leave the rate blank to keep the item unpriced.' };
  const qtyText = args.quantity.replace(/,/g, '').trim();
  if (!validateDecimalText(qtyText) || D(qtyText).isNeg() || D(qtyText).isZero()) return { ok: false, kind: 'invalid_quantity', message: 'The change quantity must be a positive number.' };
  if (args.quantityUnit.trim() === '' || args.rateUnit.trim() === '') return { ok: false, kind: 'unsupported_unit', message: 'Both the quantity unit and the rate unit are required.' };

  const plan = planConversion(args.quantityUnit, args.rateUnit);
  let convertedQty = D(qtyText);
  let note = '';
  if (plan.kind === 'invalid') return { ok: false, kind: 'unsupported_unit', message: plan.reason };
  if (plan.kind === 'needs_derivation') {
    return {
      ok: false,
      kind: 'dimension_mismatch',
      message: `Rejected: a rate per ${args.rateUnit} (${dimensionOf(args.rateUnit)}) cannot price a quantity in ${args.quantityUnit} (${dimensionOf(args.quantityUnit)}). Enter the rate per ${args.quantityUnit} instead, or use a BOQ rate in a compatible unit. ${plan.explanation}`,
    };
  }
  if (plan.kind === 'same_dimension') {
    convertedQty = convertedQty.mul(D(plan.factor));
    note = ` (converted from ${qtyText} ${args.quantityUnit} using factor ${plan.factor})`;
  }
  const amount = convertedQty.mul(D(rateText));
  const signed = args.direction === 'omission' ? amount.neg() : amount;
  return {
    ok: true,
    quantity: qtyText,
    quantityUnit: args.quantityUnit.trim(),
    rate: rateText,
    rateUnit: args.rateUnit.trim(),
    currency: args.currency,
    amount: amount.toString(),
    signedAmount: signed.toString(),
    formula: `${args.direction === 'omission' ? '−' : '+'} ${convertedQty.toString()} ${args.rateUnit.trim()}${note} × ${rateText} ${args.currency}/${args.rateUnit.trim()} = ${signed.toString()} ${args.currency}`,
  };
}

export interface SummaryLine {
  key: string;
  componentId: string;
  /** Included in the active assessment. */
  included: boolean;
  /** Priced amount (signed once), or null when unpriced. */
  signedAmount: string | null;
  source: 'boq' | 'manual_proposed' | 'none';
  excludedScope?: ExclusionScope;
  /** Valuation deliberately postponed. Not excluded, not zero. */
  deferred?: boolean;
}

export interface CostSummary {
  currency: string;
  pricedSubtotal: string | null;
  pricedCount: number;
  unpricedIncluded: number;
  excludedCount: number;
  excludedCostOnly: number;
  excludedScenario: number;
  deferredCount: number;
  manualProposedAmount: string | null;
  manualProposedCount: number;
  /** True only when every included line is priced and none relies on an unresolved or deferred item. */
  fullyPriced: boolean;
}

/** Build the separate totals. Never invents a value for unpriced scope and never labels a partial subtotal as complete. */
export function summariseCost(lines: SummaryLine[], currency: string): CostSummary {
  const included = lines.filter((l) => l.included);
  const deferred = included.filter((l) => l.deferred);
  const active = included.filter((l) => !l.deferred);
  const priced = active.filter((l) => l.signedAmount !== null);
  const manual = priced.filter((l) => l.source === 'manual_proposed');
  const sum = (xs: SummaryLine[]) => xs.reduce((a, l) => a.add(D(l.signedAmount as string)), D('0')).toString();
  const excluded = lines.filter((l) => !l.included);
  const unpriced = active.length - priced.length;
  return {
    currency,
    pricedSubtotal: priced.length ? sum(priced) : null,
    pricedCount: priced.length,
    unpricedIncluded: unpriced,
    excludedCount: excluded.length,
    excludedCostOnly: excluded.filter((l) => l.excludedScope === 'cost_only').length,
    excludedScenario: excluded.filter((l) => l.excludedScope === 'scenario').length,
    deferredCount: deferred.length,
    manualProposedAmount: manual.length ? sum(manual) : null,
    manualProposedCount: manual.length,
    fullyPriced: included.length > 0 && unpriced === 0 && deferred.length === 0,
  };
}

export type ResolutionChange = 'rate' | 'exclude_cost_only' | 'exclude_scenario' | 'restore_cost_only' | 'restore_scenario' | 'unresolved' | 'defer' | 'restore_deferred';

/**
 * Which downstream results a change invalidates. A cost-only change never touches schedule results.
 * Scenario-wide scope changes invalidate schedule (and so any results derived from it).
 */
export function staleEffects(change: ResolutionChange): { cost: boolean; schedule: boolean } {
  if (change === 'exclude_scenario' || change === 'restore_scenario') return { cost: true, schedule: true };
  return { cost: true, schedule: false };
}

export function describeChange(prev: LineResolution | undefined, next: LineResolution | undefined): ResolutionChange {
  const was = prev?.kind === 'excluded' ? prev : null;
  const now = next?.kind === 'excluded' ? next : null;
  if (now?.scope === 'scenario') return 'exclude_scenario';
  if (now?.scope === 'cost_only') return 'exclude_cost_only';
  if (was?.scope === 'scenario') return 'restore_scenario';
  if (was?.scope === 'cost_only') return 'restore_cost_only';
  if (next?.kind === 'deferred') return 'defer';
  if (prev?.kind === 'deferred' && !next) return 'restore_deferred';
  if (next?.kind === 'unresolved') return 'unresolved';
  return 'rate';
}

export function sameRateUnit(a: string, b: string): boolean {
  return canonUnit(a) === canonUnit(b);
}

// ---------- Persistence (case-scoped) ----------

export interface ResolutionState {
  resolutions: Resolutions;
  /** Set when a scenario-wide scope change invalidated schedule results; cleared only by a recalculation. */
  scheduleStale: boolean;
  /** Set whenever any resolution changed since the last confirmed assessment. */
  costStale: boolean;
  updatedAt: string;
}

export const EMPTY_STATE: ResolutionState = { resolutions: {}, scheduleStale: false, costStale: false, updatedAt: '' };

const PREFIX = 'pvr-line-resolutions:';

export const DEFAULT_SCENARIO = 'base';

export function storageKey(caseId: string, scenarioId = DEFAULT_SCENARIO): string {
  return scenarioId === DEFAULT_SCENARIO ? `${PREFIX}${caseId}` : `${PREFIX}${caseId}:${scenarioId}`;
}

/** Local persistence keyed by case id and scenario. Real cases and demo data never share a key. */
export function readResolutionState(caseId: string, scenarioId = DEFAULT_SCENARIO): ResolutionState {
  try {
    const raw = window.localStorage.getItem(storageKey(caseId, scenarioId));
    if (!raw) return EMPTY_STATE;
    const p = JSON.parse(raw) as Partial<ResolutionState>;
    return { resolutions: p.resolutions ?? {}, scheduleStale: !!p.scheduleStale, costStale: !!p.costStale, updatedAt: p.updatedAt ?? '' };
  } catch { return EMPTY_STATE; }
}

export function writeResolutionState(caseId: string, state: ResolutionState, scenarioId = DEFAULT_SCENARIO): boolean {
  try { window.localStorage.setItem(storageKey(caseId, scenarioId), JSON.stringify(state)); return true; } catch { return false; }
}

// ---------- Stable line identity ----------

/**
 * A stable id for a costed line. It is built from what the line IS (the source row, or the new item's own id),
 * never from the BOQ reference alone and never from a model-generated component id that changes on re-analysis.
 *   source row:  <importId>|<sheet>|<rowNumber>
 *   new item:    new|<newItemId>
 *   no match:    scope|<normalised component name>
 */
export function stableLineId(parts: { importId?: string; sheet?: string; rowNumber?: number; newItemId?: string; componentName?: string }): string {
  if (parts.newItemId) return `new|${parts.newItemId}`;
  if (parts.importId && parts.sheet !== undefined && parts.rowNumber !== undefined) return `${parts.importId}|${parts.sheet}|${parts.rowNumber}`;
  return `scope|${(parts.componentName ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

/** Resolution record that remembers what it was made against, so source revisions can invalidate it. */
export interface StoredDecision {
  lineId: string;
  /** Component id at the time, kept for display only. */
  componentId: string;
  resolution: LineResolution;
  /** Signature of the BOQ set (import id + sha) the decision was made against. */
  sourceSignature: string;
}

export interface DecisionStore {
  decisions: Record<string, StoredDecision>;
  updatedAt: string;
  /** Fingerprint of the sources the decisions were made against. Absent on stores saved before this field existed. */
  fingerprint?: import('./valuation').SourceFingerprint;
}

export const EMPTY_DECISIONS: DecisionStore = { decisions: {}, updatedAt: '' };

const DECISION_PREFIX = 'pvr-line-decisions:';
const decisionKey = (caseId: string, scenarioId: string) => `${DECISION_PREFIX}${caseId}:${scenarioId}`;

export function readDecisions(caseId: string, scenarioId = DEFAULT_SCENARIO): DecisionStore {
  try {
    const raw = window.localStorage.getItem(decisionKey(caseId, scenarioId));
    if (!raw) return EMPTY_DECISIONS;
    const p = JSON.parse(raw) as Partial<DecisionStore>;
    return { decisions: p.decisions ?? {}, updatedAt: p.updatedAt ?? '', fingerprint: p.fingerprint };
  } catch { return EMPTY_DECISIONS; }
}

export function writeDecisions(caseId: string, store: DecisionStore, scenarioId = DEFAULT_SCENARIO): boolean {
  try { window.localStorage.setItem(decisionKey(caseId, scenarioId), JSON.stringify(store)); return true; } catch { return false; }
}

/**
 * Keep decisions made against the current source; flag the rest as invalidated. A manual rate or exclusion made for
 * a source row whose file changed is not applied silently - it is returned in `invalidated` for the user to review.
 * Decisions for new items and unmatched scope are independent of the BOQ source and always survive.
 */
export function reconcileDecisions(store: DecisionStore, currentSignature: string): { active: StoredDecision[]; invalidated: StoredDecision[] } {
  const active: StoredDecision[] = []; const invalidated: StoredDecision[] = [];
  for (const d of Object.values(store.decisions)) {
    // Decisions for added items and for scope with no BOQ row do not depend on the BOQ source.
    const independent = d.lineId.startsWith('new|') || d.lineId.startsWith('scope|') || d.lineId.startsWith('unmatched#');
    if (independent || d.sourceSignature === currentSignature) active.push(d); else invalidated.push(d);
  }
  return { active, invalidated };
}

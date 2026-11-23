import { D } from '../assessment/decimal';
import { validateDecimalText } from './calc';
import { dimensionOf, planConversion } from './units';
import { checkItemDimension, classifyRate, type DerivationEvidence } from './valuation';

/**
 * Case-specific "assessment items": scope that has no suitable BOQ row. They are stored with the case, never written
 * back to a source BOQ, and flow to activity mapping and cost calculation like any other costed line.
 * A missing quantity or rate stays missing. It is never converted to zero.
 */

export type NewItemChangeType = 'addition' | 'omission' | 'substitution' | 'rework';
export type RateBasis = 'quotation' | 'similar_boq_item' | 'market_rate' | 'daywork' | 'engineer_estimate' | 'contractor_proposal' | 'other';

export const RATE_BASIS_LABEL: Record<RateBasis, string> = {
  quotation: 'Quotation', similar_boq_item: 'Similar BOQ item', market_rate: 'Market rate', daywork: 'Daywork',
  engineer_estimate: "Engineer's estimate", contractor_proposal: 'Contractor proposal', other: 'Other',
};

export interface AssessmentItem {
  id: string;
  caseId: string;
  description: string;
  uom: string;
  /** Decimal text, or null when unknown. Null is never treated as 0. */
  quantity: string | null;
  rate: string | null;
  currency: string;
  changeType: NewItemChangeType;
  location: string;
  /** The scope component or drawing change this item belongs to (component id / change id). */
  linkedScope: string;
  linkedScopeLabel: string;
  rateBasis: RateBasis | '';
  supportingReference: string;
  /** Where the prefill came from, when it came from evidence. */
  prefillSource: string;
  /** Optional so items saved before these fields existed still load. */
  zeroBasis?: string;
  inclusionsExclusions?: string;
  changeUnit?: string;
  supporting?: DerivationEvidence[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  status: 'proposed';
}

export interface ItemDraft {
  description: string;
  uom: string;
  quantity: string;
  rate: string;
  currency: string;
  changeType: NewItemChangeType;
  location: string;
  linkedScope: string;
  linkedScopeLabel: string;
  rateBasis: RateBasis | '';
  supportingReference: string;
  prefillSource: string;
  /** Explicit "I do not know yet" switches, so a blank is a decision and not an accident. */
  quantityUnknown: boolean;
  unpriced: boolean;
  /** Why an explicit zero rate is correct. Required when the rate is 0. */
  zeroBasis: string;
  /** What the rate includes and leaves out. Nothing is added automatically to cover an exclusion. */
  inclusionsExclusions: string;
  /** Unit of the linked change's quantity, used to check the item unit is compatible. */
  changeUnit: string;
  /** Supporting dimensions with their evidence, needed for length-to-area or area-to-volume. */
  supporting: DerivationEvidence[];
}

export const EMPTY_DRAFT: ItemDraft = {
  description: '', uom: '', quantity: '', rate: '', currency: 'AED', changeType: 'addition', location: '', linkedScope: '', linkedScopeLabel: '',
  rateBasis: '', supportingReference: '', prefillSource: '', quantityUnknown: false, unpriced: false, zeroBasis: '', inclusionsExclusions: '', changeUnit: '', supporting: [],
};

export type DraftIssue = { field: keyof ItemDraft; message: string };

export function validateDraft(d: ItemDraft): DraftIssue[] {
  const out: DraftIssue[] = [];
  if (d.description.trim() === '') out.push({ field: 'description', message: 'Describe the work.' });
  if (d.uom.trim() === '') out.push({ field: 'uom', message: 'Enter the unit of measure.' });
  const q = d.quantity.replace(/,/g, '').trim();
  if (!d.quantityUnknown) {
    if (q === '') out.push({ field: 'quantity', message: 'Enter a quantity, or tick "Quantity not known yet" to save it without one.' });
    else if (!validateDecimalText(q) || D(q).isNeg()) out.push({ field: 'quantity', message: 'The quantity must be a non-negative number.' });
  }
  const r = d.rate.replace(/,/g, '').trim();
  if (!d.unpriced) {
    if (r === '') out.push({ field: 'rate', message: 'Enter a rate (0 only if genuinely free of charge), or tick "Leave unpriced" to save it without one.' });
    else {
      const cls = classifyRate(r, d.zeroBasis);
      if (!cls.ok) out.push({ field: /zero/i.test(cls.message) ? 'zeroBasis' : 'rate', message: cls.message });
    }
  }
  if (!d.unpriced && r !== '' && d.rateBasis === '') out.push({ field: 'rateBasis', message: 'State the basis of the rate.' });
  if (d.currency.trim() === '') out.push({ field: 'currency', message: 'Enter a currency.' });
  if (d.changeUnit.trim() && d.uom.trim() && !d.unpriced && r !== '') {
    const dim = checkItemDimension(d.changeUnit, d.uom, d.supporting);
    if (!dim.ok) out.push({ field: 'uom', message: dim.message });
  }
  return out;
}

export interface ItemPreview {
  state: 'amount' | 'unpriced' | 'no_quantity' | 'neither';
  amount: string | null;
  signedAmount: string | null;
  formula: string;
}

/** Quantity x rate for display before saving. Missing values give a stated reason, never 0. */
export function previewDraft(d: ItemDraft): ItemPreview {
  const q = d.quantityUnknown ? '' : d.quantity.replace(/,/g, '').trim();
  const r = d.unpriced ? '' : d.rate.replace(/,/g, '').trim();
  const qOk = q !== '' && validateDecimalText(q) && !D(q).isNeg();
  const rOk = r !== '' && validateDecimalText(r) && !D(r).isNeg();
  if (!qOk && !rOk) return { state: 'neither', amount: null, signedAmount: null, formula: 'No quantity and no rate yet. Nothing is calculated.' };
  if (!qOk) return { state: 'no_quantity', amount: null, signedAmount: null, formula: 'Quantity is not known, so no amount is calculated.' };
  if (!rOk) return { state: 'unpriced', amount: null, signedAmount: null, formula: 'Unpriced: the quantity is recorded but no rate has been given. This is not zero.' };
  const amount = D(q).mul(D(r));
  const signed = d.changeType === 'omission' ? amount.neg() : amount;
  return { state: 'amount', amount: amount.toString(), signedAmount: signed.toString(), formula: `${d.changeType === 'omission' ? '−' : '+'} ${q} ${d.uom || 'unit'} × ${r} ${d.currency}/${d.uom || 'unit'} = ${signed.toString()} ${d.currency}` };
}

export function itemFromDraft(d: ItemDraft, caseId: string, id: string, who: string, existing?: AssessmentItem): AssessmentItem {
  const now = new Date().toISOString();
  return {
    id, caseId, description: d.description.trim(), uom: d.uom.trim(),
    quantity: d.quantityUnknown || d.quantity.trim() === '' ? null : d.quantity.replace(/,/g, '').trim(),
    rate: d.unpriced || d.rate.trim() === '' ? null : d.rate.replace(/,/g, '').trim(),
    currency: d.currency.trim(), changeType: d.changeType, location: d.location.trim(), linkedScope: d.linkedScope, linkedScopeLabel: d.linkedScopeLabel,
    rateBasis: d.rateBasis, supportingReference: d.supportingReference.trim(), prefillSource: d.prefillSource,
    zeroBasis: d.zeroBasis.trim(), inclusionsExclusions: d.inclusionsExclusions.trim(), changeUnit: d.changeUnit.trim(), supporting: d.supporting,
    createdBy: existing?.createdBy ?? who, createdAt: existing?.createdAt ?? now, updatedAt: now, status: 'proposed',
  };
}

export function draftFromItem(i: AssessmentItem): ItemDraft {
  return {
    description: i.description, uom: i.uom, quantity: i.quantity ?? '', rate: i.rate ?? '', currency: i.currency, changeType: i.changeType, location: i.location,
    linkedScope: i.linkedScope, linkedScopeLabel: i.linkedScopeLabel, rateBasis: i.rateBasis, supportingReference: i.supportingReference, prefillSource: i.prefillSource,
    quantityUnknown: i.quantity === null, unpriced: i.rate === null, zeroBasis: i.zeroBasis ?? '', inclusionsExclusions: i.inclusionsExclusions ?? '', changeUnit: i.changeUnit ?? '', supporting: i.supporting ?? [],
  };
}

/** Prefill from a scope component the agent identified. Only fields the evidence actually states are filled. */
export function prefillFromComponent(c: {
  id: string; name: string; action: 'add' | 'omit' | 'replace' | 'rework'; location: string; specification: string; expectedUnit: string;
  quantity: { value: string; unit: string; source: string; quote: string } | null;
}, currency: string): ItemDraft {
  const changeType: NewItemChangeType = c.action === 'omit' ? 'omission' : c.action === 'replace' ? 'substitution' : c.action === 'rework' ? 'rework' : 'addition';
  return {
    ...EMPTY_DRAFT, currency: currency || 'AED',
    description: [c.name, c.specification].filter(Boolean).join(' - '),
    uom: c.quantity?.unit || c.expectedUnit || '',
    quantity: c.quantity?.value ?? '',
    quantityUnknown: !c.quantity,
    changeType, location: c.location, linkedScope: c.id, linkedScopeLabel: c.name,
    changeUnit: c.quantity?.unit || c.expectedUnit || '',
    supportingReference: c.quantity?.source ?? '',
    prefillSource: c.quantity ? `Prefilled from evidence: ${c.quantity.source}${c.quantity.quote ? ` - "${c.quantity.quote.slice(0, 120)}"` : ''}` : 'Prefilled from the identified scope; no quantity is stated in the evidence.',
    unpriced: true,
  };
}

/** A same-dimension unit check used when a new item is mapped to a scope quantity. */
export function itemUnitFits(itemUom: string, scopeUnit: string): { ok: boolean; message: string } {
  if (!itemUom || !scopeUnit) return { ok: true, message: '' };
  const plan = planConversion(scopeUnit, itemUom);
  if (plan.kind === 'identity' || plan.kind === 'same_dimension') return { ok: true, message: '' };
  if (plan.kind === 'needs_derivation') return { ok: false, message: `The item is measured in ${itemUom} (${dimensionOf(itemUom)}) but the scope quantity is in ${scopeUnit} (${dimensionOf(scopeUnit)}).` };
  return { ok: false, message: plan.reason };
}

// ---- Persistence (case-scoped, never in the source BOQ) ----

const KEY = 'pvr-assessment-items:';
export function readItems(caseId: string): AssessmentItem[] {
  try { const raw = window.localStorage.getItem(`${KEY}${caseId}`); return raw ? (JSON.parse(raw) as AssessmentItem[]) : []; } catch { return []; }
}
export function writeItems(caseId: string, items: AssessmentItem[]): boolean {
  try { window.localStorage.setItem(`${KEY}${caseId}`, JSON.stringify(items)); return true; } catch { return false; }
}

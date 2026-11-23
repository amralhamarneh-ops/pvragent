import { D, Dec } from '../assessment/decimal';
import { canonUnit, convertQuantity, planConversion, type BasisKind, type DerivationInput } from './units';
import type { BoqImport, BoqItemRecord, CalcResult, ChangeDirection, ParsedRow } from './types';

export { canonUnit, planConversion };

/** Items eligible for the cost workflow: priced and unpriced items the reviewer confirmed. */
export function recordsFromImport(imp: BoqImport): BoqItemRecord[] {
  return imp.rows
    .filter((r: ParsedRow) => r.included && (r.rowClass === 'item' || r.rowClass === 'unpriced_item'))
    .map((r) => ({
      id: `${imp.id}:${r.id}`,
      importId: imp.id,
      caseId: imp.caseId,
      sheet: r.sheet,
      rowNumber: r.rowNumber,
      bill: r.bill,
      ref: r.ref,
      description: r.description,
      unit: r.unit,
      rate: r.rate,
      quantity: r.quantity,
      cells: r.cells,
      sourceFile: imp.source.fileName,
      sourceSha256: imp.source.sha256,
      currency: imp.source.currency,
    }));
}

const STOP = new Set(['the', 'and', 'of', 'to', 'a', 'in', 'for', 'at', 'with', 'by', 'on', 'new', 'additional', 'extra', 'supply', 'install', 'fix']);

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\u00b2\u00b3.\s-]/g, ' ').split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t));
}

export interface Candidate {
  item: BoqItemRecord;
  score: number;
  unitMatches: boolean | null;
  matched: string[];
}

/** Transparent keyword scoring. Used for suggestions only; the user always selects. */
export function searchItems(items: BoqItemRecord[], query: string, changeUnit?: string): Candidate[] {
  const q = tokens(query);
  const qRaw = query.trim().toLowerCase();
  const out: Candidate[] = [];
  for (const item of items) {
    const hay = `${item.ref} ${item.description} ${item.bill}`.toLowerCase();
    const htoks = new Set(tokens(`${item.ref} ${item.description}`));
    const matched = q.filter((t) => htoks.has(t) || hay.includes(t));
    let score = q.length === 0 ? 0 : matched.length / q.length;
    if (qRaw && (item.ref.toLowerCase() === qRaw)) score = 1.5;
    else if (qRaw && hay.includes(qRaw)) score = Math.max(score, 0.9);
    const unitMatches = changeUnit && item.unit ? sameUnit(changeUnit, item.unit) : null;
    if (unitMatches === true) score += 0.1;
    if (q.length === 0 && qRaw === '') { out.push({ item, score: 0, unitMatches, matched: [] }); continue; }
    if (score > 0 && matched.length + (qRaw && hay.includes(qRaw) ? 1 : 0) > 0) out.push({ item, score, unitMatches, matched });
  }
  return out.sort((a, b) => b.score - a.score || a.item.rowNumber - b.item.rowNumber);
}

export interface CalcInput {
  direction: ChangeDirection;
  quantity: string;
  quantityUnit: string;
  item: BoqItemRecord | null;
  /** Supporting dimensions for a derivation, e.g. { name: 'width', value: '3', unit: 'm' }. */
  derivationInputs?: DerivationInput[];
  /** Where the supporting dimensions came from. Required for any derivation. */
  basis?: { kind: BasisKind; statement: string } | null;
}

export function validateDecimalText(s: string): boolean {
  return /^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(s.replace(/,/g, '').trim());
}

/** Deterministic quantity x rate. No AI, no fallback rates, no zero for missing values, no generic cross-dimension factor. */
export function calculateChange(input: CalcInput): CalcResult {
  const { item } = input;
  if (!item) return { ok: false, kind: 'no_item', message: 'Select a BOQ item first.' };
  if (!validateDecimalText(input.quantity)) return { ok: false, kind: 'invalid_input', message: 'Enter the change quantity as a number.', itemId: item.id };
  let qty: Dec;
  try { qty = D(input.quantity.replace(/,/g, '').trim()); } catch { return { ok: false, kind: 'invalid_input', message: 'Enter the change quantity as a number.', itemId: item.id }; }
  if (qty.isNeg() || qty.isZero()) return { ok: false, kind: 'invalid_input', message: 'Enter a positive quantity. Use the Omission option for removed work.', itemId: item.id };
  if (item.unit.trim() === '') return { ok: false, kind: 'unit_mismatch', message: 'The selected BOQ item has no unit, so the quantity cannot be checked.', itemId: item.id };
  if (input.quantityUnit.trim() === '') return { ok: false, kind: 'invalid_input', message: 'Enter the unit of the change quantity.', itemId: item.id };

  const rate = item.rate;
  if (rate.state === 'missing') return { ok: false, kind: 'unpriced', message: `${item.ref || 'This item'} has no rate in ${item.sourceFile} (${item.sheet}!${rate.cell}). It stays unpriced.`, itemId: item.id };
  if (rate.state === 'invalid' || rate.value === undefined) {
    const why = rate.formulaStatus === 'no_cached_value' ? 'The rate is a formula with no stored result and was not recalculated.' : rate.formulaStatus === 'error' ? 'The rate formula result is an error.' : 'The rate is not a number.';
    return { ok: false, kind: 'unpriced', message: `${why} Cell ${item.sheet}!${rate.cell}. It stays unpriced.`, itemId: item.id };
  }

  // Unit handling: same-dimension is automatic; cross-dimension needs explicit derivation inputs; the rest is unsupported.
  const conv = convertQuantity({ quantity: input.quantity, fromUnit: input.quantityUnit, toUnit: item.unit, inputs: input.derivationInputs, basis: input.basis ?? null });
  if (!conv.ok) return { ok: false, kind: conv.kind, message: conv.message, itemId: item.id };
  const converted = conv.converted;

  const rateDec = D(rate.value);
  const amount = converted.mul(rateDec);
  const signed = input.direction === 'omission' ? amount.neg() : amount;
  const signText = input.direction === 'omission' ? '−' : '+';
  const formula = `${signText} (${conv.audit.derivation}) × ${rate.value} ${item.currency}/${item.unit} = ${signed.toString()} ${item.currency}`;
  return {
    ok: true,
    direction: input.direction,
    quantity: input.quantity.trim(),
    quantityUnit: input.quantityUnit.trim(),
    boqUnit: item.unit,
    converted: converted.toString(),
    rate: rate.value,
    currency: item.currency,
    signedAmount: signed.toString(),
    formula,
    itemId: item.id,
    conversion: conv.audit,
    sources: [{ file: item.sourceFile, sha256: item.sourceSha256, sheet: item.sheet, rateCell: rate.cell, refCell: item.cells.ref, unitCell: item.cells.unit }],
    rateFormulaNote: rate.formulaStatus === 'cached' ? `Rate cell ${rate.cell} is a formula (${rate.formula ?? ''}); the value stored in the file was used and was not recalculated.` : undefined,
  };
}

export function formatSigned(amount: string, currency: string): string {
  const d = D(amount);
  const fixed = d.abs().toFixed(2);
  const [i, f] = fixed.split('.');
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${d.isNeg() ? '−' : ''}${currency} ${grouped}.${f}`;
}

/** True when two unit strings denote the same unit after normalisation (e.g. "Sq.M" and "m²"). Unknown units compare by their cleaned text. */
export function sameUnit(a: string, b: string): boolean {
  const x = canonUnit(a);
  const y = canonUnit(b);
  return x !== '' && x === y;
}


import type { BoqImport, CalcResult, ChangeDirection, ConversionAuditRecord } from './types';

/**
 * Saved calculations and revision invalidation.
 *
 * A calculation is an immutable evidence record. It names the exact import revision, row, rate, quantity and
 * conversion basis it used. Selecting a different import revision never edits or deletes a calculation. It only
 * changes how the record is presented: a calculation whose import is no longer the selected one is "stale".
 */

export type CalcStatus = 'current' | 'needs_review';

export interface SavedCalculation {
  id: string;
  caseId: string;
  createdAt: string;
  description: string;
  direction: ChangeDirection;
  /** Import revision this result was computed from. */
  importId: string;
  importRevision: number;
  importFileName: string;
  importSha256: string;
  /** Selected BOQ row (record id), with its human reference. */
  itemId: string;
  itemRef: string;
  itemDescription: string;
  sheet: string;
  rowNumber: number;
  rateCell: string;
  rate: string;
  currency: string;
  boqUnit: string;
  quantity: string;
  quantityUnit: string;
  convertedQuantity: string;
  signedAmount: string;
  formula: string;
  conversion: ConversionAuditRecord;
  /** Set once a reviewer has confirmed the remapping after a revision change. */
  reviewedAgainstImportId: string | null;
}

export interface StaleInfo {
  status: CalcStatus;
  /** Plain-language reason, or empty when current. */
  reason: string;
  /** Which input changed, for display. */
  changed: { from: string; to: string } | null;
  /** True when the row no longer exists or its rate/unit differ in the selected revision. */
  rowChanged: boolean;
  rowMissing: boolean;
}

function revLabel(imp: BoqImport | undefined, fallbackRev: number, fallbackName: string): string {
  return imp ? `revision ${imp.revision} (${imp.source.fileName}, ${imp.source.sha256.slice(0, 10)}…)` : `revision ${fallbackRev} (${fallbackName})`;
}

/** Match a row in another revision: same sheet and BOQ reference when present, else same sheet and description. */
export function findCounterpart(calc: SavedCalculation, imp: BoqImport): BoqImport['rows'][number] | null {
  const included = imp.rows.filter((r) => r.included && (r.rowClass === 'item' || r.rowClass === 'unpriced_item'));
  if (calc.itemRef) {
    const byRef = included.filter((r) => r.sheet === calc.sheet && r.ref === calc.itemRef);
    if (byRef.length === 1) return byRef[0];
    if (byRef.length > 1) return null; // ambiguous: a reviewer must remap
  }
  const byDesc = included.filter((r) => r.sheet === calc.sheet && r.description.trim().toLowerCase() === calc.itemDescription.trim().toLowerCase());
  return byDesc.length === 1 ? byDesc[0] : null;
}

/**
 * Is this calculation current for the selected import revision?
 * A result is current only when it was computed from the selected import, or a reviewer confirmed it against it.
 */
export function staleness(calc: SavedCalculation, selected: BoqImport | null, allImports: BoqImport[]): StaleInfo {
  if (!selected) return { status: 'needs_review', reason: 'No BOQ revision is selected, so this result cannot be shown as current.', changed: null, rowChanged: false, rowMissing: false };
  if (calc.importId === selected.id || calc.reviewedAgainstImportId === selected.id) {
    return { status: 'current', reason: '', changed: null, rowChanged: false, rowMissing: false };
  }
  const used = allImports.find((i) => i.id === calc.importId);
  const from = revLabel(used, calc.importRevision, calc.importFileName);
  const to = revLabel(selected, selected.revision, selected.source.fileName);
  const row = findCounterpart(calc, selected);
  if (!row) {
    return { status: 'needs_review', reason: `Computed from ${from}. The selected ${to} has no single matching row for ${calc.itemRef || calc.itemDescription}. Remap the item and recalculate.`, changed: { from, to }, rowChanged: true, rowMissing: true };
  }
  const rateNow = row.rate.state === 'value' ? row.rate.value : undefined;
  const changed = rateNow !== calc.rate || row.unit !== calc.boqUnit;
  const detail = rateNow === undefined ? 'the rate is now missing or invalid' : changed ? `rate ${calc.rate} → ${rateNow}, unit ${calc.boqUnit} → ${row.unit}` : 'the values look unchanged but the evidence is a different file version';
  return { status: 'needs_review', reason: `Computed from ${from}; the selected ${to} is a different input (${detail}). Review the remapped item, then recalculate.`, changed: { from, to }, rowChanged: changed, rowMissing: false };
}

/** Build the immutable record from a successful calculation. */
export function toSavedCalculation(args: { id: string; caseId: string; description: string; imp: BoqImport; result: Extract<CalcResult, { ok: true }>; item: { id: string; ref: string; description: string; sheet: string; rowNumber: number }; createdAt?: string }): SavedCalculation {
  const { result, imp, item } = args;
  return {
    id: args.id,
    caseId: args.caseId,
    createdAt: args.createdAt ?? new Date().toISOString(),
    description: args.description,
    direction: result.direction,
    importId: imp.id,
    importRevision: imp.revision,
    importFileName: imp.source.fileName,
    importSha256: imp.source.sha256,
    itemId: item.id,
    itemRef: item.ref,
    itemDescription: item.description,
    sheet: item.sheet,
    rowNumber: item.rowNumber,
    rateCell: result.sources[0]?.rateCell ?? '',
    rate: result.rate,
    currency: result.currency,
    boqUnit: result.boqUnit,
    quantity: result.quantity,
    quantityUnit: result.quantityUnit,
    convertedQuantity: result.converted,
    signedAmount: result.signedAmount,
    formula: result.formula,
    conversion: result.conversion,
    reviewedAgainstImportId: null,
  };
}

/**
 * A reviewer confirms the remapped item for the selected revision. This does not recalculate and does not edit
 * the original numbers. It only allows a new calculation to be made against the new revision.
 */
export function remapTarget(calc: SavedCalculation, selected: BoqImport): { row: BoqImport['rows'][number] | null; recordId: string | null } {
  const row = findCounterpart(calc, selected);
  return { row, recordId: row ? `${selected.id}:${row.id}` : null };
}

/** Results that may be shown as current or offered for approval. Stale results are never included. */
export function approvableCalculations(calcs: SavedCalculation[], selected: BoqImport | null, allImports: BoqImport[]): SavedCalculation[] {
  return calcs.filter((c) => staleness(c, selected, allImports).status === 'current');
}

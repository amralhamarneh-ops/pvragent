import { cleanNumberText } from './readers';
import { interpretSheet, emptyColumns } from './interpret';
import { canonUnit, unitInfo } from './units';
import type { ColumnMap, MappedField, ParsedRow, RawCell, RawSheet, SheetMapping } from './types';
import { MAPPED_FIELDS } from './types';

/**
 * Automatic BOQ structure interpretation.
 *
 * Deterministic: reads actual cell values, scores header rows and columns from header wording AND from the data
 * underneath (units that are real units, numeric quantity/rate columns, long text description columns), then
 * validates the inferred structure against the actual rows. Nothing is invented: a column that cannot be justified
 * is left unmapped, and a genuine tie is reported as an ambiguity for a targeted question.
 */

const HEADER_HINTS: Record<MappedField, RegExp[]> = {
  ref: [/^(item\s*(no|ref|number|code)?|ref(erence)?|boq\s*(ref|no|item)?|no\.?|code|clause|s\/?n|sr\.?\s*no\.?|serial)$/i],
  description: [/^(description|desc\.?|item\s*description|description\s+of\s+(work|item)s?|work\s*item|particulars|details?|scope|work)$/i],
  unit: [/^(unit|uom|u\/m|units|unit\s*of\s*measure(ment)?)$/i],
  quantity: [/^(qty\.?|quantity|quantities|qnty|boq\s*qty|contract\s*qty)$/i],
  rate: [/^(rate|unit\s*rate|price|unit\s*price|rate\s*\(.*\)|contract\s*rate|boq\s*rate)$/i, /rate|price/i],
  amount: [/^(amount|total|value|extension|sum|amount\s*\(.*\)|total\s*amount|line\s*total)$/i, /amount|total/i],
};

function norm(s: string): string { return s.replace(/\s+/g, ' ').trim(); }

export interface ColumnAmbiguity {
  sheet: string;
  field: MappedField;
  /** Zero-based column indexes that all plausibly hold this field. */
  candidates: { index: number; letter: string; header: string; sample: string[] }[];
  message: string;
}

export interface SheetInterpretation {
  sheet: string;
  mapping: SheetMapping;
  /** Why the sheet was included or skipped, in plain words. */
  reason: string;
  ambiguities: ColumnAmbiguity[];
  /** Header row text, for the highlighted source preview. */
  headerPreview: { rowNumber: number; cells: { address: string; text: string }[] } | null;
  validation: SheetValidation;
}

export interface SheetValidation {
  itemRows: number;
  unitsRecognised: number;
  unitsUnrecognised: string[];
  numericRateRows: number;
  amountMismatchRows: number;
  ok: boolean;
  notes: string[];
}

function letter(i: number): string {
  let n = i + 1; let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function colStats(rows: RawSheet['rows'], after: number, idx: number) {
  let nonBlank = 0; let numeric = 0; let unitLike = 0; let longText = 0; let refLike = 0; let total = 0;
  for (const r of rows) {
    if (r.rowNumber <= after) continue;
    const c: RawCell | undefined = r.cells[idx];
    if (!c || c.blank) continue;
    total += 1; nonBlank += 1;
    if (c.numeric || cleanNumberText(c.text) !== null) numeric += 1;
    const t = norm(c.text);
    if (t.length <= 8 && unitInfo(t)) unitLike += 1;
    if (t.length >= 18 && /[a-z]/i.test(t) && cleanNumberText(t) === null) longText += 1;
    if (t.length <= 24 && /\d/.test(t) && /[a-z0-9]/i.test(t) && /^[a-z0-9][a-z0-9.\-/ ]*$/i.test(t) && cleanNumberText(t) === null) refLike += 1;
  }
  return { nonBlank, numeric, unitLike, longText, refLike, total };
}

interface HeaderCandidate { rowNumber: number; score: number; byField: Partial<Record<MappedField, number[]>> }

function headerCandidate(row: RawSheet['rows'][number]): HeaderCandidate {
  const byField: Partial<Record<MappedField, number[]>> = {};
  let score = 0;
  row.cells.forEach((c, idx) => {
    const t = norm(c.text);
    if (!t || t.length > 40) return;
    for (const f of MAPPED_FIELDS) {
      const hints = HEADER_HINTS[f];
      const strong = hints[0].test(t);
      const weak = !strong && hints.slice(1).some((h) => h.test(t));
      if (strong || weak) {
        (byField[f] ??= []).push(idx);
        score += strong ? 1 : 0.5;
        break;
      }
    }
  });
  return { rowNumber: row.rowNumber, score, byField };
}

function sample(rows: RawSheet['rows'], after: number, idx: number, n = 3): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.rowNumber <= after) continue;
    const c = r.cells[idx];
    if (c && !c.blank) { out.push(norm(c.text).slice(0, 28)); if (out.length >= n) break; }
  }
  return out;
}

/**
 * Infer columns for one sheet. When a header names a field in several columns the data decides: the column whose
 * values fit the field best wins, and only a genuine tie becomes an ambiguity.
 */
export function interpretSheetAuto(sheet: RawSheet): SheetInterpretation {
  const emptyVal: SheetValidation = { itemRows: 0, unitsRecognised: 0, unitsUnrecognised: [], numericRateRows: 0, amountMismatchRows: 0, ok: false, notes: [] };
  let best: HeaderCandidate | null = null;
  for (const row of sheet.rows.slice(0, 60)) {
    const hc = headerCandidate(row);
    const fields = Object.keys(hc.byField).length;
    if (fields >= 3 && (!best || hc.score > best.score)) best = hc;
  }
  const columns: ColumnMap = emptyColumns();
  const ambiguities: ColumnAmbiguity[] = [];

  if (!best) {
    // Headerless sheet: infer purely from data columns.
    const dataStart = 0;
    const inferred = inferFromData(sheet, dataStart);
    if (inferred.description === null || (inferred.quantity === null && inferred.rate === null)) {
      return { sheet: sheet.name, mapping: { sheet: sheet.name, included: false, headerRow: null, columns }, reason: 'No header row and no recognisable description / quantity / rate columns, so this sheet is not treated as a priced bill.', ambiguities, headerPreview: null, validation: emptyVal };
    }
    const mapping: SheetMapping = { sheet: sheet.name, included: true, headerRow: null, columns: inferred };
    return finish(sheet, mapping, 'No header row found. Columns were inferred from the values underneath.', ambiguities, null);
  }

  for (const f of MAPPED_FIELDS) {
    const cands = best.byField[f] ?? [];
    if (cands.length === 1) { columns[f] = cands[0]; continue; }
    if (cands.length === 0) continue;
    // Several columns carry this header: let the data decide.
    const scored = cands.map((idx) => ({ idx, s: fieldFit(f, colStats(sheet.rows, best!.rowNumber, idx)) })).sort((a, b) => b.s - a.s);
    if (scored[0].s > 0 && (scored.length === 1 || scored[0].s - scored[1].s >= 0.15)) { columns[f] = scored[0].idx; continue; }
    // Genuine tie.
    columns[f] = scored[0].idx;
    ambiguities.push({
      sheet: sheet.name,
      field: f,
      candidates: scored.map((c) => ({ index: c.idx, letter: letter(c.idx), header: norm(sheet.rows.find((r) => r.rowNumber === best!.rowNumber)?.cells[c.idx]?.text ?? ''), sample: sample(sheet.rows, best!.rowNumber, c.idx) })),
      message: `These columns may all contain the ${f === 'rate' ? 'applicable rate' : f}. Which should be used?`,
    });
  }

  // Fill fields the header did not name, using the data.
  const fromData = inferFromData(sheet, best.rowNumber, columns);
  for (const f of MAPPED_FIELDS) if (columns[f] === null && fromData[f] !== null) columns[f] = fromData[f];

  const hRow = sheet.rows.find((r) => r.rowNumber === best!.rowNumber) ?? null;
  const mapping: SheetMapping = { sheet: sheet.name, included: true, headerRow: best.rowNumber, columns };
  return finish(sheet, mapping, `Header row ${best.rowNumber} recognised.`, ambiguities, hRow ? { rowNumber: hRow.rowNumber, cells: hRow.cells.map((c) => ({ address: c.address, text: c.text })) } : null);
}

function fieldFit(f: MappedField, s: ReturnType<typeof colStats>): number {
  if (s.nonBlank === 0) return 0;
  let n = s.nonBlank;
  switch (f) {
    case 'ref': return s.refLike / n;
    case 'description': return s.longText / n;
    case 'unit': return s.unitLike / n;
    case 'quantity': case'rate': case'amount': return (s.numeric / n) * Math.min(1, n / 4);
  }
}

/** Data-driven inference of fields not named by a header (or of all fields on a headerless sheet). */
function inferFromData(sheet: RawSheet, after: number, known?: ColumnMap): ColumnMap {
  const out: ColumnMap = known ? { ...known } : emptyColumns();
  const used = new Set<number>(MAPPED_FIELDS.map((f) => out[f]).filter((v): v is number => v !== null));
  const stats = Array.from({ length: sheet.columnCount }, (_, i) => ({ i, s: colStats(sheet.rows, after, i) }));
  const pick = (f: MappedField, test: (s: ReturnType<typeof colStats>) => number, min: number) => {
    if (out[f] !== null) return;
    const ranked = stats.filter((c) => !used.has(c.i)).map((c) => ({ i: c.i, v: test(c.s) })).filter((c) => c.v >= min).sort((a, b) => b.v - a.v);
    if (ranked[0]) { out[f] = ranked[0].i; used.add(ranked[0].i); }
  };
  pick('unit', (s) => (s.nonBlank ? s.unitLike / s.nonBlank : 0), 0.5);
  pick('description', (s) => (s.nonBlank ? s.longText / s.nonBlank : 0), 0.4);
  pick('ref', (s) => (s.nonBlank ? s.refLike / s.nonBlank : 0), 0.5);
  return out;
}

/** Validate the inferred structure against the actual rows and units. */
function validate(sheet: RawSheet, mapping: SheetMapping): { rows: ParsedRow[]; v: SheetValidation } {
  const res = interpretSheet(sheet, mapping);
  const items = res.rows.filter((r) => r.rowClass === 'item' || r.rowClass === 'unpriced_item');
  const bad = new Set<string>();
  let recognised = 0; let numericRate = 0; let mismatch = 0;
  for (const r of items) {
    if (r.unit && unitInfo(r.unit)) recognised += 1; else if (r.unit) bad.add(r.unit);
    if (r.rate.state === 'value') numericRate += 1;
    if (r.issues.some((x) => x.startsWith('Amount '))) mismatch += 1;
  }
  const notes: string[] = [];
  if (items.length === 0) notes.push('No item rows were found under the inferred header.');
  if (items.length > 0 && recognised / items.length < 0.5) notes.push(`Only ${recognised} of ${items.length} item units are recognised units, so the unit column may be wrong.`);
  if (items.length > 0 && mapping.columns.rate !== null && numericRate === 0) notes.push('No numeric rates were read from the rate column.');
  if (mismatch > 0) notes.push(`${mismatch} row(s) have an amount that does not equal quantity × rate.`);
  const ok = items.length > 0 && recognised / items.length >= 0.5 && (mapping.columns.rate === null || numericRate > 0 || items.some((r) => r.rate.state === 'missing'));
  return { rows: res.rows, v: { itemRows: items.length, unitsRecognised: recognised, unitsUnrecognised: Array.from(bad).slice(0, 8), numericRateRows: numericRate, amountMismatchRows: mismatch, ok, notes } };
}

function finish(sheet: RawSheet, mapping: SheetMapping, reason: string, ambiguities: ColumnAmbiguity[], headerPreview: SheetInterpretation['headerPreview']): SheetInterpretation {
  const { v } = validate(sheet, mapping);
  if (!v.ok && v.itemRows === 0) {
    return { sheet: sheet.name, mapping: { ...mapping, included: false }, reason: `${reason} But no priced item rows were found, so the sheet was skipped.`, ambiguities, headerPreview, validation: v };
  }
  return { sheet: sheet.name, mapping, reason, ambiguities, headerPreview, validation: v };
}

export interface WorkbookInterpretation {
  sheets: SheetInterpretation[];
  mappings: SheetMapping[];
  ambiguities: ColumnAmbiguity[];
  /** True when every included sheet validated and nothing is ambiguous: no question needs to be asked. */
  clear: boolean;
}

export function interpretWorkbookAuto(sheets: RawSheet[]): WorkbookInterpretation {
  const list = sheets.map(interpretSheetAuto);
  const ambiguities = list.flatMap((s) => s.ambiguities);
  const included = list.filter((s) => s.mapping.included);
  return {
    sheets: list,
    mappings: list.map((s) => s.mapping),
    ambiguities,
    clear: included.length > 0 && ambiguities.length === 0 && included.every((s) => s.validation.ok),
  };
}

/** Apply a user's answer to a column ambiguity. Returns updated mappings. */
export function applyAmbiguityChoice(mappings: SheetMapping[], sheet: string, field: MappedField, columnIndex: number): SheetMapping[] {
  return mappings.map((m) => (m.sheet === sheet ? { ...m, columns: { ...m.columns, [field]: columnIndex } } : m));
}

export { canonUnit };

import { cleanNumberText } from './readers';
import type { ColumnMap, MappedField, ParsedRow, QuantityValue, RateValue, RawCell, RawSheet, RowClass, SheetMapping } from './types';
import { MAPPED_FIELDS } from './types';

const HEADER_WORDS: Record<MappedField, RegExp> = {
  ref: /^(item\s*(no|ref|number)?|ref(erence)?|boq\s*(ref|no)?|no\.?|code|clause|item)$/i,
  description: /^(description|desc\.?|item\s*description|work\s*item|particulars|details?)$/i,
  unit: /^(unit|uom|u\/m|units)$/i,
  quantity: /^(qty\.?|quantity|quantities|qnty)$/i,
  rate: /^(rate|unit\s*rate|price|unit\s*price|rate\s*\(.*\))$/i,
  amount: /^(amount|total|value|extension|sum|amount\s*\(.*\))$/i,
};

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function emptyColumns(): ColumnMap {
  return { ref: null, description: null, unit: null, quantity: null, rate: null, amount: null };
}

/** Score how header-like a row is: number of distinct fields it names. */
function headerScore(cells: RawCell[]): { score: number; columns: ColumnMap } {
  const columns = emptyColumns();
  let score = 0;
  cells.forEach((c, idx) => {
    const t = norm(c.text);
    if (!t) return;
    for (const f of MAPPED_FIELDS) {
      if (columns[f] === null && HEADER_WORDS[f].test(t)) {
        columns[f] = idx;
        score += 1;
        break;
      }
    }
  });
  return { score, columns };
}

/** Suggest header row and columns for one sheet. The user can override every choice. */
export function suggestSheetMapping(sheet: RawSheet): SheetMapping {
  let best: { rowNumber: number; score: number; columns: ColumnMap } | null = null;
  for (const row of sheet.rows.slice(0, 40)) {
    const { score, columns } = headerScore(row.cells);
    if (score >= 3 && (!best || score > best.score)) best = { rowNumber: row.rowNumber, score, columns };
  }
  return {
    sheet: sheet.name,
    included: best !== null,
    headerRow: best ? best.rowNumber : null,
    columns: best ? best.columns : emptyColumns(),
  };
}

function isHeadingRow(cells: RawCell[], columns: ColumnMap): boolean {
  let hits = 0;
  for (const f of MAPPED_FIELDS) {
    const idx = columns[f];
    if (idx === null) continue;
    const t = norm(cells[idx]?.text ?? '');
    if (t && HEADER_WORDS[f].test(t)) hits += 1;
  }
  return hits >= 3;
}

const SUBTOTAL_RE = /\b(sub[\s-]?total|total|carried\s+(forward|to)|brought\s+forward|c\/f|b\/f|grand\s+total|summary|collection)\b/i;
const BILL_RE = /^\s*(bill|section|part|trade|elemental)\s*(no\.?|number)?\s*[\w.-]*\b/i;

function readQuantity(cells: RawCell[], idx: number | null): QuantityValue {
  if (idx === null) return { state: 'missing', text: '' };
  const c = cells[idx];
  if (!c || c.blank) return { state: 'missing', text: '', cell: c?.address };
  if (c.formulaStatus === 'no_cached_value' || c.formulaStatus === 'error') return { state: 'invalid', text: c.text, cell: c.address };
  const num = c.numeric ? c.numberText ?? cleanNumberText(c.text) : cleanNumberText(c.text);
  if (num === null) return { state: 'invalid', text: c.text, cell: c.address };
  return { state: 'value', text: c.text, value: num, cell: c.address };
}

function readRate(cells: RawCell[], idx: number | null, fallbackAddress: string): RateValue {
  if (idx === null) return { state: 'missing', text: '', cell: fallbackAddress, formulaStatus: 'none' };
  const c = cells[idx];
  if (!c) return { state: 'missing', text: '', cell: fallbackAddress, formulaStatus: 'none' };
  if (c.formulaStatus === 'no_cached_value') {
    return { state: 'invalid', text: '', cell: c.address, formula: c.formula, formulaStatus: 'no_cached_value' };
  }
  if (c.formulaStatus === 'error') {
    return { state: 'invalid', text: c.text, cell: c.address, formula: c.formula, formulaStatus: 'error' };
  }
  if (c.blank) return { state: 'missing', text: '', cell: c.address, formulaStatus: 'none' };
  const num = c.numeric ? c.numberText ?? cleanNumberText(c.text) : cleanNumberText(c.text);
  if (num === null) return { state: 'invalid', text: c.text, cell: c.address, formula: c.formula, formulaStatus: c.formulaStatus };
  const isZero = /^[+-]?0*\.?0*$/.test(num) && !/[1-9]/.test(num);
  return { state: 'value', text: c.text, value: num, explicitZero: isZero, cell: c.address, formula: c.formula, formulaStatus: c.formulaStatus };
}

export interface InterpretResult {
  rows: ParsedRow[];
  warnings: string[];
}

/**
 * Interpret the rows of one sheet using the chosen mapping. Every row in the data region is classified and
 * kept (with its original row number) so the reviewer can see what was treated as priced and what was not.
 */
export function interpretSheet(sheet: RawSheet, mapping: SheetMapping): InterpretResult {
  const rows: ParsedRow[] = [];
  const warnings: string[] = [];
  if (!mapping.included) return { rows, warnings };
  const { columns } = mapping;
  if (columns.description === null && columns.ref === null) {
    warnings.push(`${sheet.name}: map at least a reference or a description column.`);
    return { rows, warnings };
  }
  let bill = sheet.name;
  const start = mapping.headerRow ?? 0;
  for (const r of sheet.rows) {
    if (r.rowNumber <= start) continue;
    const cells = r.cells;
    const get = (f: MappedField): string => {
      const i = columns[f];
      return i === null ? '' : norm(cells[i]?.text ?? '');
    };
    const allBlank = cells.every((c) => c.blank);
    const addr = (f: MappedField): string | undefined => {
      const i = columns[f];
      return i === null ? undefined : cells[i]?.address;
    };
    const cellMap: Partial<Record<MappedField, string>> = {};
    for (const f of MAPPED_FIELDS) { const a = addr(f); if (a) cellMap[f] = a; }

    const ref = get('ref');
    const description = get('description');
    const unit = get('unit');
    const quantity = readQuantity(cells, columns.quantity);
    const rate = readRate(cells, columns.rate, '');
    const amountCell = columns.amount === null ? undefined : cells[columns.amount];
    const amountNum = amountCell && !amountCell.blank ? (amountCell.numeric ? amountCell.numberText : cleanNumberText(amountCell.text)) : null;

    let rowClass: RowClass;
    let reason: string;
    const issues: string[] = [];

    if (allBlank) { rowClass = 'blank'; reason = 'Row is empty.'; }
    else if (isHeadingRow(cells, columns)) { rowClass = 'repeated_heading'; reason = 'Repeats the column headings.'; }
    else if (SUBTOTAL_RE.test(`${ref} ${description}`) && (unit === '' || quantity.state === 'missing') ) { rowClass = 'subtotal'; reason = 'Looks like a subtotal, carry-forward or summary line.'; }
    else if (BILL_RE.test(description || ref) && unit === '' && quantity.state === 'missing' && rate.state === 'missing') {
      rowClass = 'bill_heading'; reason = 'Looks like a bill or section heading.'; bill = description || ref || bill;
    }
    else if (unit === '' && quantity.state === 'missing' && rate.state === 'missing' && (ref !== '' || description !== '')) {
      rowClass = description.length > 0 && ref === '' ? 'title' : 'note'; reason = 'Has no unit, quantity or rate, so it is a heading or note, not a priced item.';
      if (rowClass === 'title' && description.length < 80) bill = bill;
    }
    else {
      const hasPricingInfo = unit !== '' || quantity.state !== 'missing' || rate.state !== 'missing';
      if (!hasPricingInfo) { rowClass = 'note'; reason = 'No unit, quantity or rate.'; }
      else if (rate.state === 'missing' || (rate.state === 'invalid')) {
        rowClass = 'unpriced_item';
        reason = rate.state === 'missing' ? 'Item has no rate. Left unpriced; not treated as zero.' : rate.formulaStatus === 'no_cached_value' ? 'Rate is a formula with no stored result. Not recalculated.' : rate.formulaStatus === 'error' ? 'Rate formula result is an error.' : 'Rate is not a number.';
      }
      else { rowClass = 'item'; reason = rate.explicitZero ? 'Priced item with an explicit rate of 0.' : 'Priced item.'; }
    }

    if (rowClass === 'item' || rowClass === 'unpriced_item') {
      if (unit === '') issues.push('No unit.');
      if (ref === '') issues.push('No BOQ reference.');
      if (rate.formulaStatus === 'cached') issues.push('Rate is a formula; the cached value from the file is used, not recalculated.');
      if (rate.explicitZero) issues.push('Rate is an explicit zero.');
      if (rate.state === 'value' && quantity.state === 'value' && amountNum !== null && !amountCell?.formula) {
        // Cross-check only when the amount is a literal number: quantity x rate should reproduce it within rounding.
        try {
          const q = Number(quantity.value);
          const rt = Number(rate.value);
          const am = Number(amountNum);
          if (Number.isFinite(q * rt) && Math.abs(q * rt - am) > Math.max(0.01 * Math.abs(am), 0.5)) issues.push(`Amount ${amountNum} differs from quantity x rate (${(q * rt).toFixed(2)}).`);
        } catch { /* ignore */ }
      }
    }

    rows.push({
      id: `${sheet.name}!${r.rowNumber}`,
      sheet: sheet.name,
      rowNumber: r.rowNumber,
      rowClass,
      classReason: reason,
      bill,
      ref,
      description,
      unit,
      quantity,
      rate,
      amount: { text: amountCell?.text ?? '', value: amountNum ?? undefined, cell: amountCell?.address },
      cells: cellMap,
      included: rowClass === 'item' || rowClass === 'unpriced_item',
      issues,
    });
  }
  return { rows, warnings };
}

export function interpretWorkbook(sheets: RawSheet[], mappings: SheetMapping[]): InterpretResult {
  const rows: ParsedRow[] = [];
  const warnings: string[] = [];
  for (const m of mappings) {
    const sheet = sheets.find((s) => s.name === m.sheet);
    if (!sheet) continue;
    const res = interpretSheet(sheet, m);
    rows.push(...res.rows);
    warnings.push(...res.warnings);
  }
  return { rows, warnings };
}

export function rowIsPriced(r: ParsedRow): boolean {
  return r.rowClass === 'item' && r.rate.state === 'value';
}

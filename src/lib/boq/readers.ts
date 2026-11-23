import type { FormulaStatus, RawCell, RawSheet, RawWorkbook } from './types';

/** Convert a zero-based column index to letters (0 -> A, 26 -> AA). */
export function colLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer so the digest input is a plain ArrayBuffer.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** RFC-4180 style CSV reader over the whole text. Handles quotes, escaped quotes, CRLF and embedded newlines. */
export function parseCsvText(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const delim = delimiter ?? detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === delim) { row.push(field); field = ''; i += 1; continue; }
    if (ch === '\r') { i += 1; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += ch; i += 1;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function detectDelimiter(text: string): string {
  const firstLines = text.split(/\r?\n/).slice(0, 10).join('\n');
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQ = false;
  for (const ch of firstLines) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch] += 1;
  }
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ',') || ',';
}

const NUM_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Parse a number from text as exported by a spreadsheet. Returns null if it is not clearly a number. */
export function cleanNumberText(text: string): string | null {
  let t = text.trim();
  if (t === '') return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1).trim(); }
  t = t.replace(/^(AED|USD|EUR|GBP|SAR|Dhs?\.?)\s*/i, '').replace(/\s*(AED|USD|EUR|GBP|SAR)$/i, '');
  t = t.replace(/[\s,\u00A0]/g, '');
  if (t.startsWith('-')) { neg = !neg; t = t.slice(1); }
  if (t.startsWith('+')) t = t.slice(1);
  if (!NUM_RE.test(t)) return null;
  return (neg ? '-' : '') + t;
}

export function csvToRawSheet(name: string, grid: string[][]): RawSheet {
  let columnCount = 0;
  const rows = grid.map((r, idx) => {
    columnCount = Math.max(columnCount, r.length);
    const cells: RawCell[] = r.map((value, c) => {
      const blank = value.trim() === '';
      const num = blank ? null : cleanNumberText(value);
      return { address: `${colLetter(c)}${idx + 1}`, text: value, blank, numeric: num !== null, numberText: num ?? undefined, formulaStatus: 'none' as FormulaStatus };
    });
    return { rowNumber: idx + 1, cells };
  });
  return { name, rows, columnCount };
}

export async function readCsv(fileName: string, bytes: Uint8Array): Promise<RawWorkbook> {
  const sha256 = await sha256Hex(bytes);
  const text = new TextDecoder('utf-8').decode(bytes);
  const grid = parseCsvText(text);
  const warnings: string[] = [];
  if (grid.length === 0) warnings.push('The CSV file contains no rows.');
  return { fileName, sha256, sizeBytes: bytes.byteLength, format: 'csv', sheets: [csvToRawSheet('CSV', grid)], warnings };
}

interface ExcelCellLike {
  value: unknown;
  type: number;
  text?: string;
  address: string;
}

function numToText(n: number): string {
  if (Number.isInteger(n)) return String(n);
  // Use the shortest round-trip representation, never exponent form for ordinary magnitudes.
  let s = String(n);
  return /e/i.test(s) ? n.toFixed(12).replace(/0+$/, '').replace(/\.$/, '') : s;
}

function cellToRaw(cell: ExcelCellLike, warnings: string[], sheet: string): RawCell {
  const v = cell.value as unknown;
  const address = cell.address;
  if (v === null || v === undefined || v === '') {
    return { address, text: '', blank: true, numeric: false, formulaStatus: 'none' };
  }
  if (typeof v === 'number') return { address, text: numToText(v), blank: false, numeric: true, numberText: numToText(v), formulaStatus: 'none' };
  if (typeof v === 'string') {
    const num = cleanNumberText(v);
    return { address, text: v, blank: v.trim() === '', numeric: num !== null && v.trim() !== '', numberText: num ?? undefined, formulaStatus: 'none' };
  }
  if (typeof v === 'boolean') return { address, text: v ? 'TRUE' : 'FALSE', blank: false, numeric: false, formulaStatus: 'none' };
  if (v instanceof Date) return { address, text: v.toISOString().slice(0, 10), blank: false, numeric: false, formulaStatus: 'none' };
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('formula' in o || 'sharedFormula' in o) {
      const formula = String(o.formula ?? o.sharedFormula ?? '');
      const result = o.result as unknown;
      if (result === undefined || result === null) {
        warnings.push(`${sheet}!${address}: formula "${formula}" has no cached value in the file. It was not recalculated.`);
        return { address, text: '', blank: false, numeric: false, formula, formulaStatus: 'no_cached_value' };
      }
      if (typeof result === 'object' && result !== null && 'error' in (result as Record<string, unknown>)) {
        const err = String((result as Record<string, unknown>).error);
        warnings.push(`${sheet}!${address}: formula "${formula}" cached result is an error (${err}).`);
        return { address, text: err, blank: false, numeric: false, formula, formulaStatus: 'error' };
      }
      if (typeof result === 'number') return { address, text: numToText(result), blank: false, numeric: true, numberText: numToText(result), formula, formulaStatus: 'cached' };
      const rt = String(result);
      const num = cleanNumberText(rt);
      return { address, text: rt, blank: rt.trim() === '', numeric: num !== null, numberText: num ?? undefined, formula, formulaStatus: 'cached' };
    }
    if ('richText' in o && Array.isArray(o.richText)) {
      let t = (o.richText as { text?: string }[]).map((r) => r.text ?? '').join('');
      const num = cleanNumberText(t);
      return { address, text: t, blank: t.trim() === '', numeric: num !== null, numberText: num ?? undefined, formulaStatus: 'none' };
    }
    if ('text' in o && typeof o.text === 'string') return { address, text: o.text, blank: false, numeric: false, formulaStatus: 'none' };
    if ('error' in o) return { address, text: String(o.error), blank: false, numeric: false, formulaStatus: 'none' };
  }
  return { address, text: String(v), blank: false, numeric: false, formulaStatus: 'none' };
}

export async function readXlsx(fileName: string, bytes: Uint8Array): Promise<RawWorkbook> {
  const sha256 = await sha256Hex(bytes);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  await wb.xlsx.load(copy.buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const warnings: string[] = [];
  const sheets: RawSheet[] = [];
  wb.eachSheet((ws) => {
    const rows: RawSheet['rows'] = [];
    let columnCount = 0;
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const cells: RawCell[] = [];
      const max = Math.max(row.cellCount, ws.columnCount);
      for (let c = 1; c <= max; c += 1) {
        const cell = row.getCell(c) as unknown as ExcelCellLike;
        cells.push(cellToRaw({ value: cell.value, type: cell.type, address: `${colLetter(c - 1)}${rowNumber}` }, warnings, ws.name));
      }
      columnCount = Math.max(columnCount, cells.length);
      rows.push({ rowNumber, cells });
    });
    sheets.push({ name: ws.name, rows, columnCount });
  });
  if (sheets.length === 0) warnings.push('The workbook contains no sheets.');
  return { fileName, sha256, sizeBytes: bytes.byteLength, format: 'xlsx', sheets, warnings };
}

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export async function readWorkbook(fileName: string, bytes: Uint8Array): Promise<RawWorkbook> {
  if (bytes.byteLength === 0) throw new Error('The file is empty.');
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error(`The file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`);
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) return readCsv(fileName, bytes);
  if (lower.endsWith('.xlsx')) {
    // XLSX files are ZIP archives and start with "PK".
    if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new Error('This file is named .xlsx but is not a valid XLSX (ZIP) file.');
    return readXlsx(fileName, bytes);
  }
  if (lower.endsWith('.xls')) throw new Error('Legacy .xls files are not supported. Save the workbook as .xlsx or .csv and upload again.');
  throw new Error('Unsupported file type. Upload an .xlsx or .csv BOQ.');
}

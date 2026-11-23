import type { ParsedRow } from './types';

/**
 * Context enrichment for parsed BOQ rows.
 *
 * - Continuation lines: a row with a description but no ref, unit, quantity or rate directly below an item is a
 *   continuation of that item's description (merged-cell / wrapped text). It is appended to the item, never priced
 *   on its own.
 * - Preambles and measurement rules: unpriced text rows under a bill/section heading are collected as that bill's
 *   preamble and attached to every item in the bill as context. They are text only; they never carry a rate.
 * - Trade / package: taken from the nearest heading above the item.
 */

export interface RowContext {
  rowId: string;
  /** Description including any continuation lines. */
  fullDescription: string;
  /** Nearest section / trade heading text. */
  section: string;
  /** Measurement rules / preamble text for the bill. */
  preamble: string;
  continuationRows: number[];
}

const PREAMBLE_RE = /\b(measure[d]?|measurement|deemed|included|inclusive|excluding|unless|shall|rate[s]? to include|note[s]?|preamble|general)\b/i;

export function buildRowContext(rows: ParsedRow[]): Map<string, RowContext> {
  const out = new Map<string, RowContext>();
  let section = '';
  let currentBill = '';
  let preamble: string[] = [];
  let last: { id: string; text: string; cont: number[] } | null = null;
  const preambleByBill = new Map<string, string[]>();

  const flushLast = () => {
    if (!last) return;
    const prev = out.get(last.id);
    if (prev) out.set(last.id, { ...prev, fullDescription: last.text, continuationRows: last.cont });
    last = null;
  };

  for (const r of rows) {
    if (r.bill !== currentBill) { flushLast(); currentBill = r.bill; preamble = preambleByBill.get(currentBill) ?? []; preambleByBill.set(currentBill, preamble); }
    if (r.rowClass === 'bill_heading' || r.rowClass === 'title') { flushLast(); section = r.description || r.ref || section; continue; }
    if (r.rowClass === 'item' || r.rowClass === 'unpriced_item') {
      flushLast();
      out.set(r.id, { rowId: r.id, fullDescription: r.description, section, preamble: '', continuationRows: [] });
      last = { id: r.id, text: r.description, cont: [] };
      continue;
    }
    if (r.rowClass === 'note') {
      const text = r.description || r.ref;
      if (!text) continue;
      // A wrapped description line directly under an item continues that item.
      if (last && r.ref === '' && !PREAMBLE_RE.test(text) && text.length < 160) { last.text = `${last.text} ${text}`.trim(); last.cont.push(r.rowNumber); continue; }
      preamble.push(text);
      continue;
    }
    if (r.rowClass === 'blank') flushLast();
  }
  flushLast();
  // Attach the bill preamble to each item of that bill.
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const [id, ctx] of out) {
    const row = byId.get(id);
    if (!row) continue;
    const p = (preambleByBill.get(row.bill) ?? []).join(' ').slice(0, 600);
    out.set(id, { ...ctx, preamble: p });
  }
  return out;
}

import { classifyDates } from './dates';
import type { TitleBlock } from './types';

const NUM_LABEL = /(?:DWG\.?\s*(?:NO|NUMBER|#)|DRAWING\s*(?:NO|NUMBER|#)|DRG\.?\s*NO|SHEET\s*NO)\s*[.:=\-]?\s*([A-Z0-9][A-Z0-9\-_./]{2,40})/i;
const REV_LABEL = /(?:\bREV(?:ISION)?\.?\s*[:=\-]?\s*)([A-Z]{1,2}\d{0,2}|\d{1,2})\b/i;
const TITLE_LABEL = /(?:DWG\.?\s*TITLE|DRAWING\s*TITLE|TITLE)\s*[:=\-]\s*([^\n\r]{3,100})/i;

/** Drawing number pattern used only as a fallback: letters/digits with dashes, containing at least one digit. */
const NUM_SHAPE = /\b([A-Z]{1,6}[-_][A-Z0-9]{1,8}(?:[-_][A-Z0-9]{1,8}){0,3})\b/;

function fromFileName(name: string): { number: string; rev: string } {
  const base = name.replace(/\.[^.]+$/, '');
  const rev = (base.match(/[-_ ]rev[-_ ]?([a-z0-9]{1,3})\b/i) ?? [])[1] ?? '';
  const withoutRev = base.replace(/[-_ ]rev[-_ ]?[a-z0-9]{1,3}\b/i, '');
  const num = (withoutRev.match(NUM_SHAPE) ?? [])[1] ?? '';
  return { number: /\d/.test(num) ? num : '', rev: rev.toUpperCase() };
}

/**
 * Read drawing number, revision, title and dates from the drawing's own text first, and the file name only as a
 * labelled fallback. Nothing is invented: an unfound field stays empty so the UI can ask.
 */
export function extractTitleBlock(fileName: string, texts: string[]): TitleBlock {
  const joined = texts.join('\n');
  const prov = { drawingNumber: '', revision: '', title: '' };
  let drawingNumber = ''; let revision = ''; let title = '';

  const n = joined.match(NUM_LABEL);
  if (n) { drawingNumber = n[1].replace(/[.,;]+$/, ''); prov.drawingNumber = `Drawing text “${n[0].trim().slice(0, 60)}”`; }
  const r = joined.match(REV_LABEL);
  if (r) { revision = r[1].toUpperCase(); prov.revision = `Drawing text “${r[0].trim().slice(0, 40)}”`; }
  const t = joined.match(TITLE_LABEL);
  if (t) { title = t[1].trim(); prov.title = `Drawing text “${t[0].trim().slice(0, 70)}”`; }

  const fn = fromFileName(fileName);
  if (!drawingNumber && fn.number) { drawingNumber = fn.number; prov.drawingNumber = 'File name (not found in the drawing text)'; }
  if (!revision && fn.rev) { revision = fn.rev; prov.revision = 'File name (not found in the drawing text)'; }

  const dates = classifyDates(joined, { source: fileName, documentKind: 'drawing' });
  return { drawingNumber, revision, title, dates, provenance: prov };
}

/** Compare revision labels. Returns 1 when a is later than b, -1 when earlier, 0 when equal, null when not comparable. */
export function compareRevisions(a: string, b: string): 1 | -1 | 0 | null {
  const x = a.trim().toUpperCase(); const y = b.trim().toUpperCase();
  if (!x || !y) return null;
  if (x === y) return 0;
  const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : null);
  const nx = num(x); const ny = num(y);
  if (nx !== null && ny !== null) return nx > ny ? 1 : -1;
  if (/^[A-Z]{1,2}$/.test(x) && /^[A-Z]{1,2}$/.test(y)) {
    const v = (s: string) => s.split('').reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0);
    return v(x) > v(y) ? 1 : -1;
  }
  const m = (s: string) => s.match(/^([A-Z]+)(\d+)$/);
  const mx = m(x); const my = m(y);
  if (mx && my && mx[1] === my[1]) return Number(mx[2]) > Number(my[2]) ? 1 : -1;
  return null;
}

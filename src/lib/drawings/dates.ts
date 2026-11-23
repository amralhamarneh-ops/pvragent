import type { DateMeaning, FoundDate } from './types';

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function pad(n: number): string { return String(n).padStart(2, '0'); }

function validIso(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

interface RawDate { iso: string; raw: string; index: number; ambiguous: boolean }

/**
 * Find calendar dates in text. Numeric dd/mm/yyyy vs mm/dd/yyyy is ambiguous when both parts are 12 or below;
 * those are returned flagged and the day-first reading is not silently assumed to be the only one.
 */
export function findRawDates(text: string): RawDate[] {
  const out: RawDate[] = [];
  const seen = new Set<string>();
  const push = (r: RawDate) => { const k = `${r.index}:${r.iso}`; if (!seen.has(k)) { seen.add(k); out.push(r); } };

  // 20 Oct 2026, 20th October 2026
  for (const m of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]+([A-Za-z]{3,9})\.?[\s\-/.,]+(\d{4})\b/g)) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (!mon) continue;
    const iso = validIso(Number(m[3]), mon, Number(m[1]));
    if (iso) push({ iso, raw: m[0], index: m.index ?? 0, ambiguous: false });
  }
  // October 20, 2026
  for (const m of text.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g)) {
    const mon = MONTHS[m[1].toLowerCase()];
    if (!mon) continue;
    const iso = validIso(Number(m[3]), mon, Number(m[2]));
    if (iso) push({ iso, raw: m[0], index: m.index ?? 0, ambiguous: false });
  }
  // 2026-10-20
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const iso = validIso(Number(m[1]), Number(m[2]), Number(m[3]));
    if (iso) push({ iso, raw: m[0], index: m.index ?? 0, ambiguous: false });
  }
  // 20/10/2026 or 20.10.2026
  for (const m of text.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/g)) {
    const a = Number(m[1]); const b = Number(m[2]); const y = Number(m[3]);
    const dayFirst = validIso(y, b, a);
    const monthFirst = validIso(y, a, b);
    if (a <= 12 && b <= 12 && a !== b && dayFirst && monthFirst) push({ iso: dayFirst, raw: m[0], index: m.index ?? 0, ambiguous: true });
    else if (dayFirst) push({ iso: dayFirst, raw: m[0], index: m.index ?? 0, ambiguous: false });
    else if (monthFirst) push({ iso: monthFirst, raw: m[0], index: m.index ?? 0, ambiguous: false });
  }
  return out.sort((x, y) => x.index - y.index);
}

type Rule = { meaning: DateMeaning; re: RegExp };

/** Labels looked for in the words immediately before the date. Order matters: the most specific first. */
const RULES: Rule[] = [
  { meaning: 'schedule_data_date', re: /(data\s*date|status\s*date|as[- ]of\s*date|update\s*date|schedule\s*date)/i },
  { meaning: 'pvr_submission', re: /(date\s*submitted|submission\s*date|submitted\s*on|pvr\s*date|date\s*of\s*(pvr|request)|request\s*date)/i },
  { meaning: 'instruction', re: /(instruct(ed|ion)?\s*(date|on)?|variation\s*order\s*date|vo\s*date|directed\s*on|engineer'?s?\s*instruction)/i },
  { meaning: 'event_reported', re: /(event\s*date|date\s*of\s*(event|occurrence|delay)|occurred\s*on|delay\s*event|notified\s*on|notice\s*of\s*delay|event\s*occurred)/i },
  { meaning: 'drawing_revision', re: /(rev(ision)?\s*date|revised\s*(on)?|rev\s*[a-z0-9]{1,3}\s*[-:]?\s*$)/i },
  { meaning: 'drawing_issue', re: /(issue(d)?\s*(date|on|for)?|transmittal\s*date|date\s*issued|issued\s*date|sent\s*on)/i },
];

export interface ClassifyOptions {
  source: string;
  /** Hint used when no label is found: drawings default to unclassified, never to an event date. */
  documentKind: 'drawing' | 'pvr' | 'narrative' | 'schedule' | 'correspondence' | 'other';
}

/**
 * Label every date by its meaning using the words directly before it (and on the same line). A date with no
 * decisive label stays "unclassified". A drawing date is never relabelled as an event or instruction date.
 */
export function classifyDates(text: string, opts: ClassifyOptions): FoundDate[] {
  const found = findRawDates(text);
  return found.map((d, i) => {
    const lineStart = Math.max(text.lastIndexOf('\n', d.index) + 1, d.index - 60);
    // Only the words after the previous date can label this one, so one date never inherits its neighbour's label.
    const prev = i > 0 ? found[i - 1] : null;
    const prevEnd = prev ? prev.index + prev.raw.length : 0;
    const from = Math.max(lineStart, prevEnd);
    const before = text.slice(from, d.index);
    const after = text.slice(d.index + d.raw.length, d.index + d.raw.length + 20);
    const context = `${text.slice(lineStart, d.index)}${d.raw}${after}`.replace(/\s+/g, ' ').trim().slice(0, 140);
    let meaning: DateMeaning = 'unclassified';
    for (const r of RULES) {
      if (r.re.test(before)) { meaning = r.meaning; break; }
    }
    if (opts.documentKind === 'drawing' && (meaning === 'event_reported' || meaning === 'instruction')) {
      // A drawing's own text can mention an instruction; keep that label only when the words say so explicitly.
      if (!/(instruct|event)/i.test(before)) meaning = 'unclassified';
    }
    const note = d.ambiguous ? ' (day/month order ambiguous; read as day first)' : '';
    return { iso: d.iso, raw: d.raw, meaning, source: opts.source, context: context + note };
  });
}

/**
 * Propose the date that matters for the schedule assessment ONLY from an explicit event or instruction label.
 * Drawing revision / issue dates, submission dates and data dates are never promoted. Returns null → unresolved.
 */
export function proposeEventDate(dates: FoundDate[]): { iso: string; meaning: DateMeaning; source: string; context: string } | null {
  const event = dates.filter((d) => d.meaning === 'event_reported');
  const instr = dates.filter((d) => d.meaning === 'instruction');
  const pick = (list: FoundDate[]) => {
    const distinct = Array.from(new Set(list.map((d) => d.iso)));
    return distinct.length === 1 ? list[0] : null;
  };
  const e = pick(event);
  if (e) return { iso: e.iso, meaning: e.meaning, source: e.source, context: e.context };
  if (event.length === 0) {
    const i = pick(instr);
    if (i) return { iso: i.iso, meaning: i.meaning, source: i.source, context: i.context };
  }
  return null;
}

export function hasConflictingEventDates(dates: FoundDate[]): string[] {
  const event = Array.from(new Set(dates.filter((d) => d.meaning === 'event_reported').map((d) => d.iso)));
  return event.length > 1 ? event : [];
}

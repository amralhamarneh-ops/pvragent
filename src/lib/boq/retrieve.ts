import { canonUnit, unitInfo } from './units';
import type { RowContext } from './context';
import type { BoqItemRecord } from './types';
import type { ScopeComponent } from './scope';

/**
 * Candidate retrieval across the complete active BOQ set (all files, all bills).
 *
 * Deterministic and cheap: the model is only given the shortlist per component, never every workbook. Scoring uses
 * synonym-expanded tokens, section headings, expected-unit dimension and spec/material overlap. Different wording
 * ("blacktop" / "asphalt", "kerbstone" / "curb") can match through the synonym groups; incompatible
 * specifications are penalised, not silently accepted.
 */

const SYNONYM_GROUPS: string[][] = [
  ['asphalt', 'bituminous', 'blacktop', 'wearing', 'hma', 'macadam', 'tarmac', 'ac'],
  ['kerb', 'curb', 'kerbstone', 'curbstone', 'edging'],
  ['excavation', 'excavate', 'dig', 'digging', 'cut', 'earthwork', 'earthworks', 'trench', 'trenching'],
  ['fill', 'backfill', 'embankment', 'filling', 'compacted'],
  ['subbase', 'sub-base', 'base', 'basecourse', 'aggregate', 'crushed', 'granular'],
  ['pavement', 'carriageway', 'road', 'roadway', 'paving'],
  ['lighting', 'luminaire', 'lamp', 'streetlight', 'light', 'lantern'],
  ['drainage', 'drain', 'culvert', 'pipe', 'storm', 'stormwater', 'gully', 'manhole', 'catchpit'],
  ['concrete', 'rc', 'reinforced', 'cast', 'insitu'],
  ['reinforcement', 'rebar', 'steel', 'bar', 'bars'],
  ['formwork', 'shuttering', 'mould'],
  ['marking', 'markings', 'paint', 'thermoplastic', 'line'],
  ['signage', 'sign', 'signs'],
  ['paving', 'interlock', 'interlocking', 'tile', 'tiles'],
  ['wall', 'walling', 'masonry', 'block', 'blockwork'],
  ['door', 'doors', 'doorset'],
  ['window', 'windows', 'glazing'],
  ['cable', 'cabling', 'wiring'],
  ['duct', 'conduit'],
  ['rvd', 'radar', 'detector'],
  ['cctv', 'camera'],
  ['foc', 'fiber', 'fibre', 'optic'],
];

const STOP = new Set(['the', 'and', 'of', 'to', 'a', 'in', 'for', 'at', 'with', 'by', 'on', 'new', 'additional', 'extra', 'supply', 'install', 'provide', 'including', 'all', 'complete', 'as', 'per', 'from', 'or', 'an', 'be', 'is']);

const SYN_INDEX = new Map<string, number>();
SYNONYM_GROUPS.forEach((g, i) => g.forEach((w) => { if (!SYN_INDEX.has(w)) SYN_INDEX.set(w, i); }));

export function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\u00b2\u00b3\s-]/g, ' ').split(/\s+/).map((t) => t.replace(/^-+|-+$/g, '')).filter((t) => t.length > 1 && !STOP.has(t));
}

function stem(t: string): string {
  return t.length > 4 ? t.replace(/(ing|ed|es|s)$/, '') : t;
}

function groupsOf(tokens: string[]): Set<number> {
  const g = new Set<number>();
  for (const t of tokens) { const i = SYN_INDEX.get(t) ?? SYN_INDEX.get(stem(t)); if (i !== undefined) g.add(i); }
  return g;
}

/** Numbers that look like thicknesses/grades/sizes in a text: "50mm", "C40", "DN300". Used to catch spec clashes. */
export function specTokens(s: string): string[] {
  const m = s.toLowerCase().match(/\b(dn|c|b|grade\s?)?\d+(\.\d+)?\s?(mm|cm|m|kv|kva|w|mpa|n\/mm2)?\b/g) ?? [];
  return m.map((x) => x.replace(/\s+/g, '')).filter((x) => /\d/.test(x) && x.length >= 2);
}

export interface RetrievedCandidate {
  item: BoqItemRecord;
  score: number;
  reasons: string[];
  unitCompat: 'same' | 'same_dimension' | 'derivable' | 'incompatible' | 'unknown';
  specConflict: string | null;
}

function unitCompat(expected: string, boqUnit: string): RetrievedCandidate['unitCompat'] {
  if (!expected || !boqUnit) return 'unknown';
  if (canonUnit(expected) === canonUnit(boqUnit)) return 'same';
  const a = unitInfo(expected); const b = unitInfo(boqUnit);
  if (!a || !b) return 'unknown';
  if (a.dimension === b.dimension) return 'same_dimension';
  const pairs = new Set(['length>area', 'area>volume', 'length>volume', 'count>length', 'count>area', 'count>volume', 'volume>area', 'area>length']);
  return pairs.has(`${a.dimension}>${b.dimension}`) ? 'derivable' : 'incompatible';
}

export function retrieveCandidates(items: BoqItemRecord[], ctx: Map<string, RowContext>, comp: Pick<ScopeComponent, 'name' | 'discipline' | 'workType' | 'material' | 'specification' | 'location' | 'searchTerms' | 'expectedUnit'>, limit = 12): RetrievedCandidate[] {
  const queryText = [comp.name, comp.workType, comp.material, comp.discipline, ...(comp.searchTerms ?? [])].join(' ');
  const qTokens = Array.from(new Set(tokenize(queryText).map(stem)));
  const qGroups = groupsOf(tokenize(queryText));
  const coreTokens = new Set(tokenize(`${comp.name} ${comp.workType}`).map(stem));
  const coreGroups = groupsOf(tokenize(`${comp.name} ${comp.workType}`));
  const specQ = specTokens(`${comp.specification} ${comp.material} ${comp.name}`);
  const out: RetrievedCandidate[] = [];

  for (const item of items) {
    // The set's context map is keyed by the full record id (import id + row), so files with identical row ids never collide.
    const c = ctx.get(item.id) ?? ctx.get(item.id.slice(item.id.indexOf(':') + 1));
    const text = `${item.ref} ${c?.fullDescription ?? item.description}`;
    const locText = `${c?.preamble ?? ''}`.slice(0, 300);
    const secText = `${c?.section ?? ''} ${item.bill}`;
    const iTokens = new Set(tokenize(text).map(stem));
    const iGroups = groupsOf(tokenize(text));
    const sTokens = new Set(tokenize(secText).map(stem));
    const sGroups = groupsOf(tokenize(secText));
    const reasons: string[] = [];
    let score = 0;

    const exact = qTokens.filter((t) => iTokens.has(t));
    if (exact.length) { score += exact.length * 1.0; reasons.push(`shares words: ${exact.slice(0, 5).join(', ')}`); }
    const synHit = [...qGroups].filter((g) => iGroups.has(g) && !exact.some((t) => SYN_INDEX.get(t) === g));
    if (synHit.length) { score += synHit.length * 0.8; reasons.push('same work type through different wording'); }
    const coreExact = [...coreTokens].filter((t) => iTokens.has(t)).length;
    const coreSyn = [...coreGroups].filter((g) => iGroups.has(g)).length;
    if (coreExact + coreSyn > 0) score += 1.5;
    const secHit = [...qGroups].filter((g) => sGroups.has(g)).length + qTokens.filter((t) => sTokens.has(t)).length;
    if (secHit) { score += Math.min(1.5, secHit * 0.5); reasons.push(`section heading relates (${(c?.section || item.bill).slice(0, 40)})`); }

    // Location and preamble: a stated location in the item or its bill preamble is supporting evidence.
    const locTokens = tokenize(comp.location ?? '').map(stem);
    if (locTokens.length) {
      const locHay = new Set(tokenize(`${text} ${locText} ${secText}`).map(stem));
      const lh = locTokens.filter((t) => locHay.has(t));
      if (lh.length) { score += Math.min(0.8, lh.length * 0.3); reasons.push(`location/preamble mentions: ${lh.slice(0, 3).join(', ')}`); }
    }
    if (locText) {
      const pre = new Set(tokenize(locText).map(stem));
      const preHit = qTokens.filter((t) => pre.has(t));
      if (preHit.length >= 2) { score += 0.4; reasons.push('bill preamble relates to this work'); }
    }

    const uc = unitCompat(comp.expectedUnit, item.unit);
    if (uc === 'same') { score += 1.2; reasons.push(`unit ${item.unit} matches the expected unit`); }
    else if (uc === 'same_dimension') { score += 0.8; reasons.push(`unit ${item.unit} is the same dimension`); }
    else if (uc === 'derivable') { score += 0.2; reasons.push(`unit ${item.unit} needs a derivation from ${comp.expectedUnit}`); }
    else if (uc === 'incompatible') { score -= 1.5; reasons.push(`unit ${item.unit} is incompatible with ${comp.expectedUnit}`); }

    // Specification clash: a different numeric spec on the same kind of work is a warning, not a hit.
    let specConflict: string | null = null;
    if (specQ.length) {
      const specI = specTokens(text);
      const overlap = specQ.filter((s) => specI.includes(s));
      const clash = specI.filter((s) => !specQ.includes(s) && specQ.some((q) => q.replace(/\d+(\.\d+)?/, '') === s.replace(/\d+(\.\d+)?/, '') && q.replace(/[a-z]+$/, '') !== s.replace(/[a-z]+$/, '')));
      if (overlap.length) { score += 1.0; reasons.push(`specification matches (${overlap.join(', ')})`); }
      if (clash.length && !overlap.length) { score -= 1.2; specConflict = `BOQ line states ${clash.join(', ')}; the change states ${specQ.join(', ')}.`; reasons.push('specification differs'); }
    }
    if (score >= 1.5) out.push({ item, score, reasons, unitCompat: uc, specConflict });
  }
  return out.sort((a, b) => b.score - a.score || a.item.sourceFile.localeCompare(b.item.sourceFile) || a.item.rowNumber - b.item.rowNumber).slice(0, limit);
}

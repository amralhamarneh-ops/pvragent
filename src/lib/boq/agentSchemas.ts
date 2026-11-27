import { canonUnit, unitInfo } from './units';
import type { CandidateBrief, ChangeScope, EvidenceDoc, ModelMatchResult, ScopeAction, ScopeComponent, ScopeQuantity } from './scope';

export type ScopeEvidenceInput = Pick<EvidenceDoc, 'name' | 'kind' | 'text' | 'extracted' | 'note'>;

const ACTIONS: ScopeAction[] = ['add', 'omit', 'replace', 'rework'];

function str(v: unknown, max = 300): string { return typeof v === 'string' ? v.slice(0, max) : ''; }
function strArr(v: unknown, max = 12, len = 200): string[] { return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max).map((x) => x.slice(0, len)) : []; }
function normText(s: string): string { return s.toLowerCase().replace(/\s+/g, ' ').trim(); }

function hasWholeQuote(source: string, quote: string): boolean {
  if (!quote) return false;
  for (let i = source.indexOf(quote); i >= 0; i = source.indexOf(quote, i + 1)) {
    const before = source[i - 1] ?? '';
    const after = source[i + quote.length] ?? '';
    const beginsToken = /[\p{L}\p{N}]/u.test(quote[0]);
    const endsToken = /[\p{L}\p{N}]/u.test(quote[quote.length - 1]);
    const beforeNumericPart = (/[,./+\-−–]/.test(before) && /\p{N}/u.test(quote[0])
      && (!/[,.]/.test(before) || /\p{N}/u.test(source[i - 2] ?? '')));
    if ((!beginsToken || !/[\p{L}\p{N}_]/u.test(before)) && !beforeNumericPart
      && (!endsToken || !/[\p{L}\p{N}_/]/u.test(after))) return true;
  }
  return false;
}

const DECIMAL = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
function normalDecimal(s: string): string {
  const [integer, fraction = ''] = s.replace(/,/g, '').split('.');
  const tail = fraction.replace(/0+$/, '');
  return (integer.replace(/^0+(?=\d)/, '') || '0') + (tail ? `.${tail}` : '');
}
function statedPair(quote: string, value: string, unit: string): boolean {
  if (!DECIMAL.test(value) || normalDecimal(value) === '0') return false;
  const key = canonUnit(unit);
  if (!key) return false;
  const expected = normalDecimal(value);
  // Keep comma-grouped thousands and decimals whole. A unit must follow the same number, not another number in the quote.
  const numbers = /(^|[^\p{L}\p{N}.,_+\-−–])((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?![\d.,])/gu;
  for (const found of quote.matchAll(numbers)) {
    if (expected !== normalDecimal(found[2])) continue;
    const suffix = quote.slice(found.index! + found[0].length).trimStart().replace(/\s+/g, ' ');
    const words = suffix.match(/^[a-z][a-z.0-9²³]*(?:\s+[a-z][a-z.0-9²³]*){0,2}/i)?.[0]?.split(/\s+/) ?? [];
    // Prefer the longest known unit, so m cannot stand in for m², sqm or square metres.
    for (let length = words.length; length > 0; length--) {
      const candidate = words.slice(0, length).join(' ');
      if (unitInfo(candidate) || candidate.toLowerCase().replace(/\.$/, '') === unit.toLowerCase().replace(/\.$/, '')) {
        const next = suffix[candidate.length] ?? '';
        if (!/[\p{L}\p{N}_/]/u.test(next) && canonUnit(candidate) === key) return true;
        break;
      }
    }
  }
  return false;
}

/**
 * Validate the model's scope. A quantity is kept only if its quote really appears in the supplied evidence and the
 * number and unit form a stated pair inside that quote. Anything else is dropped to "no quantity" with a recorded problem, so the
 * model cannot introduce numbers the documents do not contain.
 */
export function sanitiseScope(raw: unknown, evidence: ScopeEvidenceInput[], narrative: string): { scope: ChangeScope | null; problems: string[] } {
  const problems: string[] = [];
  if (!raw || typeof raw !== 'object') return { scope: null, problems: ['Reply was not an object.'] };
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.components)) return { scope: null, problems: ['No components array.'] };
  const sources = [{ name: 'Narrative', text: normText(narrative) }, ...evidence.filter((e) => e.extracted).map((e) => ({ name: e.name, text: normText(e.text) }))];
  const seen = new Set<string>();
  const components: ScopeComponent[] = [];
  (o.components as unknown[]).slice(0, 20).forEach((c, i) => {
    if (!c || typeof c !== 'object') return;
    const k = c as Record<string, unknown>;
    let id = str(k.id, 20) || `c${i + 1}`;
    if (seen.has(id)) id = `${id}_${i + 1}`;
    seen.add(id);
    const validAction = ACTIONS.includes(k.action as ScopeAction);
    const action = validAction ? (k.action as ScopeAction) : 'add';
    if (!validAction) problems.push(`Action for “${str(k.name, 60)}” was not recognised. Component held as potential for review.`);
    let quantity: ScopeQuantity | null = null;
    const q = k.quantity as Record<string, unknown> | null | undefined;
    const missing = strArr(k.missingInputs);
    if (q && typeof q === 'object') {
      const rawValue = str(q.value, 30).trim();
      const unit = str(q.unit, 32).trim();
      const quote = str(q.quote, 300).trim();
      const matchedSources = sources.filter((source) => hasWholeQuote(source.text, normText(quote)));
      const sourceHint = str(q.source, 240).trim().toLowerCase();
      const namedMatches = matchedSources.filter((source) => source.name.toLowerCase() === sourceHint);
      const source = namedMatches.length === 1 ? namedMatches[0] : matchedSources.length === 1 ? matchedSources[0] : null;
      if (validAction && unit && source && statedPair(quote, rawValue, unit)) {
        // Geometry and reviewer entry are attributed only by their deterministic app workflows, never model prose.
        quantity = { value: rawValue.replace(/,/g, ''), unit, origin: 'stated_in_document', source: source.name, quote };
      } else {
        const reason = !validAction ? 'the action needs review before using a quantity'
          : !matchedSources.length ? 'its whole quote was not found in readable evidence'
          : !source ? 'its quote matched multiple sources without a unique source name'
          : 'the quote does not explicitly state that number with that unit';
        problems.push(`Quantity for “${str(k.name, 60)}” was dropped: ${reason}.`);
      }
    }
    if (!quantity && !missing.length) missing.push('quantity');
    components.push({
      id, name: str(k.name, 90) || `Component ${i + 1}`, action, discipline: str(k.discipline, 60), workType: str(k.workType, 90), material: str(k.material, 90), specification: str(k.specification, 160), location: str(k.location, 120),
      searchTerms: strArr(k.searchTerms, 14, 40), expectedUnit: str(k.expectedUnit, 12), quantity, missingInputs: missing, potential: !validAction || k.potential === true, potentialReason: validAction ? str(k.potentialReason, 240) : 'Confirm whether the work is an addition, omission, replacement, or rework.', evidence: strArr(k.evidence, 6, 240),
    });
  });
  if (components.length === 0) return { scope: null, problems: [...problems, 'No usable components.'] };
  const limitations = strArr(o.limitations, 10, 240);
  for (const e of evidence) if (!e.extracted) limitations.push(`${e.name}: ${e.note || 'no text could be extracted, so its contents were not read.'}`);
  return { scope: { summary: str(o.summary, 600), location: str(o.location, 160), packageName: str(o.packageName, 120), components, contradictions: strArr(o.contradictions, 10, 300), missingInformation: strArr(o.missingInformation, 12, 240), limitations: Array.from(new Set(limitations)) }, problems };
}

export function sanitiseMatch(raw: unknown, allowed: Record<string, string[]>): { match: ModelMatchResult | null; problems: string[] } {
  const problems: string[] = [];
  if (!raw || typeof raw !== 'object') return { match: null, problems: ['Reply was not an object.'] };
  const o = raw as Record<string, unknown>;
  const lines: ModelMatchResult['lines'] = [];
  const offered = (id: string) => Object.hasOwn(allowed, id) && Array.isArray(allowed[id]) ? allowed[id] : null;
  const seen = new Map<string, ModelMatchResult['lines'][number]>();
  const knownRows = new Set(Object.values(allowed).flat());
  for (const l of Array.isArray(o.lines) ? (o.lines as unknown[]) : []) {
    if (!l || typeof l !== 'object') continue;
    const k = l as Record<string, unknown>;
    const componentId = str(k.componentId, 30); const rowId = str(k.rowId, 300);
    const rows = offered(componentId);
    if (!rows) { problems.push(`Unknown component ${componentId}.`); continue; }
    if (!rows.includes(rowId)) { problems.push(`Row ${rowId} was not among the candidates offered for ${componentId}.`); continue; }
    if (k.role !== 'primary' && k.role !== 'alternative') { problems.push(`Missing or invalid role for row ${rowId}.`); continue; }
    const key = JSON.stringify([componentId, rowId]);
    const existing = seen.get(key);
    if (existing) {
      problems.push(`Duplicate model reference to row ${rowId} for ${componentId}.`);
      // A contradictory reply should not silently turn a possible match into an automatic price.
      if (existing.role !== k.role) existing.role = 'alternative';
      continue;
    }
    const line: ModelMatchResult['lines'][number] = { componentId, rowId, role: k.role, why: str(k.why, 300), preambleNote: str(k.preambleNote, 300) };
    seen.set(key, line);
    lines.push(line);
  }
  const pairs = (v: unknown, a: string, b: string) => (Array.isArray(v) ? (v as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object').map((x) => ({ [a]: str(x[a], 30), [b]: str(x[b], 300) })).filter((x) => offered(x[a] as string) !== null) : []);
  const overlaps = (Array.isArray(o.overlaps) ? (o.overlaps as unknown[]) : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object').map((x) => {
    const rows = [...new Set(strArr(x.rowIds, 6, 300))];
    const rowIds = rows.filter((id) => knownRows.has(id));
    if (rowIds.length !== rows.length) problems.push('An overlap included a BOQ row that was not offered.');
    return { rowIds, reason: str(x.reason, 300) };
  }).filter((o) => o.rowIds.length >= 2);
  return { match: { lines, potentiallyAffected: pairs(o.potentiallyAffected, 'componentId', 'reason') as ModelMatchResult['potentiallyAffected'], unmatched: pairs(o.unmatched, 'componentId', 'reason') as ModelMatchResult['unmatched'], overlaps }, problems };
}

export type { CandidateBrief };

import type { CandidateBrief, ChangeScope, EvidenceDoc, ModelMatchResult, ScopeAction, ScopeComponent, ScopeQuantity } from './scope';

export type ScopeEvidenceInput = Pick<EvidenceDoc, 'name' | 'kind' | 'text' | 'extracted' | 'note'>;

const ACTIONS: ScopeAction[] = ['add', 'omit', 'replace', 'rework'];

function str(v: unknown, max = 300): string { return typeof v === 'string' ? v.slice(0, max) : ''; }
function strArr(v: unknown, max = 12, len = 200): string[] { return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max).map((x) => x.slice(0, len)) : []; }
function normText(s: string): string { return s.toLowerCase().replace(/[\s,]+/g, ' ').trim(); }

/**
 * Validate the model's scope. A quantity is kept only if its quote really appears in the supplied evidence and the
 * number really appears inside that quote. Anything else is dropped to "no quantity" with a recorded problem, so the
 * model cannot introduce numbers the documents do not contain.
 */
export function sanitiseScope(raw: unknown, evidence: ScopeEvidenceInput[], narrative: string): { scope: ChangeScope | null; problems: string[] } {
  const problems: string[] = [];
  if (!raw || typeof raw !== 'object') return { scope: null, problems: ['Reply was not an object.'] };
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.components)) return { scope: null, problems: ['No components array.'] };
  const haystack = normText([narrative, ...evidence.filter((e) => e.extracted).map((e) => e.text)].join(' \n '));
  const seen = new Set<string>();
  const components: ScopeComponent[] = [];
  (o.components as unknown[]).slice(0, 20).forEach((c, i) => {
    if (!c || typeof c !== 'object') return;
    const k = c as Record<string, unknown>;
    let id = str(k.id, 20) || `c${i + 1}`;
    if (seen.has(id)) id = `${id}_${i + 1}`;
    seen.add(id);
    const action = ACTIONS.includes(k.action as ScopeAction) ? (k.action as ScopeAction) : 'add';
    let quantity: ScopeQuantity | null = null;
    const q = k.quantity as Record<string, unknown> | null | undefined;
    const missing = strArr(k.missingInputs);
    if (q && typeof q === 'object') {
      const value = str(q.value, 30).replace(/,/g, '').trim();
      const unit = str(q.unit, 16).trim();
      const quote = str(q.quote, 300).trim();
      const quoteOk = quote.length > 0 && haystack.includes(normText(quote));
      const numOk = /^\d+(\.\d+)?$/.test(value) && normText(quote).replace(/,/g, '').includes(value);
      // The origin comes from the validated quote, never from the model: the analysis stage writes the basis into its lines.
      const origin: ScopeQuantity['origin'] = /measured from drawings/i.test(quote) ? 'measured_from_geometry' : /entered by the user/i.test(quote) ? 'user_entered' : 'stated_in_document';
      if (value && unit && quoteOk && numOk) quantity = { value, unit, origin, source: str(q.source, 120) || 'Change evidence', quote };
      else problems.push(`Quantity for “${str(k.name, 60)}” was dropped: its quote ${quoteOk ? 'does not contain the number' : 'was not found in the evidence'}.`);
    }
    if (!quantity && !missing.length) missing.push('quantity');
    components.push({
      id, name: str(k.name, 90) || `Component ${i + 1}`, action, discipline: str(k.discipline, 60), workType: str(k.workType, 90), material: str(k.material, 90), specification: str(k.specification, 160), location: str(k.location, 120),
      searchTerms: strArr(k.searchTerms, 14, 40), expectedUnit: str(k.expectedUnit, 12), quantity, missingInputs: missing, potential: k.potential === true, potentialReason: str(k.potentialReason, 240), evidence: strArr(k.evidence, 6, 240),
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
  for (const l of Array.isArray(o.lines) ? (o.lines as unknown[]) : []) {
    if (!l || typeof l !== 'object') continue;
    const k = l as Record<string, unknown>;
    const componentId = str(k.componentId, 30); const rowId = str(k.rowId, 300);
    if (!allowed[componentId]) { problems.push(`Unknown component ${componentId}.`); continue; }
    if (!allowed[componentId].includes(rowId)) { problems.push(`Row ${rowId} was not among the candidates offered for ${componentId}.`); continue; }
    lines.push({ componentId, rowId, role: k.role === 'alternative' ? 'alternative' : 'primary', why: str(k.why, 300), preambleNote: str(k.preambleNote, 300) });
  }
  const pairs = (v: unknown, a: string, b: string) => (Array.isArray(v) ? (v as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object').map((x) => ({ [a]: str(x[a], 30), [b]: str(x[b], 300) })).filter((x) => allowed[x[a] as string]) : []);
  const overlaps = (Array.isArray(o.overlaps) ? (o.overlaps as unknown[]) : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object').map((x) => ({ rowIds: strArr(x.rowIds, 6, 300), reason: str(x.reason, 300) }));
  return { match: { lines, potentiallyAffected: pairs(o.potentiallyAffected, 'componentId', 'reason') as ModelMatchResult['potentiallyAffected'], unmatched: pairs(o.unmatched, 'componentId', 'reason') as ModelMatchResult['unmatched'], overlaps }, problems };
}

export type { CandidateBrief };

import { D } from '../assessment/decimal';
import { stableLineId } from '../boq/resolutions';
import type { AssessmentOutcome, RelatedLine } from '../boq/matchEngine';
import type { ChangeScope, ScopeComponent } from '../boq/scope';
import type { AssessmentItem } from '../boq/newItem';
import { componentKeyOf, detectValuationOverlaps, heldOutByOverlap, lineIdOf, sourceKeyOf, uniqueKeys, type OverlapIssue, type OverlapLine } from '../boq/valuation';
import type { WorkLine } from './realActivityMapping';

/**
 * Builds the single list of lines that cost, activity mapping and exclusions all share.
 *
 * A line's id is `<sourceKey>#<componentKey>`: WHAT changed plus WHERE its price comes from. Two changes that use the
 * same BOQ row get two lines, and no line is ever dropped because another shares its row. Combining lines is an
 * explicit user action (see valuation.ts), and every underlying change stays recorded.
 */

const EXECUTION_WORDS = ['excav', 'earthwork', 'fill', 'embank', 'trench', 'grading', 'subbase', 'sub-base', 'base', 'binder', 'asphalt', 'wearing', 'pavement', 'paving', 'surfacing', 'kerb', 'curb', 'concrete', 'reinforc', 'formwork', 'drain', 'culvert', 'pipe', 'manhole', 'lighting', 'cable', 'duct', 'marking', 'sign', 'barrier', 'fence', 'wall', 'foundation', 'pile', 'plant', 'landscap', 'install', 'construct', 'lay', 'erect', 'demol', 'remov', 'repair', 'rework'];

/** An execution line moves material or builds something. A pure cost adjustment, allowance or lump-sum item does not. */
export function executesWork(name: string, unit: string): boolean {
  const u = unit.trim().toLowerCase();
  if (u === 'ls' || u === 'lump sum' || u === 'sum' || u === 'item') return false;
  const t = name.toLowerCase();
  return EXECUTION_WORDS.some((w) => t.includes(w)) || ['m', 'm2', 'm3', 'no', 'nr', 'kg', 't', 'tonne', 'km', 'lm', 'm²', 'm³'].includes(u);
}

export interface SharedLine {
  lineId: string;
  /** Where the price comes from: a BOQ row, an assessment item, or nothing yet. */
  sourceKey: string;
  /** Which change this line prices. */
  componentKey: string;
  componentId: string;
  name: string;
  origin: 'boq' | 'new_item' | 'scope_only';
  work: WorkLine;
  /** Cost state, from the shared outcome. */
  priced: boolean;
  signedAmount: string | null;
  currency: string;
  source: string;
  itemId?: string;
  /** Other lines that price from the same BOQ row. Informational: sharing a row is normal. */
  sharesSourceWith: string[];
  /** Set when a deterministic overlap check holds this line out of the priced subtotal. */
  heldForOverlap?: boolean;
}

export interface SharedLinesResult {
  lines: SharedLine[];
  issues: OverlapIssue[];
}

export function buildSharedLines(scope: ChangeScope | null, outcome: AssessmentOutcome | null, items: AssessmentItem[], currency: string): SharedLine[] {
  return buildSharedLinesDetailed(scope, outcome, items, currency).lines;
}

export function buildSharedLinesDetailed(scope: ChangeScope | null, outcome: AssessmentOutcome | null, items: AssessmentItem[], currency: string): SharedLinesResult {
  const draft: Omit<SharedLine, 'lineId' | 'sharesSourceWith'>[] = [];
  const keys: string[] = [];
  const overlapIn: Omit<OverlapLine, 'lineId'>[] = [];

  if (scope) {
    for (const c of scope.components) {
      const primary = outcome?.lines.find((l) => l.componentId === c.id && l.role === 'primary') ?? null;
      const sourceKey = sourceKeyFor(primary);
      const componentKey = componentKeyOf(c);
      const unit = c.quantity?.unit || c.expectedUnit || primary?.item.unit || '';
      const amt = primary ? amountOf(primary) : null;
      const excluded = !!primary?.excluded;
      keys.push(lineIdOf(sourceKey, componentKey));
      draft.push({
        sourceKey, componentKey, componentId: c.id, name: c.name,
        origin: primary ? 'boq' : 'scope_only',
        work: workFrom('', c, unit),
        priced: amt !== null, signedAmount: amt, currency: primary?.item.currency || currency,
        source: primary ? `${primary.item.sourceFile} · ${primary.item.sheet}!${primary.item.rowNumber}` : 'No BOQ row matched',
      });
      overlapIn.push({
        componentKey, sourceKey, description: primary?.item.description ?? c.name,
        covers: [componentKey, c.name, c.workType].filter(Boolean).map((x) => x.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')),
        origin: primary?.manual ? 'manual_rate' : 'boq', included: !!primary && !excluded && amt !== null,
      });
    }
  }

  for (const it of items) {
    const sourceKey = sourceKeyOf({ newItemId: it.id });
    const componentKey = it.linkedScope ? `item~${it.id}` : `item~${it.id}`;
    const price = it.quantity !== null && it.rate !== null ? D(it.quantity).mul(D(it.rate)) : null;
    const signed = price === null ? null : it.changeType === 'omission' ? price.neg().toString() : price.toString();
    keys.push(lineIdOf(sourceKey, componentKey));
    const linkedKey = it.linkedScope && scope ? (() => { const c = scope.components.find((x) => x.id === it.linkedScope); return c ? componentKeyOf(c) : undefined; })() : undefined;
    draft.push({
      sourceKey, componentKey, componentId: it.linkedScope || it.id, name: it.description, origin: 'new_item', itemId: it.id,
      work: {
        lineId: '', componentId: it.linkedScope || it.id, name: it.description, description: it.description, specification: '', location: it.location,
        discipline: '', workType: it.description, searchTerms: it.description.split(/\s+/), quantity: it.quantity, unit: it.uom,
        action: it.changeType === 'omission' ? 'omit' : it.changeType === 'substitution' ? 'replace' : it.changeType === 'rework' ? 'rework' : 'add',
        executes: executesWork(it.description, it.uom),
      },
      priced: signed !== null, signedAmount: signed, currency: it.currency, source: `Assessment item (case-specific)${it.supportingReference ? ` · ${it.supportingReference}` : ''}`,
    });
    overlapIn.push({ componentKey, sourceKey, description: it.description, covers: [componentKey], linkedComponentKey: linkedKey, origin: 'new_item', included: signed !== null });
  }

  // Unique ids: nothing is dropped, a repeated key gets a numeric suffix.
  const ids = uniqueKeys(keys);
  const bySource = new Map<string, string[]>();
  draft.forEach((d, i) => { if (d.sourceKey !== 'unmatched') bySource.set(d.sourceKey, [...(bySource.get(d.sourceKey) ?? []), ids[i]]); });

  const lines: SharedLine[] = draft.map((d, i) => ({
    ...d, lineId: ids[i],
    work: { ...d.work, lineId: ids[i] },
    sharesSourceWith: (bySource.get(d.sourceKey) ?? []).filter((x) => x !== ids[i]),
  }));

  const overlapLines: OverlapLine[] = overlapIn.map((o, i) => ({ ...o, lineId: ids[i] }));
  const issues = detectValuationOverlaps(overlapLines);
  const held = heldOutByOverlap(issues);
  for (const l of lines) if (held.has(l.lineId)) l.heldForOverlap = true;
  return { lines, issues };
}

function sourceKeyFor(primary: RelatedLine | null): string {
  if (primary && primary.item.importId && !primary.item.id.startsWith('manual:')) return sourceKeyOf({ importId: primary.item.importId, sheet: primary.item.sheet, rowNumber: primary.item.rowNumber });
  return 'unmatched';
}

function amountOf(l: RelatedLine): string | null {
  if (l.manual) return l.manual.amountSigned;
  return l.valued && l.calc && l.calc.ok ? l.calc.signedAmount : null;
}

function workFrom(lineId: string, c: ScopeComponent, unit: string): WorkLine {
  return {
    lineId, componentId: c.id, name: c.name, description: [c.name, c.workType, c.material].filter(Boolean).join(' '), specification: c.specification, location: c.location,
    discipline: c.discipline, workType: c.workType, searchTerms: c.searchTerms, quantity: c.quantity?.value ?? null, unit, action: c.action, executes: executesWork(`${c.name} ${c.workType}`, unit),
  };
}

/** Kept for callers that still compute the legacy row-based id. */
export { stableLineId };

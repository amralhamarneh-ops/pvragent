import { D } from '../assessment/decimal';
import { calculateChange, recordsFromImport } from './calc';
import { buildRowContext, type RowContext } from './context';
import { planConversion } from './units';
import { retrieveCandidates, type RetrievedCandidate } from './retrieve';
import { priceWithManualRate, validProcessedPvrRate, summariseCost, type CostSummary, type ExclusionScope, type LineResolution, type ManualRate, type Resolutions, type SummaryLine } from './resolutions';
import type { BoqImport, BoqItemRecord, CalcResult } from './types';
import type { ChangeScope, CandidateBrief, ModelMatchResult, ScopeComponent } from './scope';

/** The active BOQ set: every selected, confirmed import across all files, each row keeping its own file identity. */
export interface BoqSet {
  items: BoqItemRecord[];
  /** Keyed by BoqItemRecord.id (import id + sheet + row), so identical sheet names in different files never collide. */
  context: Map<string, RowContext>;
  files: { importId: string; fileName: string; revision: number; revisionLabel: string; sha256: string; items: number; unpriced: number }[];
}

export function buildBoqSet(imports: BoqImport[]): BoqSet {
  const items: BoqItemRecord[] = [];
  const context = new Map<string, RowContext>();
  const files: BoqSet['files'] = [];
  for (const imp of imports) {
    const recs = recordsFromImport(imp);
    const ctx = buildRowContext(imp.rows);
    for (const r of recs) {
      const rowId = r.id.slice(imp.id.length + 1);
      const c = ctx.get(rowId);
      if (c) context.set(r.id, c);
    }
    items.push(...recs);
    files.push({ importId: imp.id, fileName: imp.source.fileName, revision: imp.revision, revisionLabel: imp.source.revisionLabel, sha256: imp.source.sha256, items: recs.length, unpriced: recs.filter((x) => x.rate.state !== 'value').length });
  }
  return { items, context, files };
}

export function briefFor(item: BoqItemRecord, ctx: Map<string, RowContext>): CandidateBrief {
  const c = ctx.get(item.id);
  return { rowId: item.id, ref: item.ref, description: (c?.fullDescription ?? item.description).slice(0, 220), unit: item.unit, bill: item.bill, section: (c?.section ?? '').slice(0, 80), file: item.sourceFile, hasRate: item.rate.state === 'value' };
}

/** Shortlist per component from the whole set. Only these are sent to the model. */
export function shortlistForScope(set: BoqSet, scope: ChangeScope, perComponent = 10): Record<string, RetrievedCandidate[]> {
  const out: Record<string, RetrievedCandidate[]> = {};
  for (const comp of scope.components) out[comp.id] = retrieveCandidates(set.items, set.context, comp, perComponent);
  return out;
}

export type ReviewStatus = 'ready' | 'needs_input' | 'unpriced' | 'blocked';

export interface RelatedLine {
  key: string;
  componentId: string;
  componentName: string;
  item: BoqItemRecord;
  role: 'primary' | 'alternative';
  /** Alternatives are shown but never valued. */
  valued: boolean;
  why: string;
  preambleNote: string;
  section: string;
  quantityText: string;
  quantityOrigin: string;
  quantitySource: string;
  calc: CalcResult | null;
  status: ReviewStatus;
  statusNote: string;
  specConflict: string | null;
  matchBasis: string[];
  alternativesFor?: string;
  /** Where the amount comes from. Manual rates are case-specific and proposed only. */
  rateSource?: 'boq' | 'manual_proposed';
  /** Manual price for this line, when a manual rate overrides the BOQ rate. */
  manual?: { rate: ManualRate; amountSigned: string; formula: string; quantityText: string };
  /** Set when the line is excluded from this assessment. */
  excluded?: { scope: ExclusionScope; reason: string; by: string; at: string };
  /** The user chose to leave this line unresolved and continue with a partial assessment. */
  leftUnresolved?: boolean;
  /** Valuation postponed by the user. The line keeps its scope and schedule effect and carries no amount. */
  deferred?: { reason: string; by: string; at: string };
}

export interface NeedsInput {
  id: string;
  kind: 'no_item' | 'ambiguous_candidates' | 'missing_quantity' | 'missing_dimension' | 'missing_rate' | 'contradiction' | 'unit_mismatch' | 'overlap' | 'potential' | 'column_ambiguity';
  componentId?: string;
  title: string;
  issue: string;
  evidence: string[];
  proposal: string;
  options: { id: string; label: string; rowId?: string }[];
}

export interface AssessmentOutcome {
  lines: RelatedLine[];
  needs: NeedsInput[];
  total: string | null;
  currency: string;
  pricedCount: number;
  /** Components with no valued line: shown as "New item / rate required". */
  unmatched: { componentId: string; name: string; reason: string }[];
  potentials: { componentId: string; name: string; reason: string }[];
  rejectedModelRefs: string[];
  /** Separate priced / unpriced / excluded / manual-proposed totals. */
  summary: CostSummary;
  /** Components with no line at all but a resolution (e.g. manual rate or exclusion with no BOQ match). */
  resolvedOnly: { componentId: string; name: string; resolution: LineResolution; line: RelatedLine | null }[];
  /** Components with no BOQ line whose valuation was deferred. */
  deferredOnly: { componentId: string; name: string; reason: string }[];
}

export interface UserAnswers {
  /** componentId -> chosen rowId, or '__none__' for "no BOQ item / new rate required". */
  chosenRow: Record<string, string>;
  /** componentId -> { value, unit } supplied for a missing quantity. */
  quantity: Record<string, { value: string; unit: string }>;
  /** componentId -> derivation inputs. */
  derivation: Record<string, { inputs: Record<string, { value: string; unit: string }>; basis: string }>;
  /** component ids the user confirmed as included even though only "potential". */
  includePotential: Record<string, boolean>;
  /** rowIds the user excluded. */
  excluded: Record<string, boolean>;
  /** rowId -> componentId replacement. */
  replaced: Record<string, string>;
  /** componentId -> case-specific resolution (manual proposed rate, exclusion, or left unresolved). */
  resolutions: Resolutions;
}

export const EMPTY_ANSWERS: UserAnswers = { chosenRow: {}, quantity: {}, derivation: {}, includePotential: {}, excluded: {}, replaced: {}, resolutions: {} };

function originLabel(o: string): string {
  return o === 'stated_in_document' ? 'Stated in document' : o === 'user_entered' ? 'User-entered' : o === 'derived_from_stated' ? 'Derived from stated values' : 'Measured from geometry';
}

/**
 * Turn the model's proposal into a validated outcome. Every row id the model returned is checked against the
 * active set; unknown ids are discarded and reported. All rates, unit checks and arithmetic come from
 * calculateChange. Alternatives are never valued, and two valued lines on the same row are blocked as duplicates.
 */
export function assemble(set: BoqSet, scope: ChangeScope, proposal: ModelMatchResult, shortlist: Record<string, RetrievedCandidate[]>, answers: UserAnswers = EMPTY_ANSWERS): AssessmentOutcome {
  const byId = new Map(set.items.map((i) => [i.id, i]));
  const compById = new Map(scope.components.map((c) => [c.id, c]));
  const rejected: string[] = [];
  const lines: RelatedLine[] = [];
  const needs: NeedsInput[] = [];
  const currency = set.items[0]?.currency ?? '';

  // Validate model references and restrict them to the shortlist offered for that component.
  const valid = proposal.lines.filter((l) => {
    const comp = compById.get(l.componentId);
    if (!comp) { rejected.push(`${l.rowId} (unknown component ${l.componentId})`); return false; }
    if (!byId.has(l.rowId)) { rejected.push(`${l.rowId} (not in the uploaded BOQ set)`); return false; }
    if (!(shortlist[l.componentId] ?? []).some((c) => c.item.id === l.rowId)) { rejected.push(`${l.rowId} (not among the candidates retrieved for ${comp.name})`); return false; }
    return true;
  });

  const perComp = new Map<string, typeof valid>();
  for (const l of valid) perComp.set(l.componentId, [...(perComp.get(l.componentId) ?? []), l]);

  const unmatched: AssessmentOutcome['unmatched'] = [];
  const potentials: AssessmentOutcome['potentials'] = [];
  const valuedRows = new Map<string, { componentId: string }>();

  for (const comp of scope.components) {
    const potentialByModel = proposal.potentiallyAffected.find((p) => p.componentId === comp.id);
    const isPotential = (comp.potential || !!potentialByModel) && !answers.includePotential[comp.id];
    if (isPotential) {
      const reason = comp.potentialReason || potentialByModel?.reason || 'Plausible, but the evidence does not establish it.';
      potentials.push({ componentId: comp.id, name: comp.name, reason });
      needs.push({ id: `pot-${comp.id}`, kind: 'potential', componentId: comp.id, title: `Potentially affected: ${comp.name}`, issue: 'Potentially affected: clarification required. It is not included in the valuation.', evidence: comp.evidence, proposal: reason, options: [{ id: 'include', label: 'Include in valuation' }, { id: 'exclude', label: 'Leave out' }] });
      continue;
    }

    // Replacement from the reviewer overrides the model for this component.
    let proposed = (perComp.get(comp.id) ?? []).slice();
    const chosen = answers.chosenRow[comp.id];
    if (chosen === '__none__') proposed = [];
    else if (chosen && byId.has(chosen)) proposed = [{ componentId: comp.id, rowId: chosen, role: 'primary', why: 'Chosen by you.', preambleNote: '' }, ...proposed.filter((p) => p.rowId !== chosen).map((p) => ({ ...p, role: 'alternative' as const }))];

    const primaries = proposed.filter((p) => p.role === 'primary' && !answers.excluded[p.rowId]);
    const alternatives = proposed.filter((p) => p.role === 'alternative' || answers.excluded[p.rowId]);

    if (primaries.length === 0 && !(alternatives.length > 0 && !chosen)) {
      const reason = chosen === '__none__' ? 'You marked this as having no matching BOQ item.' : 'No suitable BOQ item was found in the uploaded BOQ set.';
      unmatched.push({ componentId: comp.id, name: comp.name, reason });
      needs.push({ id: `none-${comp.id}`, kind: 'no_item', componentId: comp.id, title: `New item / rate required: ${comp.name}`, issue: reason, evidence: comp.evidence, proposal: 'Keep as unpriced scope until a rate is provided.', options: [{ id: 'keep', label: 'Keep unpriced' }, ...(shortlist[comp.id] ?? []).slice(0, 4).map((c) => ({ id: c.item.id, label: `${c.item.ref} ${c.item.description.slice(0, 50)} (${c.item.unit})`, rowId: c.item.id }))] });
      continue;
    }

    // Several primaries for one component that are not distinct work: ask, do not price them all.
    let primary = primaries[0];
    if (primaries.length > 1 && !chosen) {
      needs.push({ id: `amb-${comp.id}`, kind: 'ambiguous_candidates', componentId: comp.id, title: `Several BOQ items fit: ${comp.name}`, issue: 'More than one item could price this component. Only one should be valued so the work is not priced twice.', evidence: comp.evidence, proposal: `${byId.get(primaries[0].rowId)?.ref ?? ''} looks closest.`, options: primaries.map((p) => { const it = byId.get(p.rowId)!; return { id: p.rowId, label: `${it.ref} ${it.description.slice(0, 50)} (${it.unit}) · ${it.sourceFile}`, rowId: p.rowId }; }) });
      primary = undefined as unknown as typeof primaries[0];
    }

    const toLine = (p: typeof proposed[number], role: 'primary' | 'alternative'): RelatedLine => {
      const item = byId.get(p.rowId)!;
      const cand = (shortlist[comp.id] ?? []).find((c) => c.item.id === p.rowId);
      const ctx = set.context.get(item.id);
      return lineFor(comp, item, role, p.why, p.preambleNote || (ctx?.preamble ? `Bill preamble: ${ctx.preamble.slice(0, 200)}` : ''), ctx?.section ?? '', cand, answers, p.rowId);
    };

    if (primary) {
      const l = toLine(primary, 'primary');
      // Different changes may legitimately price from the same BOQ row; each keeps its own line, quantity and amount.
      // The SAME work repeated (same name, action and location) on one row is a duplicate and is not valued twice.
      const prior = valuedRows.get(primary.rowId);
      if (prior && l.valued) {
        const priorComp = compById.get(prior.componentId);
        if (priorComp && sameWork(priorComp, comp)) {
          l.valued = false; l.status = 'blocked'; l.statusNote = `Same work already valued for “${priorComp.name}” on this BOQ row. Not valued twice.`;
          needs.push({ id: `dup-${comp.id}-${primary.rowId}`, kind: 'overlap', componentId: comp.id, title: `Overlap: ${l.item.ref}`, issue: `“${comp.name}” and “${priorComp.name}” describe the same work, action and location on this BOQ line. Pricing both would double count.`, evidence: [l.item.description], proposal: 'Value it once, or combine them explicitly if they are genuinely separate quantities.', options: [{ id: 'keep-first', label: `Keep it under “${priorComp.name}” only` }] });
        } else {
          l.statusNote = `${l.statusNote ? `${l.statusNote} ` : ''}Shares BOQ row ${l.item.ref} with “${priorComp?.name ?? 'another change'}”. Each change keeps its own quantity and amount; combine them only if you choose to.`.trim();
        }
      } else if (l.valued) valuedRows.set(primary.rowId, { componentId: comp.id });
      lines.push(l);
      for (const a of alternatives.filter((x) => x.rowId !== primary.rowId)) { const al = toLine(a, 'alternative'); al.valued = false; al.alternativesFor = l.item.ref; al.status = 'needs_input'; al.statusNote = 'Alternative candidate for the same component. Not valued.'; lines.push(al); }
    } else if (primaries.length > 1) {
      for (const p of primaries) { const al = toLine(p, 'alternative'); al.valued = false; al.status = 'needs_input'; al.statusNote = 'Candidate awaiting your choice. Not valued.'; lines.push(al); }
    }
  }

  // Model-reported overlaps (e.g. an item already covered by a composite rate).
  for (const o of proposal.overlaps) {
    const ids = o.rowIds.filter((r) => byId.has(r));
    if (ids.length < 2) continue;
    const valued = lines.filter((l) => l.valued && ids.includes(l.item.id));
    if (valued.length >= 2) {
      needs.push({ id: `ovl-${ids.join('+')}`, kind: 'overlap', title: 'Possible overlapping items', issue: o.reason, evidence: valued.map((v) => `${v.item.ref} ${v.item.description}`), proposal: 'Only one of these should usually be valued.', options: valued.map((v) => ({ id: v.item.id, label: `Keep ${v.item.ref}`, rowId: v.item.id })) });
    }
  }

  // Aggregate statuses into exceptions.
  for (const l of lines) {
    if (!l.valued) continue;
    const comp = compById.get(l.componentId)!;
    if (l.status === 'unpriced') needs.push({ id: `rate-${l.key}`, kind: 'missing_rate', componentId: l.componentId, title: `No rate: ${l.item.ref}`, issue: l.statusNote, evidence: [`${l.item.sourceFile} · ${l.item.sheet}!${l.item.rate.cell || l.item.cells.rate || ''}`], proposal: 'Keep unpriced and request a rate.', options: [{ id: 'keep', label: 'Keep unpriced' }] });
    if (l.status === 'needs_input' && l.calc && !l.calc.ok && (l.calc.kind === 'unit_mismatch')) {
      const plan = planConversion(comp.quantity?.unit ?? '', l.item.unit);
      const req = plan.kind === 'needs_derivation' ? plan.required.join(', ') : '';
      needs.push({ id: `dim-${l.key}`, kind: 'missing_dimension', componentId: l.componentId, title: `Missing input: ${comp.name}`, issue: l.calc.message, evidence: comp.quantity ? [`${comp.quantity.value} ${comp.quantity.unit} · ${originLabel(comp.quantity.origin)} · “${comp.quantity.quote}”`] : [], proposal: req ? `Provide ${req}, with its source.` : 'Provide the missing dimension.', options: [{ id: 'provide', label: `Provide ${req || 'dimension'}` }] });
    }
    if (l.status === 'needs_input' && !l.calc && !comp.quantity) needs.push({ id: `qty-${l.key}`, kind: 'missing_quantity', componentId: l.componentId, title: `No quantity: ${comp.name}`, issue: 'The evidence does not give a quantity for this component. It is not copied from another component.', evidence: comp.evidence, proposal: 'Enter the quantity and its source.', options: [{ id: 'provide', label: 'Enter quantity' }] });
    if (l.specConflict) needs.push({ id: `spec-${l.key}`, kind: 'ambiguous_candidates', componentId: l.componentId, title: `Specification differs: ${l.item.ref}`, issue: l.specConflict, evidence: [l.item.description], proposal: 'Check the specification before relying on this line.', options: [{ id: 'keep', label: 'Keep this line' }, { id: 'exclude', label: 'Exclude it' }] });
  }

  for (const c of scope.contradictions) needs.push({ id: `con-${needs.length}`, kind: 'contradiction', title: 'Evidence conflicts', issue: c, evidence: [], proposal: 'Confirm which document governs.', options: [{ id: 'pvr', label: 'PVR governs' }, { id: 'drawing', label: 'Drawing governs' }, { id: 'other', label: 'Enter another value' }] });

  // ---- Case-specific line resolutions (manual proposed rate, exclusion, leave unresolved) ----
  const resolvedOnly: AssessmentOutcome['resolvedOnly'] = [];
  const deferredOnly: AssessmentOutcome['deferredOnly'] = [];
  const resolutions = answers.resolutions ?? {};
  const usedPvrRows = new Set<string>();
  for (const comp of scope.components) {
    const res = resolutions[comp.id];
    if (!res) continue;
    const primaryLine = lines.find((l) => l.componentId === comp.id && l.role === 'primary' && l.valued) ?? null;
    const q = answers.quantity[comp.id] ?? comp.quantity;
    const direction = comp.action === 'omit' ? 'omission' : 'addition';

    if (res.kind === 'excluded') {
      // Exclusion removes the line from active totals only. The BOQ row and evidence are untouched; sign is never changed.
      if (primaryLine) { primaryLine.excluded = { scope: res.scope, reason: res.reason, by: res.by, at: res.at }; primaryLine.valued = false; primaryLine.statusNote = res.scope === 'cost_only' ? 'Cost excluded. Scope and schedule impact retained.' : 'Excluded from this scenario entirely.'; }
      else resolvedOnly.push({ componentId: comp.id, name: comp.name, resolution: res, line: null });
      removeNeeds(needs, comp.id);
      continue;
    }

    if (res.kind === 'unresolved') {
      if (primaryLine) { primaryLine.leftUnresolved = true; if (primaryLine.status !== 'ready') primaryLine.valued = true; }
      continue;
    }

    if (res.kind === 'deferred') {
      // Deferral postpones valuation only. The line stays in scope and keeps its schedule effect; it carries no amount.
      if (primaryLine) { primaryLine.deferred = { reason: res.reason, by: res.by, at: res.at }; primaryLine.statusNote = 'Valuation deferred. Scope and schedule impact retained.'; }
      else deferredOnly.push({ componentId: comp.id, name: comp.name, reason: res.reason });
      removeNeeds(needs, comp.id, ['missing_rate', 'no_item', 'missing_dimension', 'unit_mismatch', 'missing_quantity']);
      continue;
    }

    if (res.kind === 'manual_rate') {
      if (!q) continue;
      const fallback = res.manual.processedPvr;
      const fallbackRow = fallback ? JSON.stringify([fallback.file, String(Number(fallback.page)), fallback.row].map((v) => v.trim().toLowerCase())) : '';
      if (fallback) {
        // A selected, usable BOQ rate wins. A fallback cannot bypass a
        // unit conflict, unanswered scope/BOQ selection, or duplicate pricing.
        if (primaryLine?.calc?.ok) continue;
        const blocked = (primaryLine?.calc && !primaryLine.calc.ok && primaryLine.calc.kind !== 'unpriced')
          || primaryLine?.specConflict
          || (primaryLine && !['identity', 'same_dimension'].includes(planConversion(q.unit, primaryLine.item.unit).kind))
          || potentials.some((p) => p.componentId === comp.id)
          || needs.some((n) => n.componentId === comp.id && ['ambiguous_candidates', 'overlap', 'missing_dimension', 'unit_mismatch'].includes(n.kind))
          || (!primaryLine && answers.chosenRow[comp.id] !== '__none__' && lines.some((l) => l.componentId === comp.id))
          || usedPvrRows.has(fallbackRow)
          || !validProcessedPvrRate(res.manual, comp, q.unit, currency);
        if (blocked) {
          needs.push({ id: `pvr-fallback-${comp.id}`, kind: 'missing_rate', componentId: comp.id,
            title: `Processed PVR rate not applied: ${comp.name}`,
            issue: 'Check the source file, page, unique item/row, case currency, unit and scope. Resolve ambiguity or overlapping work before applying the fallback.',
            evidence: [], proposal: 'Review the processed PVR source and matching scope.', options: [] });
          continue;
        }
      }
      const priced = priceWithManualRate({ quantity: q.value, quantityUnit: q.unit, rate: res.manual.value, rateUnit: res.manual.unit, currency: res.manual.currency, direction, zeroBasis: res.manual.zeroBasis, requireZeroBasis: true });
      if (!priced.ok) continue; // A rejected pairing is never applied silently; the editor reports why.
      if (fallback) usedPvrRows.add(fallbackRow);
      const base: RelatedLine = primaryLine ?? {
        key: `${comp.id}|manual`, componentId: comp.id, componentName: comp.name,
        item: manualItem(comp.id, comp.name, res.manual),
        role: 'primary', valued: true, why: 'Manual rate entered for this case.', preambleNote: '', section: '',
        quantityText: `${q.value} ${q.unit}`, quantityOrigin: 'origin' in q ? originLabel(String(q.origin)) : 'User-entered', quantitySource: 'source' in q ? String(q.source) : 'Entered in the review',
        calc: null, status: 'ready', statusNote: '', specConflict: null, matchBasis: [],
      };
      base.valued = true;
      base.status = 'ready';
      base.rateSource = 'manual_proposed';
      base.manual = { rate: res.manual, amountSigned: priced.signedAmount, formula: priced.formula, quantityText: `${priced.quantity} ${priced.quantityUnit}` };
      base.statusNote = fallback ? 'Processed PVR rate · Pilot only. Not an approved BOQ rate.' : 'Manual rate · Proposed. Not commercially approved.';
      if (!primaryLine) lines.push(base);
      removeNeeds(needs, comp.id, ['missing_rate', 'no_item', 'missing_dimension', 'unit_mismatch']);
      const ui = unmatched.findIndex((u) => u.componentId === comp.id);
      if (ui >= 0) unmatched.splice(ui, 1);
    }
  }

  const amountOf = (l: RelatedLine): string | null => {
    if (l.excluded) return l.manual ? l.manual.amountSigned : l.calc && l.calc.ok ? l.calc.signedAmount : null;
    if (l.manual) return l.manual.amountSigned;
    return l.valued && l.calc && l.calc.ok ? l.calc.signedAmount : null;
  };
  const summaryLines: SummaryLine[] = lines
    .filter((l) => l.role === 'primary' && (l.valued || l.excluded || l.deferred))
    .map((l) => ({ key: l.key, componentId: l.componentId, included: !l.excluded, signedAmount: l.deferred ? null : amountOf(l), source: l.manual && !l.deferred ? 'manual_proposed' as const : l.calc && l.calc.ok && !l.deferred ? 'boq' as const : 'none' as const, excludedScope: l.excluded?.scope, deferred: !!l.deferred }));
  for (const r of resolvedOnly) summaryLines.push({ key: `${r.componentId}|excl`, componentId: r.componentId, included: false, signedAmount: null, source: 'none', excludedScope: r.resolution.kind === 'excluded' ? r.resolution.scope : undefined });
  for (const r of deferredOnly) summaryLines.push({ key: `${r.componentId}|def`, componentId: r.componentId, included: true, signedAmount: null, source: 'none', deferred: true });
  // Components with no line at all remain unpriced included scope (unless excluded or deferred above).
  for (const u of unmatched) if (!summaryLines.some((s) => s.componentId === u.componentId)) summaryLines.push({ key: `${u.componentId}|none`, componentId: u.componentId, included: true, signedAmount: null, source: 'none' });
  const summary = summariseCost(summaryLines, currency);

  const valued = lines.filter((l) => l.valued && !l.excluded && !l.deferred && (l.manual || (l.calc && l.calc.ok)));
  const total: string | null = summary.pricedSubtotal;
  return { lines, needs: dedupe(needs), total, currency, pricedCount: valued.length, unmatched, potentials, rejectedModelRefs: rejected, summary, resolvedOnly, deferredOnly };
}

/**
 * Two components are the same work when their normalised name, action and location all agree. Different location,
 * different action (for example an omission against an addition) or a different name means separate changes.
 */
export function sameWork(a: ScopeComponent, b: ScopeComponent): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return n(a.name) === n(b.name) && a.action === b.action && n(a.location) === n(b.location);
}

function removeNeeds(needs: NeedsInput[], componentId: string, kinds?: NeedsInput['kind'][]): void {
  for (let i = needs.length - 1; i >= 0; i--) {
    const n = needs[i];
    if (n.componentId === componentId && (!kinds || kinds.includes(n.kind))) needs.splice(i, 1);
  }
}

/** A synthetic row for a manual rate with no BOQ match. It never carries a BOQ source and is case-specific. */
function manualItem(componentId: string, name: string, m: ManualRate): BoqItemRecord {
  return {
    id: `manual:${componentId}`, importId: '', caseId: '', sheet: 'Manual rate', rowNumber: 0, bill: 'Manual rate · Proposed', ref: 'MANUAL', description: name, unit: m.unit,
    rate: { state: 'value', value: m.value, text: m.value, cell: '', explicitZero: D(m.value).isZero(), formulaStatus: 'none' } as unknown as BoqItemRecord['rate'], quantity: { state: 'missing', text: '' } as BoqItemRecord['quantity'],
    cells: {}, sourceFile: 'Manual rate (case-specific)', sourceSha256: '', currency: m.currency,
  };
}

function dedupe(n: NeedsInput[]): NeedsInput[] {
  const seen = new Set<string>();
  return n.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

function lineFor(comp: ScopeComponent, item: BoqItemRecord, role: 'primary' | 'alternative', why: string, preambleNote: string, section: string, cand: RetrievedCandidate | undefined, answers: UserAnswers, rowId: string): RelatedLine {
  const override = answers.quantity[comp.id];
  const q = override ? { value: override.value, unit: override.unit, origin: 'user_entered' as const, source: 'Entered in the review', quote: '' } : comp.quantity;
  const base: RelatedLine = {
    key: `${comp.id}|${rowId}`, componentId: comp.id, componentName: comp.name, item, role, valued: role === 'primary', why, preambleNote, section,
    quantityText: q ? `${q.value} ${q.unit}` : '—', quantityOrigin: q ? originLabel(q.origin) : 'No quantity in the evidence', quantitySource: q ? q.source : '',
    calc: null, status: 'needs_input', statusNote: '', specConflict: cand?.specConflict ?? null, matchBasis: cand?.reasons ?? [],
  };
  if (role === 'alternative') return base;
  if (cand?.specConflict) { base.status = 'blocked'; base.statusNote = `Specification conflict: ${cand.specConflict}`; return base; }
  if (!q) { base.statusNote = 'No quantity is stated for this component.'; return base; }
  const d = answers.derivation[comp.id];
  const derivationInputs = d ? Object.entries(d.inputs).filter(([, v]) => v.value.trim()).map(([name, v]) => ({ name, value: v.value, unit: v.unit || 'm' })) : undefined;
  const direction = comp.action === 'omit' ? 'omission' : 'addition';
  const calc = calculateChange({ direction, quantity: q.value, quantityUnit: q.unit, item, derivationInputs, basis: d?.basis?.trim() ? { kind: 'user_confirmed', statement: d.basis } : null });
  base.calc = calc;
  if (calc.ok) { base.status = 'ready'; base.statusNote = comp.action === 'replace' || comp.action === 'rework' ? `Action “${comp.action}”: value the new work here; any omission of the old work needs its own line.` : ''; }
  else if (calc.kind === 'unpriced') { base.status = 'unpriced'; base.statusNote = calc.message; }
  else if (calc.kind === 'unit_mismatch') { base.status = 'needs_input'; base.statusNote = calc.message; }
  else { base.status = 'blocked'; base.statusNote = calc.message; }
  return base;
}

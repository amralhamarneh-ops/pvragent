import { tokenize, specTokens } from '@/lib/boq/retrieve';
import { isRetrievable } from './lifecycle';
import type { CurrentContext, PrecedentDecision, ReferenceCase, RetrievalResult, SuitabilityCheck } from './types';

/** Inputs that a precedent may inform but must never replace. Shown with every retrieval. */
export const NOT_REPLACED = [
  'Current drawing quantities',
  'Current contract BOQ rates',
  'Current schedule logic',
  'Current calendars',
  'Current productivity',
  'Current contract conditions',
];

const UNIT_FAMILIES: string[][] = [
  ['m', 'lm', 'rm', 'm1'], ['m2', 'sqm', 'm\u00b2'], ['m3', 'cum', 'm\u00b3'], ['no', 'nr', 'nos', 'each', 'ea', 'item'], ['kg', 'tonne', 't'],
];

function unitFamily(u: string): number {
  const n = u.toLowerCase().replace(/\s+/g, '');
  return UNIT_FAMILIES.findIndex((g) => g.includes(n));
}

function overlap(a: string, b: string): number {
  const A = new Set(tokenize(a)); const B = new Set(tokenize(b));
  if (A.size === 0 || B.size === 0) return 0;
  let hit = 0; A.forEach((t) => { if (B.has(t)) hit += 1; });
  return hit / Math.min(A.size, B.size);
}

/** Structured, explainable suitability checks. No hidden embedding; every judgement is visible to the reviewer. */
export function suitabilityChecks(c: ReferenceCase, q: CurrentContext): SuitabilityCheck[] {
  const r = c.record;
  const out: SuitabilityCheck[] = [];

  const ct = r.changeType.trim().toLowerCase(); const qt = q.changeType.trim().toLowerCase();
  out.push(!ct || !qt ? { name: 'Change type', result: 'unknown', detail: 'Change type missing on one side.' }
    : ct === qt ? { name: 'Change type', result: 'match', detail: `Both are "${r.changeType}".` }
    : { name: 'Change type', result: 'mismatch', detail: `Precedent is "${r.changeType}"; current is "${q.changeType}".` });

  const wo = overlap(r.workType, q.workType);
  out.push(!r.workType || !q.workType ? { name: 'Work type', result: 'unknown', detail: 'Work type missing on one side.' }
    : wo >= 0.6 ? { name: 'Work type', result: 'match', detail: `"${r.workType}" and "${q.workType}" overlap.` }
    : wo >= 0.3 ? { name: 'Work type', result: 'partial', detail: `"${r.workType}" only partly overlaps "${q.workType}".` }
    : { name: 'Work type', result: 'mismatch', detail: `"${r.workType}" is a different kind of work from "${q.workType}".` });

  const refSpecs = new Set(r.specifications.flatMap((s) => specTokens(s)));
  const curSpecs = specTokens(q.specification);
  if (refSpecs.size === 0 || curSpecs.length === 0) out.push({ name: 'Specification', result: 'unknown', detail: 'No comparable specification values.' });
  else {
    const shared = curSpecs.filter((s) => refSpecs.has(s));
    out.push(shared.length === curSpecs.length ? { name: 'Specification', result: 'match', detail: `Shared: ${shared.join(', ')}.` }
      : shared.length > 0 ? { name: 'Specification', result: 'partial', detail: `Shared ${shared.join(', ')}; differs on ${curSpecs.filter((s) => !refSpecs.has(s)).join(', ')}.` }
      : { name: 'Specification', result: 'mismatch', detail: `Precedent ${Array.from(refSpecs).join(', ')} vs current ${curSpecs.join(', ')}.` });
  }

  const refUnits = Array.from(new Set(r.quantities.map((x) => x.unit).filter(Boolean)));
  if (!q.unit || refUnits.length === 0) out.push({ name: 'Units', result: 'unknown', detail: 'Unit missing on one side.' });
  else {
    const qf = unitFamily(q.unit);
    const same = refUnits.some((u) => u.toLowerCase() === q.unit.toLowerCase());
    const sameFam = qf >= 0 && refUnits.some((u) => unitFamily(u) === qf);
    out.push(same ? { name: 'Units', result: 'match', detail: `Both measured in ${q.unit}.` }
      : sameFam ? { name: 'Units', result: 'partial', detail: `Same dimension (${refUnits.join(', ')} vs ${q.unit}).` }
      : { name: 'Units', result: 'mismatch', detail: `Precedent is measured in ${refUnits.join(', ')}; current is ${q.unit}. Quantities cannot be compared.` });
  }

  const pc = overlap(r.projectContext, q.projectContext);
  out.push(!r.projectContext || !q.projectContext ? { name: 'Project context', result: 'unknown', detail: 'Context missing on one side.' }
    : pc >= 0.4 ? { name: 'Project context', result: 'match', detail: 'Comparable project type.' }
    : pc >= 0.15 ? { name: 'Project context', result: 'partial', detail: 'Loosely comparable project type.' }
    : { name: 'Project context', result: 'mismatch', detail: 'Different project type.' });

  const sc = overlap(`${r.schedule.simulationSettings} ${r.productivity.calendar}`, q.scheduleConditions);
  out.push(!q.scheduleConditions ? { name: 'Schedule conditions', result: 'unknown', detail: 'No current schedule conditions given.' }
    : sc >= 0.4 ? { name: 'Schedule conditions', result: 'match', detail: 'Comparable calendar or logic conditions.' }
    : sc >= 0.15 ? { name: 'Schedule conditions', result: 'partial', detail: 'Some comparable schedule conditions.' }
    : { name: 'Schedule conditions', result: 'mismatch', detail: 'Schedule conditions differ.' });
  return out;
}

const WEIGHT = { match: 1, partial: 0.5, unknown: 0.25, mismatch: 0 } as const;
const MIN_SCORE = 0.55;

function influenceFor(c: ReferenceCase, checks: SuitabilityCheck[]): string {
  const parts: string[] = [];
  parts.push(`Interpretation: "${c.record.changeType}" for "${c.record.workType}" was handled as ${c.record.reasoning.slice(0, 160) || 'documented in the case'}.`);
  if (c.record.boqMappings[0]) parts.push(`Suggested method: map the quantity to a BOQ item by ${c.record.boqMappings[0].rateBasis || 'rate basis'} (the current BOQ rate still applies).`);
  if (c.record.activityMappings[0]) parts.push(`Suggested method: look for activities like "${c.record.activityMappings[0].name}" (${c.record.activityMappings[0].rationale.slice(0, 100)}).`);
  if (checks.some((k) => k.result === 'partial')) parts.push('Treat as a partial precedent; review the differing checks.');
  return parts.join(' ');
}

/**
 * Retrieve precedents for a new assessment. Only approved, learning-partition, current-version cases are eligible.
 * A case is REJECTED (with a reason the reviewer can read) when a decisive check mismatches or its score is too low.
 * The result never contains figures that could replace the current project's quantities, rates, logic, calendars or productivity.
 */
export function retrieveReferences(all: ReferenceCase[], q: CurrentContext, opts: { limit?: number; includeIneligible?: boolean } = {}): RetrievalResult {
  const used: PrecedentDecision[] = []; const rejected: PrecedentDecision[] = [];
  for (const c of all) {
    if (!isRetrievable(c)) {
      if (opts.includeIneligible) rejected.push(decision(c, [], 0, 'rejected', c.replacedBy ? 'Replaced by a newer version.' : `Not eligible: status is "${c.status.replace('_', ' ')}"${c.partition === 'evaluation' ? ' and it is reserved for evaluation' : ''}.`, ''));
      continue;
    }
    const checks = suitabilityChecks(c, q);
    const score = checks.reduce((s, k) => s + WEIGHT[k.result], 0) / checks.length;
    const decisive = checks.find((k) => (k.name === 'Work type' || k.name === 'Units' || k.name === 'Change type') && k.result === 'mismatch');
    if (decisive) { rejected.push(decision(c, checks, score, 'rejected', `${decisive.name} mismatch: ${decisive.detail}`, '')); continue; }
    if (score < MIN_SCORE) { rejected.push(decision(c, checks, score, 'rejected', `Overall similarity ${(score * 100).toFixed(0)}% is below the ${(MIN_SCORE * 100).toFixed(0)}% threshold.`, '')); continue; }
    used.push(decision(c, checks, score, 'used', 'Suitable as supporting precedent.', influenceFor(c, checks)));
  }
  used.sort((a, b) => b.score - a.score);
  const kept = used.slice(0, opts.limit ?? 3);
  return {
    query: q, used: kept, rejected, noSuitableReference: kept.length === 0,
    statement: kept.length === 0
      ? 'No suitable approved reference case exists for this assessment. The assessment proceeds on the current project evidence alone.'
      : `${kept.length} approved reference case${kept.length === 1 ? '' : 's'} informed interpretation. They did not replace the current project's quantities, rates, schedule logic, calendars, productivity or contract conditions.`,
    notReplaced: NOT_REPLACED,
  };
}

function decision(c: ReferenceCase, checks: SuitabilityCheck[], score: number, d: 'used' | 'rejected', reason: string, influence: string): PrecedentDecision {
  return {
    referenceId: c.id, title: c.title, version: c.version, score, decision: d, checks, reason, influence,
    citations: c.sources.filter((s) => ['pvr_narrative', 'outcome', 'boq', 'schedule_post', 'drawing_revised'].includes(s.role)).map((s) => ({ sourceId: s.id, fileName: s.fileName, locator: c.record.geometryRefs.find((g) => g.sourceId === s.id)?.locator ?? s.role })),
  };
}

/** Compact, citation-bearing block for an agent prompt. Contains no quantities or rates that an agent could adopt. */
export function precedentPromptBlock(r: RetrievalResult): string {
  if (r.noSuitableReference) return '<reference_precedents>\nNo suitable approved reference case exists. Do not invent precedents.\n</reference_precedents>';
  const lines = r.used.map((p, i) => `[R${i + 1}] ${p.title} (v${p.version}, id ${p.referenceId}). ${p.influence} Sources: ${p.citations.map((c) => c.fileName).join('; ')}.`);
  return `<reference_precedents>\nThese are NON-AUTHORITATIVE precedents from reviewed historical cases. They may support interpretation and suggest a method. They must NOT supply or replace: ${NOT_REPLACED.join(', ')}. Cite as [R#] when used.\n${lines.join('\n')}\n</reference_precedents>`;
}

/** Validate that the citations an agent returned refer to real, retrieved precedents. Unknown ones are dropped and reported. */
export function validateCitations(cited: string[], r: RetrievalResult): { valid: string[]; invalid: string[] } {
  const ids = new Set(r.used.map((_, i) => `R${i + 1}`));
  const valid: string[] = []; const invalid: string[] = [];
  cited.forEach((c) => { const k = c.replace(/[\[\]\s]/g, ''); (ids.has(k) ? valid : invalid).push(c); });
  return { valid, invalid };
}

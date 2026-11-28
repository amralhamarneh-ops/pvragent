import type { ScheduleActivity, ScheduleModel, ScheduleRelationship } from './types';

/**
 * Agent-led activity mapping for real cases.
 *
 * Pipeline: interpret each costed line as a work operation -> retrieve candidates across the whole imported schedule
 * (broadening when metadata is thin) -> rank semantically -> validate against construction sequence, activity type
 * and progress -> propose automatically -> raise targeted questions only for what stays uncertain.
 *
 * Nothing here knows any project, WBS name, bill number or chainage. It reads only what is in the imported file.
 */

export interface WorkLine {
  /** Stable line id (see lineKey). */
  lineId: string;
  componentId: string;
  name: string;
  description: string;
  specification: string;
  location: string;
  discipline: string;
  workType: string;
  searchTerms: string[];
  quantity: string | null;
  unit: string;
  action: 'add' | 'omit' | 'replace' | 'rework';
  /** True when the line carries execution quantity (excavation, paving...). Cost-only lines never need an activity. */
  executes: boolean;
}

export type OperationPhase = 'enabling' | 'earthworks' | 'drainage' | 'structure' | 'pavement' | 'finishes' | 'services' | 'testing' | 'handover' | 'other';

const PHASE_ORDER: OperationPhase[] = ['enabling', 'earthworks', 'drainage', 'structure', 'pavement', 'finishes', 'services', 'testing', 'handover'];

const PHASE_WORDS: Record<OperationPhase, string[]> = {
  enabling: ['mobilis', 'mobiliz', 'survey', 'setting out', 'clearing', 'demolition', 'site establishment', 'temporary', 'diversion'],
  earthworks: ['excavat', 'earthwork', 'cut', 'fill', 'embankment', 'trench', 'grading', 'subgrade', 'formation', 'compaction', 'backfill'],
  drainage: ['drain', 'culvert', 'pipe', 'manhole', 'gully', 'stormwater', 'catchpit', 'sewer'],
  structure: ['concrete', 'reinforc', 'formwork', 'foundation', 'footing', 'pile', 'column', 'slab', 'wall', 'retaining', 'bridge', 'rebar'],
  pavement: ['subbase', 'sub-base', 'base course', 'basecourse', 'binder', 'asphalt', 'wearing', 'pavement', 'paving', 'surfacing', 'bituminous', 'macadam'],
  finishes: ['kerb', 'curb', 'landscap', 'plant', 'marking', 'signage', 'sign', 'barrier', 'fence', 'paint', 'finish', 'tile'],
  services: ['lighting', 'cable', 'duct', 'conduit', 'electrical', 'mechanical', 'hvac', 'plumb', 'fire'],
  testing: ['test', 'commission', 'inspection', 'snag', 'as-built', 'as built', 'approval'],
  handover: ['handover', 'hand over', 'hand-over', 'completion', 'practical completion', 'taking over', 'opening'],
  other: [],
};

export function phaseOf(text: string): OperationPhase {
  const t = text.toLowerCase();
  let best: OperationPhase = 'other';
  let bestHits = 0;
  for (const p of PHASE_ORDER) {
    const hits = PHASE_WORDS[p].filter((w) => t.includes(w)).length;
    if (hits > bestHits) { best = p; bestHits = hits; }
  }
  return best;
}

const STOP = new Set(['existing', 'roadside', 'system', 'systems', 'construction', 'operation', 'the', 'and', 'of', 'to', 'a', 'in', 'for', 'at', 'with', 'by', 'on', 'new', 'additional', 'extra', 'supply', 'install', 'provide', 'including', 'all', 'complete', 'as', 'per', 'from', 'or', 'an', 'be', 'is', 'work', 'works']);
const SYN: string[][] = [
  ['asphalt', 'bituminous', 'blacktop', 'wearing', 'macadam', 'surfacing'],
  ['kerb', 'curb', 'kerbstone'],
  ['excavation', 'excavate', 'cut', 'earthwork', 'earthworks', 'trench', 'dig'],
  ['fill', 'backfill', 'embankment', 'compaction', 'compacted'],
  ['subbase', 'sub-base', 'base', 'basecourse', 'aggregate', 'granular'],
  ['pavement', 'carriageway', 'road', 'roadway', 'paving'],
  ['lighting', 'luminaire', 'lamp', 'streetlight', 'light'],
  ['drainage', 'drain', 'culvert', 'pipe', 'stormwater', 'gully', 'manhole'],
  ['concrete', 'rc', 'reinforced', 'insitu'],
  ['reinforcement', 'rebar', 'steel'],
  ['formwork', 'shuttering'],
  ['marking', 'markings', 'paint', 'thermoplastic'],
];
const SYN_INDEX = new Map<string, number>();
SYN.forEach((g, i) => g.forEach((w) => { if (!SYN_INDEX.has(w)) SYN_INDEX.set(w, i); }));

function canonical(s: string): string {
  return s.toLowerCase().replace(/\b(?:guard|gaurd)[\s-]*rails?\b/g, 'guardrail')
    .replace(/\b(?:recycled|recycle|reclaimed|treated effluent)\s+water\b/g, 'recycled water')
    .replace(/\bcrush\s+cushion\b/g, 'crash cushion');
}

function tokens(s: string): string[] {
  return canonical(s).replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).map((t) => t.replace(/^-+|-+$/g, '')).filter((t) => t.length > 1 && !STOP.has(t));
}
const stem = (t: string) => (t.length > 4 ? t.replace(/(ing|ed|es|s)$/, '') : t);
const groupsOf = (ts: string[]) => { const g = new Set<number>(); for (const t of ts) { const i = SYN_INDEX.get(t) ?? SYN_INDEX.get(stem(t)); if (i !== undefined) g.add(i); } return g; };

/** Structured identifiers avoid matching "Bridge 94A" with "Bridge 94B" or "IC91" with "IC92". */
function locationsIn(text: string): Map<string, Set<string>> {
  const values = new Map<string, Set<string>>();
  const add = (kind: string, value: string) => {
    const set = values.get(kind) ?? new Set<string>();
    set.add(value.toLowerCase().replace(/^0+(?=\d)/, ''));
    values.set(kind, set);
  };
  const id = /\b(interchange(?:\s+ic)?|ic|bridge|br|zone|ramp|loop|section|pier|abutment)\s*[-:.]?\s*(\d+[a-z]?|[a-z])\b/gi;
  for (const m of text.matchAll(id)) {
    const kind = m[1].toLowerCase();
    add(kind === 'ic' || kind.startsWith('interchange') ? 'interchange' : kind === 'br' ? 'bridge' : kind, m[2]);
  }
  for (const m of text.matchAll(/\b(left|right)[ -]+(?:hand[ -]+)?side\b|\b(lhs|rhs)\b/gi)) add('side', (m[1] ?? m[2][0]).toLowerCase()[0]);
  return values;
}

/** Parse explicitly stated station values from common chainage and kilometre formats. */
export function stationsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\b(\d{1,3})\s*\+\s*(\d{3})\b/gi)) out.push(Number(m[1]) * 1000 + Number(m[2]));
  for (const m of text.matchAll(/\bkm\.?\s*(\d{1,3}(?:\.\d+)?)\b(?!\s*\+)/gi)) out.push(Math.round(Number(m[1]) * 1000));
  return out;
}

type Operation = 'install' | 'remove' | 'relocate' | 'procure' | 'test';
function operationIn(text: string): Operation | null {
  const t = canonical(text);
  if (/\b(?:relocat\w*|divert\w*|diversion|reposition\w*)\b/.test(t)) return 'relocate';
  if (/\b(?:remov\w*|demoli\w*|dismantl\w*|break[ -]?out|strip[ -]?out)\b/.test(t)
    && !/\b(?:install\w*|construct\w*|laying|lay)\b/.test(t)) return 'remove';
  if (/\b(?:procur\w*|purchase\w*|deliver\w*|fabricat\w*|material submittal\w*)\b/.test(t)
    && !/\b(?:install\w*|construct\w*|laying|lay)\b/.test(t)) return 'procure';
  if (/\b(?:as[ -]?built|commission\w*|testing|inspection)\b/.test(t)
    && !/\b(?:install\w*|construct\w*|laying|lay)\b/.test(t)) return 'test';
  if (/\b(?:instal\w*|construct\w*|erect\w*|laying|lay|fixing|fix|placement)\b/.test(t)) return 'install';
  return null;
}

const ASSETS: [string, RegExp][] = [
  ['barrier transition', /\b(?:barrier|guardrail)(?:\s+[a-z]+){0,4}\s+transition\w*\b|\btransition\w*(?:\s+[a-z]+){0,4}\s+(?:barrier|guardrail)\b/],
  ['crash cushion', /\bcrash cushion\b/],
  ['end terminal', /\b(?:end terminals?|crashworthy terminals?)\b/],
  ['guardrail', /\bguardrail\b|\b(?:roadside barrier|vehicle restraint system|road restraint system)\w*\b/],
  ['recycled water', /\brecycled water\b|\b(?:tse|treated sewage effluent)\b/],
  ['irrigation', /\birrigation\b/],
  ['potable water', /\b(?:potable|drinking) water\b/],
  ['stormwater', /\bstorm[ -]?water\b|\bstorm drainage\b/],
  ['sewer', /\b(?:sewer\w*|foul water|wastewater)\b/],
];
const BARRIER_SUBTYPES = ['barrier transition', 'crash cushion', 'end terminal', 'guardrail'];
const UTILITIES = ['recycled water', 'irrigation', 'potable water', 'stormwater', 'sewer'];
function assetsIn(text: string): Set<string> {
  const t = canonical(text);
  const tags = new Set(ASSETS.filter(([, pattern]) => pattern.test(t)).map(([name]) => name));
  if (tags.has('barrier transition') || tags.has('end terminal')) tags.delete('guardrail');
  return tags;
}
function specsIn(text: string): Map<string, Set<string>> {
  const specs = new Map<string, Set<string>>();
  const set = (name: string, val: string) => {
    const values = specs.get(name) ?? new Set<string>();
    values.add(val.toLowerCase());
    specs.set(name, values);
  };
  for (const m of text.matchAll(/\bTL\s*[- ]?\s*([1-6])\b/gi)) set('test level', m[1]);
  for (const m of text.matchAll(/(?:[Øø⌀%]|\bDN\s*|\bdiameter\s+)(\d{2,4})\s*(?:mm)?\b/gi)) set('diameter', m[1]);
  for (const m of text.matchAll(/\b(HDPE|uPVC|PVC|GRP|ductile iron)\b/gi)) set('material', m[1]);
  return specs;
}

interface MatchEvidence { violations: string[]; review: string[]; reasons: string[]; bonus: number }
function evidenceFor(line: WorkLine, a: ScheduleActivity): MatchEvidence {
  const primary = [line.name, line.workType, line.description, line.specification].join(' ');
  const tags = assetsIn(primary);
  // Positive evidence can come from the activity, its WBS or its local codes. A project's title
  // (the top WBS) is not location/work evidence for all of its individual tasks.
  const path = (a.wbsPath?.length ? a.wbsPath : a.wbs.split(' / '));
  const entries = Object.entries(a.activityCodes ?? {});
  const costCodes = entries.filter(([key]) => /\bcost\b|\bboq\b|\bbudget\b/i.test(key)).map(([,v]) => v).join(' ');
  const codes = entries.filter(([key]) => !/\bcost\b|\bboq\b|\bbudget\b/i.test(key)).map(([,v]) => v).join(' ');
  const contextPath = path.length > 1 ? path.slice(1).join(' / ') : (path[0] ?? '');
  const locText = [a.name, contextPath, codes, a.zone, ...Object.values(a.udf ?? {})].join(' ');
  const localScope = assetsIn([a.name, contextPath, codes].join(' '));
  const ownScope = assetsIn(a.name);
  const intersect = (a: Iterable<string>, b: Set<string>) => [...a].some((x) => b.has(x));
  const e: MatchEvidence = { violations: [], review: [], reasons: [], bonus: 0 };
  const op = operationIn(primary);
  const actOp = operationIn(a.name);
  if (actOp && op && actOp !== op) {
    if (['remove', 'procure', 'test'].includes(actOp) || (actOp === 'install' && ['remove', 'test', 'procure'].includes(op))) {
      e.violations.push(`Activity is ${actOp} work, but this change concerns ${op} work.`);
    } else {
      e.review.push(`Confirm that this ${actOp} activity can carry the ${op} scope, rather than relying on a different existing operation.`);
    }
  } else if (!op && actOp === 'remove' && line.action !== 'omit') {
    e.violations.push('Activity removes existing assets; it does not install or add this work.');
  } else if (op && actOp === op) {
    e.bonus += 1;
    e.reasons.push(`execution action matches: ${op}`);
  }
  // A commercial omission may remove planned installation from scope, which is not site demolition.
  if (line.action === 'omit' && !op && actOp === 'remove') {
    e.review.push('Confirm this is physical removal, not an omission of planned installation.');
  }

  const targetBarrier = BARRIER_SUBTYPES.filter((x) => tags.has(x));
  const ownBarrier = new Set(BARRIER_SUBTYPES.filter((x) => ownScope.has(x)));
  if (targetBarrier.length && ownBarrier.size && !intersect(targetBarrier, ownBarrier))
    e.violations.push(`Activity describes a different roadside asset (${[...ownBarrier].join(', ')}).`);

  const targetUtility = UTILITIES.filter((x) => tags.has(x));
  const ownUtility = new Set(UTILITIES.filter((x) => ownScope.has(x)));
  const contextUtility = new Set(UTILITIES.filter((x) => localScope.has(x)));
  const utility = ownUtility.size ? ownUtility : contextUtility;
  if (targetUtility.length && utility.size && !intersect(targetUtility, utility))
    e.violations.push(`Activity describes a different utility (${[...utility].join(', ')}).`);
  const genericPipeCarrier = /\b(?:pipe\w*|irrigat\w*|water (?:main|line|network|supply))\b/.test(canonical(a.name));
  if (targetUtility.length && !genericPipeCarrier && !ownUtility.size)
    e.violations.push('The activity has no utility installation, relocation or pipe scope of its own.');
  else if (targetUtility.length && genericPipeCarrier && !ownUtility.size)
    e.reasons.push('possible utility activity; service needs verification');
  if (targetBarrier.length && !ownBarrier.size)
    e.violations.push('The activity does not describe the required roadside asset in its work scope.');
  const requiredAssets = tags.has('recycled water') ? [...tags].filter((x) => x !== 'irrigation') : [...tags];
  for (const asset of requiredAssets) {
    if (localScope.has(asset)) { e.bonus += 0.65; e.reasons.push(`scope evidenced: ${asset}`); }
    else e.review.push(`No evidence that this activity covers ${asset}.`);
  }

  const targetLoc = locationsIn(line.location);
  const inlineLoc = locationsIn(`${line.name} ${line.description}`);
  for (const [kind, vals] of inlineLoc) if (!targetLoc.has(kind)) targetLoc.set(kind, vals);
  const activityLoc = locationsIn(locText);
  const costLoc = locationsIn(costCodes);
  let actualLocationMatch = false;
  for (const [kind, requested] of targetLoc) {
    const actual = activityLoc.get(kind);
    if (!actual?.size) {
      const commercial = costLoc.get(kind);
      if (commercial && intersect(requested, commercial)) {
        e.bonus += 0.8;
        e.reasons.push(`related cost area: ${kind} ${[...requested].join(', ')}`);
        e.review.push(`Only the cost code indicates ${kind} ${[...requested].join(', ')}; verify the work location.`);
      } else e.review.push(`The schedule activity does not confirm ${kind} ${[...requested].join(', ')}.`);
    }
    else if (!intersect(requested, actual))
      e.violations.push(`Different ${kind}: change ${[...requested].join(', ')}, activity ${[...actual].join(', ')}.`);
    else if (actual.size > 1 || (requested.size > 1 && [...requested].some((x) => !actual.has(x))))
      e.review.push(`Multiple ${kind} values are stated; verify the exact work location and any quantity split.`);
    else { actualLocationMatch = true; e.bonus += 1.6; e.reasons.push(`same ${kind}: ${[...requested].join(', ')}`); }
  }
  const range = (v: number[]) => [Math.min(...v), Math.max(...v)];
  const lineStations = stationsIn(`${line.location} ${line.description} ${line.name}`);
  if (lineStations.length) {
    const actual = stationsIn(locText);
    if (!actual.length) e.review.push('No activity chainage is stated.');
    else {
      const [a, b] = range(actual); const [l, h] = range(lineStations);
      if (h < a || l > b) e.violations.push('The stated chainage does not overlap the activity range.');
      else if (l < a || h > b) e.review.push('This activity only covers part of the stated chainage; a measured split is required.');
      else { e.bonus += 1.2; e.reasons.push('Stated chainage is covered by the activity.'); }
    }
  }
  if (line.location.trim() && !targetLoc.size && !lineStations.length) {
    const requested = tokens(line.location).map(stem);
    const actual = new Set(tokens(locText).map(stem));
    if (requested.length && !requested.every((x) => actual.has(x)))
      e.review.push(`The schedule activity does not confirm location "${line.location}".`);
  }
  if (targetLoc.size && !actualLocationMatch && requiredAssets.length && !intersect(requiredAssets, localScope))
    e.violations.push('Neither the specified asset nor the work location is evidenced by this activity.');
  const actualSpecs = specsIn([a.name, contextPath, codes].join(' '));
  for (const [kind, requested] of specsIn(primary)) {
    const actual = actualSpecs.get(kind);
    if (!actual?.size)
      e.review.push(`Activity does not confirm the ${kind} (${[...requested].join(', ')}).`);
    else if (!intersect(requested, actual))
      e.violations.push(`Different ${kind}: change ${[...requested].join(', ')}, activity ${[...actual].join(', ')}.`);
    else if (actual.size > 1 || requested.size > 1)
      e.review.push(`Multiple ${kind} values are stated; confirm which scope the activity represents.`);
    else { e.bonus += 0.6; e.reasons.push(`same ${kind}: ${[...requested].join(', ')}`); }
  }
  return e;
}

export interface ActivityBrief {
  id: string;
  taskId: string;
  code: string;
  name: string;
  wbsPath: string;
  kind: NonNullable<ScheduleActivity['kind']>;
  status: NonNullable<ScheduleActivity['status']>;
  progressPct: number;
  start: string;
  finish: string;
  actualStart: string;
  actualFinish: string;
  phase: OperationPhase;
}

export function briefOf(a: ScheduleActivity): ActivityBrief {
  return {
    id: a.taskId ?? a.id, taskId: a.taskId ?? a.id, code: a.id, name: a.name, wbsPath: a.wbs,
    kind: a.kind ?? 'task', status: a.status ?? (a.progressPct >= 100 ? 'completed' : a.progressPct > 0 ? 'in_progress' : 'not_started'),
    progressPct: a.progressPct, start: a.start, finish: a.finish, actualStart: a.actualStart ?? '', actualFinish: a.actualFinish ?? '',
    phase: phaseOf(`${a.name} ${a.wbs} ${Object.values(a.activityCodes ?? {}).join(' ')}`),
  };
}

/** Milestones, WBS/summary rows and level-of-effort cannot carry execution quantity or productivity duration. */
export function cannotReceiveExecution(a: Pick<ActivityBrief, 'kind'>): string | null {
  switch (a.kind) {
    case 'milestone_start': case 'milestone_finish': return 'It is a milestone: it has no duration or work content to absorb a quantity. It can only be affected downstream.';
    case 'wbs_summary': case 'summary': return 'It is a summary row: quantities belong to the detailed activities beneath it.';
    case 'level_of_effort': return 'It is level-of-effort: its duration follows other activities and is not driven by installed quantity.';
    default: return null;
  }
}

export interface Candidate {
  activity: ActivityBrief;
  score: number;
  reasons: string[];
  /** Hard rules that make this a poor target. Valid candidates have none. */
  violations: string[];
  /** Missing scope/location evidence: keep shortlisted, but never allocate automatically. */
  review: string[];
  /** Soft warnings that do not disqualify. */
  cautions: string[];
  eligible: boolean;
  /** True for the "new work beyond completed work" case. */
  completed: boolean;
}

export interface RetrievalOptions { limit?: number; broaden?: boolean }

/**
 * Retrieve and rank candidates for one line across the entire schedule. The broader shortlist
 * may include weaker candidates for review but never bypasses an action, scope or location check.
 */
export function retrieveActivities(line: WorkLine, model: ScheduleModel, opts: RetrievalOptions = {}): { candidates: Candidate[]; broadened: boolean } {
  const limit = opts.limit ?? 6;
  const ranked = rank(line, model);
  if (!opts.broaden && ranked.some((c) => c.eligible && c.review.length === 0 && c.score >= MED))
    return { candidates: ranked.filter((c) => c.score > 0.5).slice(0, limit), broadened: false };
  return { candidates: ranked.slice(0, limit), broadened: true };
}

function rank(line: WorkLine, model: ScheduleModel): Candidate[] {
  const queryText = [line.name, line.description, line.workType, line.specification, ...line.searchTerms].join(' ');
  const qTok = Array.from(new Set(tokens(queryText).map(stem)));
  const qGroups = groupsOf(tokens(queryText));
  const linePhase = phaseOf(`${line.name} ${line.workType} ${line.description}`);

  const out: Candidate[] = [];

  for (const a of model.activities) {
    const b = briefOf(a);
    const own = `${a.name} ${Object.values(a.activityCodes ?? {}).join(' ')}`;
    const ctx = `${a.wbs} ${Object.values(a.udf ?? {}).join(' ')}`;
    const ownTok = new Set(tokens(own).map(stem));
    const ctxTok = new Set(tokens(ctx).map(stem));
    const ownGroups = groupsOf(tokens(own));
    const ctxGroups = groupsOf(tokens(ctx));
    const reasons: string[] = [];
    const cautions: string[] = [];
    const violations: string[] = [];
    let score = 0;

    const exact = qTok.filter((t) => ownTok.has(t));
    if (exact.length) { score += Math.min(3, exact.length * 0.9); reasons.push(`activity name shares: ${exact.slice(0, 4).join(', ')}`); }
    const syn = [...qGroups].filter((g) => ownGroups.has(g) && !exact.some((t) => (SYN_INDEX.get(t) ?? -1) === g));
    if (syn.length) { score += 0.8 * syn.length; reasons.push('same work type through different wording'); }
    const ctxHit = qTok.filter((t) => ctxTok.has(t) && !ownTok.has(t));
    const ctxSyn = [...qGroups].filter((g) => ctxGroups.has(g) && !ownGroups.has(g));
    if (ctxHit.length || ctxSyn.length) { score += Math.min(1.2, ctxHit.length * 0.4 + ctxSyn.length * 0.4); reasons.push('WBS / codes relate to the work'); }

    // Construction sequence: the operation phase of the line should match the activity's phase.
    if (linePhase !== 'other' && b.phase !== 'other') {
      if (linePhase === b.phase) { score += 1.2; reasons.push(`same construction phase (${linePhase})`); }
      else {
        const gap = Math.abs(PHASE_ORDER.indexOf(linePhase) - PHASE_ORDER.indexOf(b.phase));
        if (gap >= 2) { score -= 1.5; cautions.push(`activity looks like ${b.phase}, the line is ${linePhase}`); }
      }
    }

    const evidence = evidenceFor(line, a);
    score += evidence.bonus;
    reasons.push(...evidence.reasons);
    violations.push(...evidence.violations);

    // Hard validation: kind and completion.
    const kindBlock = line.executes ? cannotReceiveExecution(b) : null;
    if (kindBlock) violations.push(kindBlock);
    const completed = b.status === 'completed';
    if (completed && line.executes) cautions.push('Already complete: actual dates and completed work are not changed. New scope needs a new activity.');
    if (b.status === 'in_progress' && line.executes) cautions.push(`In progress (${b.progressPct}%): the added quantity applies to the remaining work only.`);

    // A handover-phase activity never matches an execution operation.
    if (line.executes && b.phase === 'handover' && linePhase !== 'handover') { if (!violations.length) violations.push('It is a handover/completion activity, not an execution activity.'); }

    const workEvidence = exact.length > 0 || syn.length > 0 || evidence.reasons.some((r) => r.startsWith('scope evidenced:') || r.startsWith('possible utility activity'));
    if (!workEvidence) continue;  // Location or generic phase alone is not an activity match.
    if (score <= 0.2) continue;
    out.push({ activity: b, score: Math.round(score * 100) / 100, reasons, violations, review: evidence.review, cautions, eligible: violations.length === 0 && !completed, completed });
  }
  return out.sort((x, y) => Number(y.eligible) - Number(x.eligible) || Number(x.review.length > 0) - Number(y.review.length > 0) || y.score - x.score || x.activity.code.localeCompare(y.activity.code));
}

// ---------------------------------------------------------------------------------------------
// Proposals, allocation and questions
// ---------------------------------------------------------------------------------------------

export type MappingState = 'proposed' | 'needs_question' | 'new_activity' | 'not_applicable' | 'deferred' | 'excluded' | 'accepted';

export interface Allocation {
  /** Internal task id of the target activity. */
  activityTaskId: string;
  activityCode: string;
  activityName: string;
  /** Fraction of the line's quantity placed on this activity, as a decimal string in 0..1. */
  share: string;
  /** Quantity actually allocated (same unit as the line). Null when the line has no quantity. */
  quantity: string | null;
  basis: 'automatic' | 'user';
}

export interface NewActivityProposal {
  name: string;
  wbsPath: string;
  predecessors: { code: string; name: string; type: 'FS' | 'SS' }[];
  successors: { code: string; name: string; type: 'FS' }[];
  reason: string;
  /** Duration is never invented: it needs a productivity basis. */
  durationBasis: 'needs_productivity' | 'user_entered';
}

export interface Question {
  id: string;
  lineId: string;
  title: string;
  /** Exactly what is missing. */
  missing: string;
  options: { id: string; label: string; activityTaskId?: string }[];
}

export interface LineMapping {
  lineId: string;
  componentId: string;
  name: string;
  state: MappingState;
  allocations: Allocation[];
  candidates: Candidate[];
  broadened: boolean;
  newActivity: NewActivityProposal | null;
  explanation: string;
  question: Question | null;
  /** Downstream activities affected without receiving quantity (e.g. a handover milestone). */
  downstream: { code: string; name: string; kind: string }[];
  confidence: 'high' | 'medium' | 'low';
}

export interface MappingUserChoice {
  /** Activities the user forced for this line (internal task ids). Validated again before use. */
  activityTaskIds?: string[];
  shares?: Record<string, string>;
  wantsNewActivity?: boolean;
  newActivityName?: string;
  state?: 'deferred' | 'not_applicable' | 'excluded';
  reason?: string;
}

export type MappingChoices = Record<string, MappingUserChoice>;

export function cannotAssignProgrammeWork(line: WorkLine, activity: ScheduleActivity) {
  const brief=briefOf(activity);
  return cannotReceiveExecution(brief) ?? evidenceFor(line,activity).violations[0] ?? (brief.status==='completed'?'Already completed.':null);
}

const HIGH = 3.6;
const MED = 2.2;

/** Map one line. Pure and deterministic; the semantic text pass is inside retrieveActivities. */
export function mapLine(line: WorkLine, model: ScheduleModel, choice?: MappingUserChoice, opts: { broaden?: boolean } = {}): LineMapping {
  const base = { lineId: line.lineId, componentId: line.componentId, name: line.name };
  if (choice?.state) {
    return { ...base, state: choice.state, allocations: [], candidates: [], broadened: false, newActivity: null, explanation: choice.reason ? `${labelState(choice.state)}: ${choice.reason}` : labelState(choice.state), question: null, downstream: [], confidence: 'low' };
  }
  if (!line.executes) {
    return { ...base, state: 'not_applicable', allocations: [], candidates: [], broadened: false, newActivity: null, explanation: 'This line has no execution quantity, so it does not need an activity.', question: null, downstream: [], confidence: 'high' };
  }

  const { candidates, broadened } = retrieveActivities(line, model, { broaden: opts.broaden });
  const byTask = new Map(model.activities.map((a) => [a.taskId ?? a.id, a]));

  // User-forced targets are re-validated: a milestone or summary can never be accepted.
  if (choice?.activityTaskIds?.length) {
    const ok: Allocation[] = []; const rejected: string[] = [];
    for (const tid of new Set(choice.activityTaskIds)) {
      const a = byTask.get(tid);
      if (!a) { rejected.push(`${tid} is not in the imported schedule`); continue; }
      const why = cannotReceiveExecution(briefOf(a)) ?? evidenceFor(line, a).violations[0];
      if (why) { rejected.push(`${a.id} ${a.name}: ${why}`); continue; }
      if (briefOf(a).status === 'completed') { rejected.push(`${a.id} ${a.name}: it is complete, so its actual dates and quantities are not changed. Propose a new activity instead.`); continue; }
      ok.push({ activityTaskId: tid, activityCode: a.id, activityName: a.name, share: '0', quantity: null, basis: 'user' });
    }
    if (ok.length && !rejected.length) {
      const percentages = ok.map((a) => Number(choice.shares?.[a.activityTaskId]));
      if (ok.length > 1 && (percentages.some((x) => !Number.isFinite(x) || x <= 0) || Math.abs(percentages.reduce((sum, x) => sum + x, 0) - 100) > 0.000001)) {
        return { ...base, state: 'needs_question', allocations: [], candidates, broadened, newActivity: null, explanation: 'Enter a supported allocation percentage for each selected activity, totaling 100%. No equal split is assumed.', question: null, downstream: [], confidence: 'low' };
      }
      const allocs = allocate(ok, line.quantity, choice.shares);
      return { ...base, state: 'accepted', allocations: allocs, candidates, broadened, newActivity: null, explanation: 'Your selection.', question: null, downstream: downstreamOf(allocs.map((x) => x.activityTaskId), model), confidence: 'high' };
    }
    return { ...base, state: 'needs_question', allocations: [], candidates, broadened, newActivity: null, explanation: `Selection rejected: ${rejected.join('; ')}`, question: questionFor(line, candidates, 'The selected activity cannot take this work.'), downstream: [], confidence: 'low' };
  }

  const eligible = candidates.filter((c) => c.eligible);
  const completedBest = candidates.find((c) => c.completed && !c.violations.length && !c.review.length && c.score >= MED);

  if (choice?.wantsNewActivity) return newActivityMapping(line, model, base, candidates, broadened, completedBest, choice.newActivityName);

  if (eligible.length === 0) {
    // Completed work cannot take new scope: propose a new activity/fragnet beside it.
    if (completedBest) return newActivityMapping(line, model, base, candidates, broadened, completedBest);
    const blocked = candidates.find((c) => c.violations.length > 0);
    return {
      ...base, state: 'needs_question', allocations: [], candidates, broadened, newActivity: null,
      explanation: blocked ? `Best textual match ${blocked.activity.code} ${blocked.activity.name} cannot take the work: ${blocked.violations[0]}` : 'No activity in the imported schedule resembles this work.',
      question: questionFor(line, candidates, blocked ? blocked.violations[0] : missingFor(line, model)),
      downstream: [], confidence: 'low',
    };
  }

  const top = eligible[0];
  const competing = eligible.filter((c) => !c.review.length && c.score >= top.score - 0.4 && c.score >= MED);
  const confidence: LineMapping['confidence'] = !top.review.length && top.score >= HIGH ? 'high' : top.score >= MED ? 'medium' : 'low';

  if (top.score < MED || top.review.length) {
    const missing = top.review.join(' ') || missingFor(line, model);
    return { ...base, state: 'needs_question', allocations: [], candidates, broadened, newActivity: null, explanation: `Closest candidate: ${top.activity.code} ${top.activity.name}. The evidence does not establish that it can receive this work.`, question: questionFor(line, candidates, missing), downstream: [], confidence };
  }
  if (competing.length > 1) {
    return { ...base, state: 'needs_question', allocations: [], candidates, broadened, newActivity: null, explanation: `Several activities fit equally well: ${competing.map((c) => c.activity.code).join(', ')}. The tool has not split or duplicated the quantity.`, question: questionFor(line, candidates, 'Confirm the exact work section or a measured quantity split; shared WBS does not imply equal work.'), downstream: [], confidence: 'low' };
  }

  const chosen = [top];
  const allocs = allocate(chosen.map((c) => ({ activityTaskId: c.activity.taskId, activityCode: c.activity.code, activityName: c.activity.name, share: '0', quantity: null, basis: 'automatic' as const })), line.quantity);
  const cautions = chosen.flatMap((c) => c.cautions);
  return {
    ...base, state: 'proposed', allocations: allocs, candidates, broadened, newActivity: null,
    explanation: `${chosen.map((c) => `${c.activity.code} ${c.activity.name}`).join(' and ')}: ${top.reasons.join('; ')}.${broadened ? ' Broader search still applied the work and location checks.' : ''}${cautions.length ? ` Note: ${cautions[0]}` : ''}`,
    question: null, downstream: downstreamOf(chosen.map((c) => c.activity.taskId), model), confidence,
  };
}

function labelState(s: NonNullable<MappingUserChoice['state']>): string {
  return s === 'deferred' ? 'Deferred' : s === 'excluded' ? 'Excluded from schedule assessment' : 'Not applicable';
}

function missingFor(line: WorkLine, model: ScheduleModel): string {
  const bits: string[] = [];
  if (!line.location.trim()) bits.push('the location of the change');
  if (!model.activities.some((a) => (a.wbs ?? '').includes('/'))) bits.push('a WBS structure in the programme');
  if (!model.activities.some((a) => Object.keys(a.activityCodes ?? {}).length > 0)) bits.push('activity codes');
  return bits.length ? `Missing: ${bits.join(', ')}.` : 'The activity names do not describe this work in a way the programme can match.';
}

function questionFor(line: WorkLine, candidates: Candidate[], missing: string): Question {
  const opts = candidates.filter((c) => c.eligible).slice(0, 4).map((c) => ({ id: `act:${c.activity.taskId}`, label: `${c.review.length ? 'Select after verifying: ' : ''}${c.activity.code} ${c.activity.name} (${c.activity.wbsPath || 'no WBS'})`, activityTaskId: c.activity.taskId }));
  return {
    id: `q-${line.lineId}`, lineId: line.lineId, title: `Which activity carries “${line.name}”?`, missing,
    options: [...opts, { id: 'new', label: 'None - propose a new activity' }, { id: 'defer', label: 'Not sure - defer and continue' }],
  };
}

function newActivityMapping(line: WorkLine, model: ScheduleModel, base: { lineId: string; componentId: string; name: string }, candidates: Candidate[], broadened: boolean, anchor: Candidate | undefined, name?: string): LineMapping {
  const plausible = candidates.filter((c) => !c.violations.length && !c.review.length && c.score >= MED);
  const near = anchor ?? (plausible.length === 1 || (plausible[0] && plausible[1] && plausible[0].score - plausible[1].score > 0.4) ? plausible[0] : undefined);
  const proposal = buildNewActivity(line, model, near?.activity, name);
  return {
    ...base, state: 'new_activity', allocations: [], candidates, broadened, newActivity: proposal,
    explanation: anchor?.completed
      ? `${anchor.activity.code} ${anchor.activity.name} is complete (actual dates kept). The extra work is proposed as a new activity after it, not added to the completed one.`
      : near ? `No open activity can take this work; ${near.activity.code} is the nearest and is proposed as the logic anchor.` : 'No activity covers this work, so a new activity is proposed.',
    question: null, downstream: proposal.successors.map((s) => ({ code: s.code, name: s.name, kind: 'successor' })), confidence: anchor ? 'high' : 'medium',
  };
}

/** Build a fragnet from the imported network: predecessor = the anchor (or its predecessors), successors = anchor successors. */
export function buildNewActivity(line: WorkLine, model: ScheduleModel, anchor: ActivityBrief | undefined, name?: string): NewActivityProposal {
  const byTask = new Map(model.activities.map((a) => [a.taskId ?? a.id, a]));
  const succs = anchor ? model.relationships.filter((r) => r.fromTaskId === anchor.taskId && r.resolved !== false).map((r) => byTask.get(r.toTaskId ?? '')).filter((a): a is ScheduleActivity => !!a) : [];
  return {
    name: name?.trim() || `${line.name}${line.location ? ` - ${line.location}` : ''}`,
    wbsPath: anchor?.wbsPath ?? '',
    predecessors: anchor ? [{ code: anchor.code, name: anchor.name, type: anchor.status === 'completed' ? 'FS' : 'SS' }] : [],
    successors: succs.slice(0, 4).map((s) => ({ code: s.id, name: s.name, type: 'FS' as const })),
    reason: 'Scope beyond completed or absent baseline work.',
    durationBasis: 'needs_productivity',
  };
}

/** Allocate a quantity across activities by explicit shares (equal when none given). Shares always sum to 1. */
export function allocate(targets: Allocation[], quantity: string | null, shares?: Record<string, string>): Allocation[] {
  if (targets.length === 0) return [];
  const raw = targets.map((t) => { const s = Number(shares?.[t.activityTaskId]); return Number.isFinite(s) && s > 0 ? s : null; });
  const given = raw.filter((x): x is number => x !== null);
  let weights: number[];
  if (given.length === targets.length) { const sum = given.reduce((a, b) => a + b, 0); weights = given.map((x) => x / sum); }
  else weights = targets.map(() => 1 / targets.length);
  const q = quantity !== null && quantity.trim() !== '' && Number.isFinite(Number(quantity)) ? Number(quantity) : null;
  let used = 0;
  return targets.map((t, i) => {
    const last = i === targets.length - 1;
    const w = last ? Math.max(0, 1 - used) : weights[i];
    used += w;
    return { ...t, share: w.toFixed(6), quantity: q === null ? null : (last ? q - targets.slice(0, i).reduce((a, _, j) => a + Number(((q * weights[j])).toFixed(6)), 0) : q * w).toFixed(6).replace(/\.?0+$/, '') || '0' };
  });
}

function downstreamOf(taskIds: string[], model: ScheduleModel): LineMapping['downstream'] {
  const byTask = new Map(model.activities.map((a) => [a.taskId ?? a.id, a]));
  const successors = new Map<string, string[]>();
  for (const r of model.relationships) {
    if (r.resolved === false || !r.fromTaskId || !r.toTaskId) continue;
    const adjacent = successors.get(r.fromTaskId) ?? [];
    adjacent.push(r.toTaskId);
    successors.set(r.fromTaskId, adjacent);
  }
  const seen = new Set<string>(taskIds);
  const out: LineMapping['downstream'] = [];
  const queue = [...taskIds];
  let guard = 0;
  while (queue.length && guard++ < 5000) {
    const cur = queue.shift() as string;
    for (const to of successors.get(cur) ?? []) {
      if (seen.has(to)) continue;
      seen.add(to);
      const a = byTask.get(to);
      if (!a) continue;
      const milestone = a.kind === 'milestone_finish' || a.kind === 'milestone_start' || phaseOf(a.name) === 'handover';
      if (milestone) out.push({ code: a.id, name: a.name, kind: a.kind ?? 'task' });
      queue.push(to);
    }
  }
  return out.slice(0, 5);
}

// ---------------------------------------------------------------------------------------------
// Whole-set mapping with duplicate protection
// ---------------------------------------------------------------------------------------------

export interface MappingResult {
  mappings: LineMapping[];
  /** Activities that receive quantity from more than one line, with the combined load. */
  sharedActivities: { activityTaskId: string; code: string; lines: string[] }[];
  /** Lines counted at most once for quantity, effort and duration. */
  duplicateGuard: string[];
  counts: { proposed: number; accepted: number; needsQuestion: number; newActivity: number; notApplicable: number; deferred: number; excluded: number };
}

export function mapAll(lines: WorkLine[], model: ScheduleModel, choices: MappingChoices = {}, opts: { broaden?: boolean } = {}): MappingResult {
  const mappings = lines.map((l) => mapLine(l, model, choices[l.lineId], opts));
  const byAct = new Map<string, { code: string; lines: string[] }>();
  for (let m of mappings) {
    if (m.state === 'deferred' || m.state === 'excluded' || m.state === 'not_applicable') continue;
    for (const a of m.allocations) {
      const cur = byAct.get(a.activityTaskId) ?? { code: a.activityCode, lines: [] };
      cur.lines.push(m.lineId);
      byAct.set(a.activityTaskId, cur);
    }
  }
  const sharedActivities = Array.from(byAct.entries()).filter(([, v]) => v.lines.length > 1).map(([k, v]) => ({ activityTaskId: k, code: v.code, lines: v.lines }));
  // A line must not appear twice for the same activity (would double-count quantity, effort and duration).
  const duplicateGuard: string[] = [];
  for (let m of mappings) {
    const seen = new Set<string>();
    m.allocations = m.allocations.filter((a) => { if (seen.has(a.activityTaskId)) { duplicateGuard.push(`${m.name}: ${a.activityCode} listed twice, counted once`); return false; } seen.add(a.activityTaskId); return true; });
  }
  const c = (s: MappingState) => mappings.filter((m) => m.state === s).length;
  return { mappings, sharedActivities, duplicateGuard, counts: { proposed: c('proposed'), accepted: c('accepted'), needsQuestion: c('needs_question'), newActivity: c('new_activity'), notApplicable: c('not_applicable'), deferred: c('deferred'), excluded: c('excluded') } };
}

/** Relationships still valid when a scenario-excluded line is removed: only its own new activity is dropped, never baseline logic. */
export function relationshipsAfterExclusion(model: ScheduleModel, _excludedLineIds: string[]): ScheduleRelationship[] {
  return model.relationships;
}

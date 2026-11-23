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

const STOP = new Set(['the', 'and', 'of', 'to', 'a', 'in', 'for', 'at', 'with', 'by', 'on', 'new', 'additional', 'extra', 'supply', 'install', 'provide', 'including', 'all', 'complete', 'as', 'per', 'from', 'or', 'an', 'be', 'is', 'work', 'works']);
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

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).map((t) => t.replace(/^-+|-+$/g, '')).filter((t) => t.length > 1 && !STOP.has(t));
}
const stem = (t: string) => (t.length > 4 ? t.replace(/(ing|ed|es|s)$/, '') : t);
const groupsOf = (ts: string[]) => { const g = new Set<number>(); for (const t of ts) { const i = SYN_INDEX.get(t) ?? SYN_INDEX.get(stem(t)); if (i !== undefined) g.add(i); } return g; };

/** Location tokens such as a road code or "Zone C" - generic words and codes only; chainage-style ranges are compared numerically. */
function locationTokens(s: string): string[] { return tokens(s).filter((t) => t.length > 1); }

/** Parse "CH 5+000", "KM 5.0" or "5000" style stations from text, generically. Returns metres when recognisable. */
export function stationsIn(text: string): number[] {
  const out: number[] = [];
  const re = /\b(?:ch|chainage|km|sta|station)?\.?\s*(\d{1,3})\s*\+\s*(\d{3})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(Number(m[1]) * 1000 + Number(m[2]));
  return out;
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
  /** Soft warnings that do not disqualify. */
  cautions: string[];
  eligible: boolean;
  /** True for the "new work beyond completed work" case. */
  completed: boolean;
}

export interface RetrievalOptions { limit?: number; broaden?: boolean }

/**
 * Retrieve and rank candidates for one line across the entire schedule. If the strict pass yields nothing useful
 * (thin metadata), a broadened pass relaxes location and WBS requirements and says so in the reasons.
 */
export function retrieveActivities(line: WorkLine, model: ScheduleModel, opts: RetrievalOptions = {}): { candidates: Candidate[]; broadened: boolean } {
  const limit = opts.limit ?? 6;
  const strict = rank(line, model, false);
  const goodStrict = strict.filter((c) => c.eligible && c.score >= 2.2);
  if (goodStrict.length > 0 && !opts.broaden) return { candidates: strict.slice(0, limit), broadened: false };
  const wide = rank(line, model, true);
  return { candidates: wide.slice(0, limit), broadened: true };
}

function rank(line: WorkLine, model: ScheduleModel, broad: boolean): Candidate[] {
  const queryText = [line.name, line.description, line.workType, line.specification, ...line.searchTerms].join(' ');
  const qTok = Array.from(new Set(tokens(queryText).map(stem)));
  const qGroups = groupsOf(tokens(queryText));
  const linePhase = phaseOf(`${line.name} ${line.workType} ${line.description}`);
  const locTok = locationTokens(line.location);
  const lineStations = stationsIn(`${line.location} ${line.description} ${line.name}`);
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

    // Location: generic token overlap, then numeric station overlap when both sides state stations.
    if (locTok.length) {
      const hits = locTok.filter((t) => ownTok.has(stem(t)) || ctxTok.has(stem(t)));
      if (hits.length) { score += Math.min(1.4, hits.length * 0.5); reasons.push(`location terms match: ${hits.slice(0, 3).join(', ')}`); }
      else if (!broad) { score -= 0.4; }
    }
    if (lineStations.length) {
      const actStations = stationsIn(`${a.name} ${a.wbs}`);
      if (actStations.length >= 2) {
        const lo = Math.min(...actStations); const hi = Math.max(...actStations);
        const inside = lineStations.some((s) => s >= lo && s <= hi);
        if (inside) { score += 1.2; reasons.push('stated chainage falls within the activity range'); }
        else if (!broad) { score -= 0.8; cautions.push('activity covers a different stated chainage range'); }
      }
    }

    // Hard validation: kind and completion.
    const kindBlock = line.executes ? cannotReceiveExecution(b) : null;
    if (kindBlock) violations.push(kindBlock);
    const completed = b.status === 'completed';
    if (completed && line.executes) cautions.push('Already complete: actual dates and completed work are not changed. New scope needs a new activity.');
    if (b.status === 'in_progress' && line.executes) cautions.push(`In progress (${b.progressPct}%): the added quantity applies to the remaining work only.`);

    // A handover-phase activity never matches an execution operation.
    if (line.executes && b.phase === 'handover' && linePhase !== 'handover') { if (!violations.length) violations.push('It is a handover/completion activity, not an execution activity.'); }

    if (score <= 0.5 && !broad) continue;
    if (score <= 0.2) continue;
    out.push({ activity: b, score: Math.round(score * 100) / 100, reasons, violations, cautions, eligible: violations.length === 0 && !completed, completed });
  }
  return out.sort((x, y) => Number(y.eligible) - Number(x.eligible) || y.score - x.score || x.activity.code.localeCompare(y.activity.code));
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
    for (const tid of choice.activityTaskIds) {
      const a = byTask.get(tid);
      if (!a) { rejected.push(`${tid} is not in the imported schedule`); continue; }
      const why = cannotReceiveExecution(briefOf(a));
      if (why) { rejected.push(`${a.id} ${a.name}: ${why}`); continue; }
      if ((a.status ?? 'not_started') === 'completed') { rejected.push(`${a.id} ${a.name}: it is complete, so its actual dates and quantities are not changed. Propose a new activity instead.`); continue; }
      ok.push({ activityTaskId: tid, activityCode: a.id, activityName: a.name, share: '0', quantity: null, basis: 'user' });
    }
    if (ok.length) {
      const allocs = allocate(ok, line.quantity, choice.shares);
      return { ...base, state: 'accepted', allocations: allocs, candidates, broadened, newActivity: null, explanation: `Your selection${rejected.length ? ` (${rejected.length} rejected: ${rejected.join('; ')})` : ''}.`, question: null, downstream: downstreamOf(allocs.map((x) => x.activityTaskId), model), confidence: 'high' };
    }
    return { ...base, state: 'needs_question', allocations: [], candidates, broadened, newActivity: null, explanation: `Selection rejected: ${rejected.join('; ')}`, question: questionFor(line, candidates, 'The selected activity cannot take this work.'), downstream: [], confidence: 'low' };
  }

  const eligible = candidates.filter((c) => c.eligible);
  const completedBest = candidates.find((c) => c.completed && !c.violations.length && c.score >= MED);

  if (choice?.wantsNewActivity) return newActivityMapping(line, model, base, candidates, broadened, completedBest, choice.newActivityName);

  if (eligible.length === 0) {
    // Completed work cannot take new scope: propose a new activity/fragnet beside it.
    if (completedBest) return newActivityMapping(line, model, base, candidates, broadened, completedBest);
    const blocked = candidates.find((c) => c.violations.length > 0);
    return {
      ...base, state: 'needs_question', allocations: [], candidates, broadened, newActivity: null,
      explanation: blocked ? `Best textual match ${blocked.activity.code} ${blocked.activity.name} cannot take the work: ${blocked.violations[0]}` : 'No activity in the imported schedule resembles this work.',
      question: questionFor(line, candidates, blocked ? 'Only a milestone or summary row resembles this work.' : missingFor(line, model)),
      downstream: blocked ? downstreamOf([blocked.activity.taskId], model) : [], confidence: 'low',
    };
  }

  const top = eligible[0];
  const competing = eligible.filter((c) => c.score >= top.score - 0.4 && c.score >= MED);
  // Several equally good eligible activities in the same WBS family => split the quantity explicitly; otherwise ask.
  const sameFamily = competing.length > 1 && competing.every((c) => parentOf(c.activity.wbsPath) === parentOf(top.activity.wbsPath));
  const confidence: LineMapping['confidence'] = top.score >= HIGH ? 'high' : top.score >= MED ? 'medium' : 'low';

  if (top.score < MED) {
    return { ...base, state: 'needs_question', allocations: [], candidates, broadened, newActivity: null, explanation: `The closest candidate is ${top.activity.code} ${top.activity.name}, but the evidence is weak (${top.reasons.join('; ') || 'few shared terms'}).`, question: questionFor(line, candidates, missingFor(line, model)), downstream: [], confidence };
  }
  if (competing.length > 1 && !sameFamily) {
    return { ...base, state: 'needs_question', allocations: [], candidates, broadened, newActivity: null, explanation: `${competing.length} activities fit equally well and sit in different parts of the WBS: ${competing.map((c) => c.activity.code).join(', ')}.`, question: questionFor(line, candidates, 'Location or WBS does not separate these activities. State which area the change is in, or choose.'), downstream: [], confidence: 'low' };
  }

  const chosen = sameFamily ? competing : [top];
  const allocs = allocate(chosen.map((c) => ({ activityTaskId: c.activity.taskId, activityCode: c.activity.code, activityName: c.activity.name, share: '0', quantity: null, basis: 'automatic' as const })), line.quantity);
  const cautions = chosen.flatMap((c) => c.cautions);
  return {
    ...base, state: 'proposed', allocations: allocs, candidates, broadened, newActivity: null,
    explanation: `${chosen.map((c) => `${c.activity.code} ${c.activity.name}`).join(' and ')}: ${top.reasons.join('; ')}.${broadened ? ' Retrieval was broadened because location/WBS metadata was missing.' : ''}${cautions.length ? ` Note: ${cautions[0]}` : ''}`,
    question: null, downstream: downstreamOf(chosen.map((c) => c.activity.taskId), model), confidence,
  };
}

function labelState(s: NonNullable<MappingUserChoice['state']>): string {
  return s === 'deferred' ? 'Deferred' : s === 'excluded' ? 'Excluded from schedule assessment' : 'Not applicable';
}

const parentOf = (path: string) => path.split(' / ').slice(0, -1).join(' / ');

function missingFor(line: WorkLine, model: ScheduleModel): string {
  const bits: string[] = [];
  if (!line.location.trim()) bits.push('the location of the change');
  if (!model.activities.some((a) => (a.wbs ?? '').includes('/'))) bits.push('a WBS structure in the programme');
  if (!model.activities.some((a) => Object.keys(a.activityCodes ?? {}).length > 0)) bits.push('activity codes');
  return bits.length ? `Missing: ${bits.join(', ')}.` : 'The activity names do not describe this work in a way the programme can match.';
}

function questionFor(line: WorkLine, candidates: Candidate[], missing: string): Question {
  const opts = candidates.filter((c) => c.eligible).slice(0, 4).map((c) => ({ id: `act:${c.activity.taskId}`, label: `${c.activity.code} ${c.activity.name} (${c.activity.wbsPath || 'no WBS'})`, activityTaskId: c.activity.taskId }));
  return {
    id: `q-${line.lineId}`, lineId: line.lineId, title: `Which activity carries “${line.name}”?`, missing,
    options: [...opts, { id: 'new', label: 'None - propose a new activity' }, { id: 'defer', label: 'Not sure - defer and continue' }],
  };
}

function newActivityMapping(line: WorkLine, model: ScheduleModel, base: { lineId: string; componentId: string; name: string }, candidates: Candidate[], broadened: boolean, anchor: Candidate | undefined, name?: string): LineMapping {
  const near = anchor ?? candidates.find((c) => !c.violations.length) ?? candidates[0];
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
  const seen = new Set<string>(taskIds);
  const out: LineMapping['downstream'] = [];
  const queue = [...taskIds];
  let guard = 0;
  while (queue.length && guard++ < 5000) {
    const cur = queue.shift() as string;
    for (const r of model.relationships) {
      if (r.fromTaskId !== cur || r.resolved === false) continue;
      const to = r.toTaskId as string;
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

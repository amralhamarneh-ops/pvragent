import { calculateCpm, dayDiff, validateNetwork, type CpmActivity, type CpmIssue, type CpmNetwork, type CpmRelationship, type CpmResult, CalendarIndex } from './cpmEngine';

export type EngineKind = 'embedded' | 'external_p6' | 'handoff';
export type CapabilityStatus = 'validated' | 'tested_scope' | 'not_configured' | 'unvalidated';

export interface EngineCapabilities {
  relationshipTypes: ('FS' | 'SS' | 'FF' | 'SF')[];
  negativeLags: boolean;
  multipleCalendars: boolean;
  constraints: string[];
  retainedLogic: boolean;
  progressOverride: boolean;
  outOfSequenceOptions: boolean;
  resourceLevelling: boolean;
  externalLinks: boolean;
  loeAndHammocks: boolean;
  notes: string[];
}

export interface EngineInfo {
  id: string;
  kind: EngineKind;
  name: string;
  version: string;
  status: CapabilityStatus;
  available: boolean;
  capabilities: EngineCapabilities;
  statusNote: string;
}

export interface ScheduleRequest {
  caseId: string;
  scenarioId: string;
  assessmentVersion: number;
  network: CpmNetwork;
}

export type ScheduleOutcome =
  | { status: 'ok'; engine: EngineInfo; request: ScheduleRequest; result: CpmResult }
  | { status: 'unavailable'; engine: EngineInfo; reason: string; request: ScheduleRequest }
  | { status: 'awaiting_import'; engine: EngineInfo; request: ScheduleRequest; handoffId: string };

/** Replaceable scheduling contract. The UI only depends on this interface. */
export interface SchedulingEngine {
  info(): EngineInfo;
  schedule(req: ScheduleRequest): Promise<ScheduleOutcome>;
}

export const EMBEDDED_VERSION = 'pvr-cpm-embedded 1.0.0';

export class EmbeddedEngine implements SchedulingEngine {
  info(): EngineInfo {
    return {
      id: 'embedded', kind: 'embedded', name: 'Embedded deterministic CPM engine', version: EMBEDDED_VERSION, status: 'tested_scope', available: true,
      capabilities: {
        relationshipTypes: ['FS', 'SS', 'FF', 'SF'], negativeLags: true, multipleCalendars: true, constraints: ['SNET', 'SNLT', 'FNET', 'FNLT', 'MSO', 'MFO'],
        retainedLogic: true, progressOverride: false, outOfSequenceOptions: false, resourceLevelling: false, externalLinks: false, loeAndHammocks: false,
        notes: ['Unconstrained CPM only. Not resource-feasible.', 'Retained logic only. Progress override and out-of-sequence modes are not supported.', 'Not asserted equal to P6 until the unchanged-copy comparison is accepted.'],
      },
      statusNote: 'Available for its tested scope. P6-equivalence is established per schedule by the unchanged-copy comparison, not by parsing.',
    };
  }
  async schedule(req: ScheduleRequest): Promise<ScheduleOutcome> {
    const result = calculateCpm(req.network);
    if (!result.ok) return { status: 'unavailable', engine: this.info(), reason: result.issues.filter((i) => i.severity === 'error').map((i) => i.message).join(' '), request: req };
    return { status: 'ok', engine: this.info(), request: req, result };
  }
}

/** Connected P6 service adapter. Reports unavailable unless configured and validated; never returns zero dates. */
export class ExternalP6Engine implements SchedulingEngine {
  private configured: boolean;
  private validated: boolean;
  constructor(configured = false, validated = false) {
    this.configured = configured;
    this.validated = validated;
  }
  info(): EngineInfo {
    return {
      id: 'p6-service', kind: 'external_p6', name: 'Connected P6 scheduling service', version: 'unknown', status: this.configured ? (this.validated ? 'validated' : 'unvalidated') : 'not_configured', available: this.configured && this.validated,
      capabilities: { relationshipTypes: ['FS', 'SS', 'FF', 'SF'], negativeLags: true, multipleCalendars: true, constraints: [], retainedLogic: true, progressOverride: true, outOfSequenceOptions: true, resourceLevelling: true, externalLinks: true, loeAndHammocks: true, notes: ['Capabilities are declared by the service and must be confirmed by a validation run.'] },
      statusNote: this.configured ? (this.validated ? 'Configured and validated against an unchanged copy.' : 'Configured but not validated. Run the unchanged-copy validation first.') : 'Not configured. Set P6_SERVICE_URL and P6_SERVICE_TOKEN on the server and run validation. No P6 results are available.',
    };
  }
  async schedule(req: ScheduleRequest): Promise<ScheduleOutcome> {
    return { status: 'unavailable', engine: this.info(), reason: this.info().statusNote, request: req };
  }
}

export class HandoffEngine implements SchedulingEngine {
  info(): EngineInfo {
    return {
      id: 'handoff', kind: 'handoff', name: 'Export / import handoff', version: 'handoff 1.0', status: 'tested_scope', available: true,
      capabilities: { relationshipTypes: ['FS', 'SS', 'FF', 'SF'], negativeLags: true, multipleCalendars: true, constraints: [], retainedLogic: true, progressOverride: false, outOfSequenceOptions: false, resourceLevelling: false, externalLinks: false, loeAndHammocks: false, notes: ['A planner schedules a controlled copy externally and returns dates.'] },
      statusNote: 'Export the instruction pack, schedule a controlled copy in P6, then import and reconcile the result.',
    };
  }
  async schedule(req: ScheduleRequest): Promise<ScheduleOutcome> {
    return { status: 'awaiting_import', engine: this.info(), request: req, handoffId: `HO-${req.caseId}-${req.scenarioId}-v${req.assessmentVersion}` };
  }
}

// ---------- Unchanged-copy validation against source schedule ----------
export interface SourceDates { id: string; start: string; finish: string; totalFloat: number | null }

export interface ValidationDiff {
  id: string;
  field: 'start' | 'finish' | 'float';
  source: string | number | null;
  recalculated: string | number;
  difference: number;
  withinTolerance: boolean;
}

export interface EngineValidation {
  compared: number;
  mismatches: ValidationDiff[];
  milestoneMismatches: ValidationDiff[];
  tolerancesDays: { dates: number; float: number };
  needsAcceptance: boolean;
  accepted: { by: string; at: string; reason: string } | null;
  unsupported: string[];
  requiredSettings: { key: string; present: boolean; note: string }[];
  verdict: 'reproduced' | 'differences_within_tolerance' | 'not_reproduced';
}

export function validateUnchangedCopy(net: CpmNetwork, source: SourceDates[], tol = { dates: 0, float: 0 }, unsupported: string[] = []): EngineValidation {
  const res = calculateCpm(net);
  const mismatches: ValidationDiff[] = [];
  const milestoneMismatches: ValidationDiff[] = [];
  let compared = 0;
  const calIdx = new Map(net.calendars.map((c) => [c.id, new CalendarIndex(c)]));
  const byId = new Map(net.activities.map((a) => [a.id, a]));
  if (res.ok) {
    for (const s of source) {
      const r = res.activities[s.id];
      const a = byId.get(s.id);
      if (!r || !a) continue;
      compared++;
      const cal = calIdx.get(a.calendarId) as CalendarIndex;
      const isMs = a.type === 'milestone_finish' || a.type === 'milestone_start';
      const add = (d: ValidationDiff) => { if (!d.withinTolerance || d.difference !== 0) (isMs ? milestoneMismatches : mismatches).push(d); };
      const ds = cal.workDiff(s.start, r.earlyStart);
      add({ id: s.id, field: 'start', source: s.start, recalculated: r.earlyStart, difference: ds, withinTolerance: Math.abs(ds) <= tol.dates });
      const df = cal.workDiff(s.finish, r.earlyFinish);
      add({ id: s.id, field: 'finish', source: s.finish, recalculated: r.earlyFinish, difference: df, withinTolerance: Math.abs(df) <= tol.dates });
      if (s.totalFloat !== null) {
        const dfl = r.totalFloat - s.totalFloat;
        add({ id: s.id, field: 'float', source: s.totalFloat, recalculated: r.totalFloat, difference: dfl, withinTolerance: Math.abs(dfl) <= tol.float });
      }
    }
  }
  const all = [...mismatches, ...milestoneMismatches];
  const outside = all.filter((m) => !m.withinTolerance);
  const requiredSettings = [
    { key: 'Calendars and exceptions', present: net.calendars.length > 0, note: `${net.calendars.length} calendar(s) supplied.` },
    { key: 'Data date', present: !!net.dataDate, note: net.dataDate },
    { key: 'Progress treatment', present: true, note: 'Retained logic (declared).' },
    { key: 'Activity types', present: true, note: 'Task, start and finish milestones. LOE is unsupported.' },
    { key: 'Constraints', present: true, note: 'SNET, SNLT, FNET, FNLT, MSO, MFO supported.' },
    { key: 'Relationship-lag calendars', present: false, note: 'Engine uses the successor calendar for lags. Confirm the source setting.' },
    { key: 'External links', present: !net.activities.some((a) => a.external), note: 'Supply supporting projects or reviewed boundary dates if present.' },
    { key: 'Critical-path setting', present: true, note: 'Critical = total float ≤ 0.' },
    { key: 'Resource levelling', present: false, note: 'Not applied. Declare if the source schedule was levelled.' },
  ];
  return {
    compared, mismatches, milestoneMismatches, tolerancesDays: tol,
    needsAcceptance: all.length > 0, accepted: null, unsupported,
    requiredSettings,
    verdict: !res.ok || outside.length > 0 ? 'not_reproduced' : all.length > 0 ? 'differences_within_tolerance' : 'reproduced',
  };
}

// ---------- Scenario insertion and comparison ----------
export interface FragnetActivity {
  id: string;
  description: string;
  wbs: string;
  type: CpmActivity['type'];
  calendarId: string;
  durationBasis: string;
  durationDays: number;
  resources: string;
  startBasis: string;
  constraint?: CpmActivity['constraint'];
}
export interface FragnetLink extends CpmRelationship { note?: string }

export interface Fragnet {
  id: string;
  activities: FragnetActivity[];
  links: FragnetLink[];
  /** Affected existing work and milestones this fragnet must connect to. */
  affectedExisting: string[];
  affectedMilestones: string[];
  eventDate: string;
  assessmentMode: 'prospective' | 'retrospective';
  retrospective?: { updateId: string; method: string; basis: string };
}

export interface FragnetIssue { severity: 'error' | 'warning'; code: string; message: string; activityId?: string }

export function validateFragnet(f: Fragnet, base: CpmNetwork): FragnetIssue[] {
  const out: FragnetIssue[] = [];
  const baseIds = new Set(base.activities.map((a) => a.id));
  const seen = new Set<string>();
  for (const a of f.activities) {
    if (!a.id.trim()) out.push({ severity: 'error', code: 'EMPTY_ID', message: 'A fragnet activity has no ID.' });
    if (seen.has(a.id)) out.push({ severity: 'error', code: 'DUP_ID', message: `Duplicate fragnet ID ${a.id}.`, activityId: a.id });
    if (baseIds.has(a.id)) out.push({ severity: 'error', code: 'ID_COLLISION', message: `${a.id} already exists in the programme.`, activityId: a.id });
    seen.add(a.id);
    if (!base.calendars.some((c) => c.id === a.calendarId)) out.push({ severity: 'error', code: 'BAD_CALENDAR', message: `${a.id}: calendar ${a.calendarId} does not exist.`, activityId: a.id });
    if (a.type === 'task' && a.durationDays <= 0) out.push({ severity: 'error', code: 'BAD_DURATION', message: `${a.id}: a task needs a duration above zero and a duration basis.`, activityId: a.id });
    if (!a.durationBasis.trim()) out.push({ severity: 'warning', code: 'NO_BASIS', message: `${a.id}: duration basis is not recorded.`, activityId: a.id });
    if (a.constraint && (a.constraint.type === 'MSO' || a.constraint.type === 'MFO')) out.push({ severity: 'warning', code: 'HARD_CONSTRAINT', message: `${a.id}: a hard date constraint is used. Do not replace logical ties with hard dates to force a result.`, activityId: a.id });
  }
  const all = new Set([...baseIds, ...seen]);
  for (const l of f.links) {
    if (!all.has(l.from) || !all.has(l.to)) out.push({ severity: 'error', code: 'BAD_LINK', message: `Link ${l.from} → ${l.to} refers to an unknown activity.` });
  }
  const merged: CpmNetwork = { ...base, activities: [...base.activities, ...toCpmActivities(f)], relationships: [...base.relationships, ...f.links] };
  const v = validateNetwork(merged);
  for (let i of v.issues) {
    if (i.code === 'CYCLE') out.push({ severity: 'error', code: 'CYCLE', message: i.message });
    if ((i.code === 'OPEN_END' || i.code === 'OPEN_START') && i.activityId && seen.has(i.activityId)) out.push({ severity: 'warning', code: i.code, message: i.message, activityId: i.activityId });
  }
  const incomingFromExisting = f.links.some((l) => baseIds.has(l.from) && seen.has(l.to));
  const outgoingToExisting = f.links.some((l) => seen.has(l.from) && baseIds.has(l.to));
  if (f.activities.length && !incomingFromExisting) out.push({ severity: 'error', code: 'NOT_CONNECTED_IN', message: 'Fragnet has no tie from existing work. Connect it to the affected activity or its predecessor.' });
  if (f.activities.length && !outgoingToExisting) out.push({ severity: 'error', code: 'NOT_CONNECTED_OUT', message: 'Fragnet has no tie to existing successors or milestones, so it cannot affect completion.' });
  for (const id of f.affectedExisting) if (!baseIds.has(id)) out.push({ severity: 'error', code: 'UNKNOWN_AFFECTED', message: `Affected activity ${id} is not in the programme.` });
  for (const id of f.affectedMilestones) if (!baseIds.has(id)) out.push({ severity: 'error', code: 'UNKNOWN_MILESTONE', message: `Milestone ${id} is not in the programme.` });
  if (!f.eventDate) out.push({ severity: 'error', code: 'NO_EVENT_DATE', message: 'Event, instruction or availability date is required.' });
  if (f.assessmentMode === 'retrospective') {
    if (!f.retrospective || !f.retrospective.updateId.trim() || !f.retrospective.method.trim() || !f.retrospective.basis.trim()) out.push({ severity: 'error', code: 'RETRO_BASIS', message: 'A retrospective assessment needs a selected historical update, an assessment method and an explained basis. A past event is not applied to the current update silently.' });
    else if (f.retrospective.updateId === 'current') out.push({ severity: 'error', code: 'RETRO_CURRENT', message: 'Retrospective assessments must use a historical update, not the current one.' });
  } else if (dayDiff(base.dataDate, f.eventDate) < 0) {
    out.push({ severity: 'warning', code: 'EVENT_BEFORE_DD', message: `Event date ${f.eventDate} is before the data date ${base.dataDate}. Remaining work is scheduled from the data date; choose a retrospective method if the past event matters.` });
  }
  return out;
}

export function toCpmActivities(f: Fragnet): CpmActivity[] {
  return f.activities.map((a) => ({ id: a.id, name: a.description, type: a.type, calendarId: a.calendarId, remainingDuration: a.durationDays, originalDuration: a.durationDays, constraint: a.constraint, isNew: true }));
}

export function insertFragnet(base: CpmNetwork, f: Fragnet): CpmNetwork {
  return { ...base, activities: [...base.activities, ...toCpmActivities(f)], relationships: [...base.relationships, ...f.links.map(({ note, ...r }) => { void note; return r; })] };
}

/** Increase remaining duration of an existing, not-completed activity. Returns a copy; history is untouched. */
export function increaseRemaining(base: CpmNetwork, activityId: string, addDaysWorking: number): { network: CpmNetwork; error: string | null } {
  const a = base.activities.find((x) => x.id === activityId);
  if (!a) return { network: base, error: `Activity ${activityId} not found.` };
  if (a.actualFinish) return { network: base, error: `${activityId} is completed. Completed activities are not reopened; use a new activity or fragnet.` };
  return { network: { ...base, activities: base.activities.map((x) => (x.id === activityId ? { ...x, remainingDuration: Math.max(0, x.remainingDuration + addDaysWorking) } : x)) }, error: null };
}

export interface ActivityDelta {
  id: string;
  name: string;
  finishBefore: string;
  finishAfter: string;
  calendarDaysMoved: number;
  workingDaysMoved: number;
  floatBefore: number;
  floatAfter: number;
  floatConsumed: number;
  becameCritical: boolean;
  becameNearCritical: boolean;
  directlyChanged: boolean;
  isNew: boolean;
}

export interface Comparison {
  completionBefore: string;
  completionAfter: string;
  calendarDaysMoved: number;
  workingDaysMoved: number;
  deltas: ActivityDelta[];
  newlyCritical: string[];
  nearCritical: string[];
  consequential: string[];
  direct: string[];
  milestones: { id: string; name: string; before: string; after: string; calendarDays: number; workingDays: number }[];
  preExistingVariance: { id: string; name: string; baselineFinish: string; recalculatedFinish: string; days: number }[];
  sameBasis: boolean;
  basisNote: string;
}

/** Impact is impacted − unimpacted recalculated, never impacted − source dates. */
export function compareScenarios(
  unimpacted: CpmNetwork,
  unRes: CpmResult,
  impacted: CpmNetwork,
  impRes: CpmResult,
  directIds: string[],
  milestoneIds: string[],
  baselineFinishes: Record<string, string> = {},
  nearCriticalDays = 10,
): Comparison {
  const sameBasis = unimpacted.dataDate === impacted.dataDate && JSON.stringify(unimpacted.calendars) === JSON.stringify(impacted.calendars) && JSON.stringify(unimpacted.settings) === JSON.stringify(impacted.settings);
  const calIdx = new Map(impacted.calendars.map((c) => [c.id, new CalendarIndex(c)]));
  const pc = calIdx.get(impacted.projectCalendarId) as CalendarIndex;
  const name = (id: string) => impacted.activities.find((a) => a.id === id)?.name ?? id;
  const deltas: ActivityDelta[] = [];
  for (const a of impacted.activities) {
    const after = impRes.activities[a.id];
    const before = unRes.activities[a.id];
    if (!after) continue;
    const cal = calIdx.get(a.calendarId) as CalendarIndex;
    const fb = before ? before.earlyFinish : after.earlyFinish;
    const fl = before ? before.totalFloat : after.totalFloat;
    const consumed = before ? before.totalFloat - after.totalFloat : 0;
    deltas.push({
      id: a.id, name: a.name, finishBefore: before ? before.earlyFinish : '', finishAfter: after.earlyFinish, calendarDaysMoved: before ? dayDiff(fb, after.earlyFinish) : 0, workingDaysMoved: before ? cal.workDiff(fb, after.earlyFinish) : 0,
      floatBefore: fl, floatAfter: after.totalFloat, floatConsumed: consumed, becameCritical: !!before && !before.critical && after.critical && after.status !== 'completed',
      becameNearCritical: !!before && before.totalFloat > nearCriticalDays && after.totalFloat > 0 && after.totalFloat <= nearCriticalDays, directlyChanged: directIds.includes(a.id) || !!a.isNew, isNew: !!a.isNew,
    });
  }
  const completionBefore = unRes.projectFinish as string;
  const completionAfter = impRes.projectFinish as string;
  const direct = deltas.filter((d) => d.directlyChanged).map((d) => d.id);
  const consequential = deltas.filter((d) => !d.directlyChanged && (d.calendarDaysMoved !== 0 || d.floatConsumed !== 0)).map((d) => d.id);
  const milestones = milestoneIds.filter((id) => unRes.activities[id] && impRes.activities[id]).map((id) => {
    const b = unRes.activities[id].earlyFinish;
    const a = impRes.activities[id].earlyFinish;
    return { id, name: name(id), before: b, after: a, calendarDays: dayDiff(b, a), workingDays: pc.workDiff(b, a) };
  });
  const preExistingVariance = Object.entries(baselineFinishes).filter(([id]) => unRes.activities[id]).map(([id, bf]) => ({ id, name: name(id), baselineFinish: bf, recalculatedFinish: unRes.activities[id].earlyFinish, days: dayDiff(bf, unRes.activities[id].earlyFinish) }));
  return {
    completionBefore, completionAfter, calendarDaysMoved: dayDiff(completionBefore, completionAfter), workingDaysMoved: pc.workDiff(completionBefore, completionAfter), deltas,
    newlyCritical: deltas.filter((d) => d.becameCritical).map((d) => d.id), nearCritical: deltas.filter((d) => d.becameNearCritical).map((d) => d.id), consequential, direct, milestones, preExistingVariance, sameBasis,
    basisNote: sameBasis ? 'Impacted and unimpacted schedules use the same data date, calendars and engine settings.' : 'Basis differs between the two schedules. The difference is not a valid impact.',
  };
}

// ---------- Handoff export / import ----------
export interface HandoffPackage {
  handoffId: string;
  caseId: string;
  scenarioId: string;
  assessmentVersion: number;
  inputHash: string;
  engineRequested: string;
  dataDate: string;
  instructions: string[];
  fragnet: Fragnet | null;
  durationChanges: { activityId: string; addWorkingDays: number }[];
  activities: { id: string; name: string; type: string; calendar: string; remainingDuration: number; actualStart?: string; actualFinish?: string; constraint?: string }[];
  relationships: CpmRelationship[];
  calendars: CpmNetwork['calendars'];
  omittedFromExport: string[];
}

export function hashString(s: string): string {
  let h1 = 0xdeadbeef ^ s.length;
  let h2 = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

export function buildHandoff(req: ScheduleRequest, fragnet: Fragnet | null, durationChanges: { activityId: string; addWorkingDays: number }[], omitted: string[]): HandoffPackage {
  const n = req.network;
  const handoffId = `HO-${req.caseId}-${req.scenarioId}-v${req.assessmentVersion}`;
  return {
    handoffId, caseId: req.caseId, scenarioId: req.scenarioId, assessmentVersion: req.assessmentVersion, inputHash: hashString(JSON.stringify({ n, fragnet, durationChanges })), engineRequested: 'P6 or equivalent', dataDate: n.dataDate,
    instructions: [
      'Work on a controlled COPY of the accepted update. Do not overwrite the source programme.',
      `Set the data date to ${n.dataDate} and keep the same calendars, retained-logic setting and constraints as the source.`,
      'Insert the listed fragnet and duration changes only. Do not change actual dates or completed activities.',
      'Schedule, then export early start, early finish, late start, late finish and total float for every activity as CSV with the columns: id,earlyStart,earlyFinish,lateStart,lateFinish,totalFloat.',
      'State whether resource levelling was applied. Return the handoff ID in the file name or first row.',
    ],
    fragnet, durationChanges,
    activities: n.activities.map((a) => ({ id: a.id, name: a.name, type: a.type, calendar: a.calendarId, remainingDuration: a.remainingDuration, actualStart: a.actualStart, actualFinish: a.actualFinish, constraint: a.constraint ? `${a.constraint.type} ${a.constraint.date}` : undefined })),
    relationships: n.relationships, calendars: n.calendars, omittedFromExport: omitted,
  };
}

export interface ReconcileReport {
  ok: boolean;
  handoffMatches: boolean;
  missingActivities: string[];
  unexpectedActivities: string[];
  changedHistory: string[];
  rows: number;
  levellingDeclared: boolean | null;
  errors: string[];
}

/** Parse a returned CSV and reconcile it against the exported package. Does not apply anything silently. */
export function reconcileImport(csv: string, pkg: HandoffPackage, expectedIds: string[], levellingApplied: boolean | null): { report: ReconcileReport; rows: Record<string, { earlyStart: string; earlyFinish: string; lateStart: string; lateFinish: string; totalFloat: number }> } {
  const errors: string[] = [];
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows: Record<string, { earlyStart: string; earlyFinish: string; lateStart: string; lateFinish: string; totalFloat: number }> = {};
  const firstIsId = lines[0]?.toUpperCase().startsWith('HO-');
  const handoffMatches = firstIsId ? lines[0].replace(/,.*$/, '') === pkg.handoffId : false;
  if (!handoffMatches) errors.push(`Returned file does not carry handoff ID ${pkg.handoffId} in its first row. It cannot be reconciled to this case, input version and changes.`);
  const header = lines.find((l) => l.toLowerCase().startsWith('id,'));
  if (!header) errors.push('Header row "id,earlyStart,earlyFinish,lateStart,lateFinish,totalFloat" not found.');
  const startIdx = header ? lines.indexOf(header) + 1 : lines.length;
  for (const l of lines.slice(startIdx)) {
    const [id, es, ef, ls, lf, tf] = l.split(',').map((x) => x.trim());
    if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(es ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(ef ?? '') || Number.isNaN(Number(tf))) { errors.push(`Row for "${id}" is malformed.`); continue; }
    rows[id] = { earlyStart: es, earlyFinish: ef, lateStart: ls, lateFinish: lf, totalFloat: Number(tf) };
  }
  const missing = expectedIds.filter((id) => !rows[id]);
  const unexpected = Object.keys(rows).filter((id) => !expectedIds.includes(id));
  const changedHistory = pkg.activities.filter((a) => a.actualFinish && rows[a.id] && rows[a.id].earlyFinish !== a.actualFinish).map((a) => a.id);
  if (missing.length) errors.push(`${missing.length} activities missing from the returned file.`);
  if (unexpected.length) errors.push(`${unexpected.length} unexpected activities returned.`);
  if (changedHistory.length) errors.push(`Actual history changed for: ${changedHistory.join(', ')}.`);
  if (levellingApplied === null) errors.push('Returned file does not declare whether resource levelling was applied.');
  return { rows, report: { ok: errors.length === 0, handoffMatches, missingActivities: missing, unexpectedActivities: unexpected, changedHistory, rows: Object.keys(rows).length, levellingDeclared: levellingApplied, errors } };
}

export function issuesText(issues: CpmIssue[]): string[] {
  return issues.map((i) => `[${i.severity}] ${i.message}`);
}

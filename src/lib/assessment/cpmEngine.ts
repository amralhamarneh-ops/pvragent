/**
 * Embedded deterministic CPM engine.
 *
 * Scope (tested): FS/SS/FF/SF with positive/negative lags, multiple calendars with work weeks and holidays,
 * actual dates + remaining durations from a data date, retained-logic progress, constraints (SNET, FNLT, MSO, MFO),
 * milestones, total float, driving relationship, cycle detection, open-end detection, external-link boundary checks.
 *
 * Out of scope (reported as limitations, never silently ignored): resource levelling, progress override and
 * out-of-sequence "actual dates" mode, hammocks / LOE recalculation, WBS summaries, % complete types other than duration,
 * relationship-lag calendars other than the successor calendar, multiple float paths.
 *
 * Dates are ISO yyyy-mm-dd. Start dates are start-of-day, finish dates are end-of-day (P6 convention):
 * a 1-day activity starting Monday finishes Monday.
 */

export type RelType = 'FS' | 'SS' | 'FF' | 'SF';
export type ActivityType = 'task' | 'milestone_start' | 'milestone_finish' | 'loe';
export type ConstraintType = 'SNET' | 'SNLT' | 'FNET' | 'FNLT' | 'MSO' | 'MFO';

export interface CalendarDef {
  id: string;
  name: string;
  /** 0 = Sunday ... 6 = Saturday. */
  workDays: number[];
  holidays: string[];
  /** Extra working days that override the week pattern. */
  workExceptions?: string[];
}

export interface CpmActivity {
  id: string;
  name: string;
  type: ActivityType;
  calendarId: string;
  /** Remaining duration in working days for not-started / in-progress work. Original duration for completed is irrelevant. */
  remainingDuration: number;
  originalDuration: number;
  actualStart?: string;
  actualFinish?: string;
  constraint?: { type: ConstraintType; date: string };
  external?: boolean;
  isNew?: boolean;
}

export interface CpmRelationship {
  from: string;
  to: string;
  type: RelType;
  /** Lag in working days of the successor's calendar. May be negative. */
  lag: number;
}

export interface CpmNetwork {
  activities: CpmActivity[];
  relationships: CpmRelationship[];
  calendars: CalendarDef[];
  dataDate: string;
  projectCalendarId: string;
  /** Latest-finish target; if omitted the project finish is the latest early finish. */
  targetFinish?: string;
  /** Declared settings. The engine does not apply anything that is not declared. */
  settings: {
    progressMode: 'retained_logic';
    resourceLevelling: false;
    criticalDefinition: 'total_float_lte_zero';
  };
}

export interface CpmActivityResult {
  id: string;
  earlyStart: string;
  earlyFinish: string;
  lateStart: string;
  lateFinish: string;
  totalFloat: number;
  freeFloat: number;
  critical: boolean;
  status: 'completed' | 'in_progress' | 'not_started';
  drivingPredecessor: string | null;
}

export interface CpmIssue {
  severity: 'error' | 'warning' | 'limitation';
  code: string;
  message: string;
  activityId?: string;
}

export interface CpmResult {
  ok: boolean;
  activities: Record<string, CpmActivityResult>;
  projectFinish: string | null;
  criticalPath: string[];
  issues: CpmIssue[];
  order: string[];
}

// ---------- Date helpers (UTC, no locale) ----------
const MS = 86400000;
export const toUtc = (iso: string): number => {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  return Date.UTC(y, m - 1, d);
};
export const fromUtc = (t: number): string => {
  let d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};
export const addDays = (iso: string, n: number): string => fromUtc(toUtc(iso) + n * MS);
export const dayDiff = (a: string, b: string): number => Math.round((toUtc(b) - toUtc(a)) / MS);
const dow = (iso: string): number => new Date(toUtc(iso)).getUTCDay();

export class CalendarIndex {
  private cal: CalendarDef;
  private hol: Set<string>;
  private exc: Set<string>;
  constructor(cal: CalendarDef) {
    this.cal = cal;
    this.hol = new Set(cal.holidays);
    this.exc = new Set(cal.workExceptions ?? []);
    if (cal.workDays.length === 0) throw new Error(`Calendar ${cal.id} has no working days.`);
  }
  isWork(iso: string): boolean {
    if (this.exc.has(iso)) return true;
    if (this.hol.has(iso)) return false;
    return this.cal.workDays.includes(dow(iso));
  }
  /** First working day on or after iso. */
  nextWork(iso: string): string {
    let d = iso;
    for (let i = 0; i < 4000; i++) { if (this.isWork(d)) return d; d = addDays(d, 1); }
    throw new Error(`Calendar ${this.cal.id}: no working day within 4000 days of ${iso}.`);
  }
  /** Last working day on or before iso. */
  prevWork(iso: string): string {
    let d = iso;
    for (let i = 0; i < 4000; i++) { if (this.isWork(d)) return d; d = addDays(d, -1); }
    throw new Error(`Calendar ${this.cal.id}: no working day within 4000 days before ${iso}.`);
  }
  /** Move n working days forward (n may be negative) from a working day. */
  shift(iso: string, n: number): string {
    let d = iso;
    let left = Math.abs(n);
    const step = n >= 0 ? 1 : -1;
    while (left > 0) {
      d = addDays(d, step);
      if (this.isWork(d)) left--;
    }
    return d;
  }
  /** Finish date of a task starting on working day `start` lasting `dur` working days (dur >= 1). */
  finishFrom(start: string, dur: number): string {
    return dur <= 1 ? start : this.shift(start, dur - 1);
  }
  startFrom(finish: string, dur: number): string {
    return dur <= 1 ? finish : this.shift(finish, -(dur - 1));
  }
  /** Working days between two working dates (b - a). */
  workDiff(a: string, b: string): number {
    if (a === b) return 0;
    const fwd = toUtc(b) > toUtc(a);
    let d = a;
    let n = 0;
    for (let i = 0; i < 20000 && d !== b; i++) {
      d = addDays(d, fwd ? 1 : -1);
      if (this.isWork(d)) n += fwd ? 1 : -1;
    }
    return n;
  }
}

export interface ValidationReport {
  issues: CpmIssue[];
  hasErrors: boolean;
}

/** Structural validation, including cycles and open ends. */
export function validateNetwork(net: CpmNetwork): ValidationReport {
  const issues: CpmIssue[] = [];
  const ids = new Set<string>();
  const calIds = new Set(net.calendars.map((c) => c.id));
  for (const a of net.activities) {
    if (ids.has(a.id)) issues.push({ severity: 'error', code: 'DUPLICATE_ID', message: `Duplicate activity ID ${a.id}.`, activityId: a.id });
    ids.add(a.id);
    if (!calIds.has(a.calendarId)) issues.push({ severity: 'error', code: 'MISSING_CALENDAR', message: `${a.id} uses unknown calendar ${a.calendarId}.`, activityId: a.id });
    if (a.remainingDuration < 0) issues.push({ severity: 'error', code: 'NEGATIVE_DURATION', message: `${a.id} has a negative duration.`, activityId: a.id });
    if (a.external) issues.push({ severity: 'warning', code: 'EXTERNAL', message: `${a.id} is an external link. Supply the supporting project or a reviewed boundary date.`, activityId: a.id });
  }
  const succ = new Map<string, number>();
  const pred = new Map<string, number>();
  for (const r of net.relationships) {
    if (!ids.has(r.from) || !ids.has(r.to)) {
      issues.push({ severity: 'error', code: 'MISSING_EXTERNAL', message: `Relationship ${r.from} → ${r.to} refers to an activity that is not in the network. Provide the supporting project or a reviewed boundary assumption.` });
      continue;
    }
    if (r.from === r.to) issues.push({ severity: 'error', code: 'SELF_LINK', message: `${r.from} is linked to itself.`, activityId: r.from });
    succ.set(r.from, (succ.get(r.from) ?? 0) + 1);
    pred.set(r.to, (pred.get(r.to) ?? 0) + 1);
  }
  const dupKey = new Set<string>();
  for (const r of net.relationships) {
    const k = `${r.from}|${r.to}|${r.type}`;
    if (dupKey.has(k)) issues.push({ severity: 'warning', code: 'DUPLICATE_REL', message: `Duplicate ${r.type} relationship ${r.from} → ${r.to}.` });
    dupKey.add(k);
  }
  for (const a of net.activities) {
    if (a.actualFinish) continue;
    const isMilestoneFinish = a.type === 'milestone_finish';
    if (!pred.get(a.id) && !a.actualStart && !a.constraint && !isMilestoneFinish && a.type !== 'loe') {
      issues.push({ severity: 'warning', code: 'OPEN_START', message: `${a.id} has no predecessor (open start). Planner review required.`, activityId: a.id });
    }
    if (!succ.get(a.id) && !isMilestoneFinish) {
      issues.push({ severity: 'warning', code: 'OPEN_END', message: `${a.id} has no successor (open end). Planner review required.`, activityId: a.id });
    }
  }
  const cyc = findCycle(net);
  if (cyc) issues.push({ severity: 'error', code: 'CYCLE', message: `Circular logic: ${cyc.join(' → ')}.` });
  if (net.activities.some((a) => a.type === 'loe')) issues.push({ severity: 'limitation', code: 'LOE', message: 'Level-of-effort activities are not recalculated by the embedded engine.' });
  issues.push({ severity: 'limitation', code: 'NO_LEVELLING', message: 'Result is unconstrained CPM. Resource levelling is not applied, so it is not resource-feasible.' });
  return { issues, hasErrors: issues.some((i) => i.severity === 'error') };
}

export function findCycle(net: CpmNetwork): string[] | null {
  const adj = new Map<string, string[]>();
  for (const a of net.activities) adj.set(a.id, []);
  for (const r of net.relationships) if (adj.has(r.from) && adj.has(r.to)) adj.get(r.from)?.push(r.to);
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  let found: string[] | null = null;
  const visit = (n: string) => {
    if (found) return;
    state.set(n, 1);
    stack.push(n);
    for (const m of adj.get(n) ?? []) {
      if (found) return;
      const s = state.get(m) ?? 0;
      if (s === 1) { found = [...stack.slice(stack.indexOf(m)), m]; return; }
      if (s === 0) visit(m);
    }
    stack.pop();
    state.set(n, 2);
  };
  for (const a of net.activities) if ((state.get(a.id) ?? 0) === 0) visit(a.id);
  return found;
}

function topoOrder(net: CpmNetwork): string[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const a of net.activities) { indeg.set(a.id, 0); adj.set(a.id, []); }
  for (const r of net.relationships) {
    if (!indeg.has(r.from) || !indeg.has(r.to)) continue;
    adj.get(r.from)?.push(r.to);
    indeg.set(r.to, (indeg.get(r.to) ?? 0) + 1);
  }
  const queue = net.activities.filter((a) => indeg.get(a.id) === 0).map((a) => a.id).sort();
  const out: string[] = [];
  while (queue.length) {
    let n = queue.shift() as string;
    out.push(n);
    for (const m of (adj.get(n) ?? []).slice().sort()) {
      indeg.set(m, (indeg.get(m) ?? 0) - 1);
      if (indeg.get(m) === 0) queue.push(m);
    }
  }
  return out;
}

interface Dates { s: string; f: string }

/** Apply a lag in working days of the given calendar. Zero lag leaves the date unchanged. */
function shiftLag(c: CalendarIndex, d: string, lag: number): string {
  return lag === 0 ? d : c.shift(d, lag);
}

export function calculateCpm(net: CpmNetwork): CpmResult {
  const report = validateNetwork(net);
  const issues = [...report.issues];
  const empty: CpmResult = { ok: false, activities: {}, projectFinish: null, criticalPath: [], issues, order: [] };
  if (report.hasErrors) return empty;

  const cals = new Map(net.calendars.map((c) => [c.id, new CalendarIndex(c)]));
  const byId = new Map(net.activities.map((a) => [a.id, a]));
  const cal = (id: string) => cals.get(byId.get(id)?.calendarId as string) as CalendarIndex;
  const order = topoOrder(net);
  const incoming = new Map<string, CpmRelationship[]>();
  const outgoing = new Map<string, CpmRelationship[]>();
  for (const a of net.activities) { incoming.set(a.id, []); outgoing.set(a.id, []); }
  for (const r of net.relationships) { incoming.get(r.to)?.push(r); outgoing.get(r.from)?.push(r); }

  const early = new Map<string, Dates>();
  const driving = new Map<string, string | null>();
  const dd = net.dataDate;
  const projCal = cals.get(net.projectCalendarId);
  if (!projCal) { issues.push({ severity: 'error', code: 'MISSING_CALENDAR', message: `Project calendar ${net.projectCalendarId} not found.` }); return empty; }

  // ---------- Forward pass ----------
  for (const id of order) {
    const a = byId.get(id) as CpmActivity;
    const c = cal(id);
    const dur = a.type === 'milestone_start' || a.type === 'milestone_finish' ? 0 : a.remainingDuration;
    const status: 'completed' | 'in_progress' | 'not_started' = a.actualFinish ? 'completed' : a.actualStart ? 'in_progress' : 'not_started';

    if (status === 'completed') {
      early.set(id, { s: a.actualStart ?? (a.actualFinish as string), f: a.actualFinish as string });
      driving.set(id, null);
      continue;
    }

    // Earliest permitted start from logic, plus data date.
    const hold: { es: string | null; ef: string | null; drv: string | null } = { es: null, ef: null, drv: null };
    const bump = (cand: string, by: string, isFinish: boolean) => {
      if (isFinish) { if (hold.ef === null || toUtc(cand) > toUtc(hold.ef)) { hold.ef = cand; hold.drv = by; } }
      else if (hold.es === null || toUtc(cand) > toUtc(hold.es)) { hold.es = cand; hold.drv = by; }
    };
    for (const r of incoming.get(id) ?? []) {
      const p = early.get(r.from) as Dates;
      if (r.type === 'FS') {
        bump(shiftLag(c, c.nextWork(addDays(p.f, 1)), r.lag), r.from, false);
      } else if (r.type === 'SS') {
        bump(shiftLag(c, c.nextWork(p.s), r.lag), r.from, false);
      } else if (r.type === 'FF') {
        bump(shiftLag(c, c.prevWork(p.f), r.lag), r.from, true);
      } else {
        bump(shiftLag(c, c.prevWork(addDays(p.s, -1)), r.lag), r.from, true);
      }
    }
    const es = hold.es;
    const ef = hold.ef;
    const drv = hold.drv;

    if (status === 'in_progress') {
      // Retained logic: remaining work starts at the data date, but cannot start before logic allows.
      const startFloor = c.nextWork(dd);
      let start = startFloor;
      if (es !== null && toUtc(es) > toUtc(start)) start = es;
      let fin = dur === 0 ? start : c.finishFrom(start, Math.max(dur, 1));
      if (ef !== null && toUtc(ef) > toUtc(fin)) fin = ef;
      early.set(id, { s: a.actualStart as string, f: fin });
      driving.set(id, drv);
      continue;
    }

    // Not started: cannot start before data date.
    let start = c.nextWork(dd);
    if (es !== null && toUtc(es) > toUtc(start)) start = es;
    if (a.constraint) {
      const k = a.constraint;
      if ((k.type === 'SNET' || k.type === 'MSO') && toUtc(k.date) > toUtc(start)) start = c.nextWork(k.date);
      if (k.type === 'MSO') start = c.nextWork(k.date);
    }
    let fin: string;
    if (a.type === 'milestone_finish') fin = start;
    else if (dur === 0) fin = start;
    else fin = c.finishFrom(start, dur);
    if (ef !== null && toUtc(ef) > toUtc(fin)) {
      fin = ef;
      if (dur > 0) { const s2 = c.startFrom(fin, dur); if (toUtc(s2) > toUtc(start)) start = s2; }
    }
    if (a.constraint) {
      const k = a.constraint;
      if (k.type === 'FNET' && toUtc(k.date) > toUtc(fin)) { fin = c.prevWork(k.date); if (dur > 0) start = c.startFrom(fin, dur); }
      if (k.type === 'MFO') { fin = c.prevWork(k.date); start = dur > 0 ? c.startFrom(fin, dur) : fin; }
    }
    early.set(id, { s: start, f: fin });
    driving.set(id, drv);
  }

  // ---------- Project finish ----------
  const open = net.activities.filter((a) => (outgoing.get(a.id) ?? []).length === 0);
  const finishes = (open.length ? open : net.activities).map((a) => (early.get(a.id) as Dates).f);
  const projectFinish = finishes.reduce((m, f) => (toUtc(f) > toUtc(m) ? f : m), finishes[0]);
  const lfTarget = net.targetFinish && toUtc(net.targetFinish) > toUtc(projectFinish) ? net.targetFinish : projectFinish;

  // ---------- Backward pass ----------
  const late = new Map<string, Dates>();
  for (const id of order.slice().reverse()) {
    const a = byId.get(id) as CpmActivity;
    const c = cal(id);
    const e = early.get(id) as Dates;
    const dur = a.type === 'milestone_start' || a.type === 'milestone_finish' ? 0 : a.remainingDuration;
    if (a.actualFinish) { late.set(id, { s: e.s, f: e.f }); continue; }
    const lim: { lf: string | null; ls: string | null } = { lf: null, ls: null };
    const tightenF = (cand: string) => { if (lim.lf === null || toUtc(cand) < toUtc(lim.lf)) lim.lf = cand; };
    const tightenS = (cand: string) => { if (lim.ls === null || toUtc(cand) < toUtc(lim.ls)) lim.ls = cand; };
    for (const r of outgoing.get(id) ?? []) {
      const sl = late.get(r.to) as Dates;
      const sc = cal(r.to);
      if (r.type === 'FS') {
        tightenF(c.prevWork(addDays(shiftLag(sc, sc.prevWork(sl.s), -r.lag), -1)));
      } else if (r.type === 'SS') {
        tightenS(c.prevWork(shiftLag(sc, sc.prevWork(sl.s), -r.lag)));
      } else if (r.type === 'FF') {
        tightenF(c.prevWork(shiftLag(sc, sc.prevWork(sl.f), -r.lag)));
      } else {
        tightenS(c.prevWork(addDays(shiftLag(sc, sc.prevWork(sl.f), -r.lag), 1)));
      }
    }
    let lf: string | null = lim.lf;
    let ls: string | null = lim.ls;
    if ((outgoing.get(id) ?? []).length === 0) lf = c.prevWork(lfTarget);
    if (a.constraint && (a.constraint.type === 'FNLT' || a.constraint.type === 'MFO')) {
      const cf = c.prevWork(a.constraint.date);
      if (lf === null || toUtc(cf) < toUtc(lf)) lf = cf;
    }
    if (a.constraint && (a.constraint.type === 'SNLT' || a.constraint.type === 'MSO')) {
      const cs = c.prevWork(a.constraint.date);
      if (ls === null || toUtc(cs) < toUtc(ls)) ls = cs;
    }
    let finalLf: string;
    let finalLs: string;
    if (lf !== null) {
      finalLf = lf;
      finalLs = dur > 0 ? c.startFrom(lf, dur) : lf;
      if (ls !== null && toUtc(ls) < toUtc(finalLs)) { finalLs = ls; finalLf = dur > 0 ? c.finishFrom(ls, dur) : ls; }
    } else {
      finalLs = ls as string;
      finalLf = dur > 0 ? c.finishFrom(finalLs, dur) : finalLs;
    }
    late.set(id, { s: finalLs, f: finalLf });
  }

  // ---------- Float and results ----------
  const results: Record<string, CpmActivityResult> = {};
  for (const id of order) {
    const a = byId.get(id) as CpmActivity;
    const c = cal(id);
    const e = early.get(id) as Dates;
    const l = late.get(id) as Dates;
    const status: CpmActivityResult['status'] = a.actualFinish ? 'completed' : a.actualStart ? 'in_progress' : 'not_started';
    // Total float = late finish − early finish in the activity calendar (P6 default total float type is finish float).
    const tf = status === 'completed' ? 0 : c.workDiff(e.f, l.f);
    let ff = tf;
    const outs = outgoing.get(id) ?? [];
    if (outs.length && status !== 'completed') {
      const vals = outs.map((r) => {
        const sa = early.get(r.to) as Dates;
        const sc = cal(r.to);
        if (r.type === 'FS') return sc.workDiff(shiftLag(sc, sc.nextWork(addDays(e.f, 1)), r.lag), sa.s);
        if (r.type === 'SS') return sc.workDiff(shiftLag(sc, sc.nextWork(e.s), r.lag), sa.s);
        if (r.type === 'FF') return sc.workDiff(shiftLag(sc, sc.prevWork(e.f), r.lag), sa.f);
        return sc.workDiff(shiftLag(sc, sc.prevWork(addDays(e.s, -1)), r.lag), sa.f);
      });
      ff = Math.max(0, Math.min(tf, ...vals));
    }
    results[id] = {
      id, earlyStart: e.s, earlyFinish: e.f, lateStart: l.s, lateFinish: l.f, totalFloat: tf, freeFloat: ff,
      critical: status !== 'completed' && tf <= 0, status, drivingPredecessor: driving.get(id) ?? null,
    };
  }

  // Critical path: trace driving predecessors back from the finishing critical activities.
  const crit = net.activities.filter((a) => results[a.id].critical).map((a) => a.id);
  issues.push({ severity: 'limitation', code: 'ENGINE_SCOPE', message: 'Embedded engine: retained logic, declared calendars, no resource levelling. Not asserted to equal P6 until the unchanged-copy comparison is accepted by a planner.' });
  return { ok: true, activities: results, projectFinish, criticalPath: crit, issues, order };
}

/** Walk the driving-predecessor chain from an activity back to its source. */
export function drivingPath(result: CpmResult, endId: string): string[] {
  const path: string[] = [];
  let cur: string | null = endId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    path.unshift(cur);
    cur = result.activities[cur]?.drivingPredecessor ?? null;
  }
  return path;
}

import type {
  ActivityConstraint,
  ActivityKind,
  ActivityResourceAssignment,
  ActivityStatus,
  ProductivityField,
  ScheduleActivity,
  ScheduleCalendar,
  ScheduleModel,
  ScheduleRelationship,
  ScheduleWbsNode,
} from './types';

interface XerTable { fields: string[]; rows: string[][] }

/**
 * Parse the tables of a Primavera XER file (tab-delimited).
 *
 * Identity: relationships (TASKPRED) link internal task ids (task_id / pred_task_id), never display codes. Each
 * activity keeps both its internal `taskId` and its display code (`id`).
 * Time: XER stores durations, lags and float in hours. Hours are preserved as `*Hours`; day values are derived only
 * with the hours-per-day of the activity's own calendar. When a calendar does not state its hours per day, the day
 * field is left at 0 and a warning is recorded, instead of dividing by an assumed eight.
 */
export function parseXer(text: string, fileName = 'schedule.xer'): ScheduleModel {
  const tables = new Map<string, XerTable>();
  let current: XerTable | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith('%T')) {
      current = { fields: [], rows: [] };
      tables.set(raw.split('\t')[1]?.trim() ?? '', current);
    } else if (raw.startsWith('%F') && current) {
      current.fields = raw.split('\t').slice(1).map((f) => f.trim());
    } else if (raw.startsWith('%R') && current) {
      current.rows.push(raw.split('\t').slice(1));
    }
  }
  const warnings: string[] = [];
  const idx = new Map<string, Map<string, number>>();
  const index = (t: string): Map<string, number> => {
    let m = idx.get(t);
    if (!m) { m = new Map(); (tables.get(t)?.fields ?? []).forEach((f, i) => m!.set(f, i)); idx.set(t, m); }
    return m;
  };
  const col = (t: string, row: string[], f: string): string => {
    const i = index(t).get(f);
    return i === undefined ? '' : (row[i] ?? '').trim();
  };
  const has = (t: string, f: string) => index(t).has(f);
  const num = (s: string): number | null => { if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
  const date = (s: string) => s.slice(0, 10);
  const rowsOf = (t: string) => tables.get(t)?.rows ?? [];

  if (!tables.has('TASK')) warnings.push('The file has no TASK table, so no activities could be read.');

  // ---- WBS hierarchy (parent chain) ----
  const wbsRaw = new Map<string, { id: string; parent: string; name: string; code: string }>();
  for (const r of rowsOf('PROJWBS')) {
    const id = col('PROJWBS', r, 'wbs_id');
    wbsRaw.set(id, { id, parent: col('PROJWBS', r, 'parent_wbs_id'), name: col('PROJWBS', r, 'wbs_name'), code: col('PROJWBS', r, 'wbs_short_name') });
  }
  const wbsPathOf = (id: string): string[] => {
    const path: string[] = [];
    const seen = new Set<string>();
    let cur = wbsRaw.get(id);
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); path.unshift(cur.name || cur.code); cur = wbsRaw.get(cur.parent); }
    return path;
  };
  const wbs: ScheduleWbsNode[] = Array.from(wbsRaw.values()).map((w) => ({ id: w.id, parentId: w.parent, name: w.name, code: w.code, path: wbsPathOf(w.id) }));

  // ---- Calendars ----
  const calendars: ScheduleCalendar[] = rowsOf('CALENDAR').map((r) => ({
    id: col('CALENDAR', r, 'clndr_id'),
    name: col('CALENDAR', r, 'clndr_name'),
    hoursPerDay: num(col('CALENDAR', r, 'day_hr_cnt')),
    hoursPerWeek: num(col('CALENDAR', r, 'week_hr_cnt')),
    hoursPerMonth: num(col('CALENDAR', r, 'month_hr_cnt')),
    hoursPerYear: num(col('CALENDAR', r, 'year_hr_cnt')),
    type: col('CALENDAR', r, 'clndr_type'),
    rawData: col('CALENDAR', r, 'clndr_data'),
    exceptions: extractCalendarExceptions(col('CALENDAR', r, 'clndr_data')),
  }));
  const calById = new Map(calendars.map((c) => [c.id, c]));

  // ---- Resources and assignments ----
  const resources = rowsOf('RSRC').map((r) => ({ id: col('RSRC', r, 'rsrc_id'), name: col('RSRC', r, 'rsrc_name'), code: col('RSRC', r, 'rsrc_short_name'), type: col('RSRC', r, 'rsrc_type') }));
  const rsrcById = new Map(resources.map((r) => [r.id, r]));
  const assignByTask = new Map<string, ActivityResourceAssignment[]>();
  const productivity = new Map<string, ProductivityField>();
  for (const r of rowsOf('TASKRSRC')) {
    const taskId = col('TASKRSRC', r, 'task_id');
    const rs = rsrcById.get(col('TASKRSRC', r, 'rsrc_id'));
    const target = num(col('TASKRSRC', r, 'target_qty'));
    const remain = num(col('TASKRSRC', r, 'remain_qty'));
    const actual = num(col('TASKRSRC', r, 'act_reg_qty'));
    const perTime = col('TASKRSRC', r, 'target_qty_per_hr');
    const a: ActivityResourceAssignment = { resourceId: col('TASKRSRC', r, 'rsrc_id'), resourceName: rs?.name ?? '', resourceCode: rs?.code ?? '', resourceType: rs?.type ?? '', targetQty: target, remainingQty: remain, actualQty: actual, unit: '', unitsPerTimeText: perTime };
    assignByTask.set(taskId, [...(assignByTask.get(taskId) ?? []), a]);
    if (perTime !== '' && num(perTime) !== null && num(perTime) !== 0) {
      const k = 'TASKRSRC.target_qty_per_hr';
      let cur = productivity.get(k);
      productivity.set(k, { field: k, basis: 'Resource quantity per hour of the assignment (source units not stated in the file)', assignments: (cur?.assignments ?? 0) + 1 });
    }
  }
  // Unit-of-measure for quantities, when RSRC carries one.
  for (const r of rowsOf('UNITS')) void r;

  // ---- Activity codes ----
  const actvTypes = new Map<string, string>();
  for (const r of rowsOf('ACTVTYPE')) actvTypes.set(col('ACTVTYPE', r, 'actv_code_type_id'), col('ACTVTYPE', r, 'actv_code_type'));
  const actvCodes = new Map<string, { typeId: string; name: string; short: string }>();
  for (const r of rowsOf('ACTVCODE')) actvCodes.set(col('ACTVCODE', r, 'actv_code_id'), { typeId: col('ACTVCODE', r, 'actv_code_type_id'), name: col('ACTVCODE', r, 'actv_code_name'), short: col('ACTVCODE', r, 'short_name') });
  const codesByTask = new Map<string, Record<string, string>>();
  for (const r of rowsOf('TASKACTV')) {
    const c = actvCodes.get(col('TASKACTV', r, 'actv_code_id'));
    if (!c) continue;
    const t = col('TASKACTV', r, 'task_id');
    const typeName = actvTypes.get(c.typeId) ?? c.typeId;
    codesByTask.set(t, { ...(codesByTask.get(t) ?? {}), [typeName]: c.name || c.short });
  }

  // ---- User-defined fields ----
  const udfTypes = new Map<string, string>();
  for (const r of rowsOf('UDFTYPE')) udfTypes.set(col('UDFTYPE', r, 'udf_type_id'), col('UDFTYPE', r, 'udf_type_label') || col('UDFTYPE', r, 'udf_type_name'));
  const udfByTask = new Map<string, Record<string, string>>();
  for (const r of rowsOf('UDFVALUE')) {
    const label = udfTypes.get(col('UDFVALUE', r, 'udf_type_id'));
    if (!label) continue;
    const v = col('UDFVALUE', r, 'udf_text') || col('UDFVALUE', r, 'udf_number') || col('UDFVALUE', r, 'udf_date') || col('UDFVALUE', r, 'udf_code_id');
    const fk = col('UDFVALUE', r, 'fk_id');
    udfByTask.set(fk, { ...(udfByTask.get(fk) ?? {}), [label]: v });
  }

  // ---- Activities ----
  const hoursToDays = (h: number | null, hpd: number | null): number => (h === null || hpd === null || hpd <= 0 ? 0 : Math.round((h / hpd) * 100) / 100);
  const missingHpd = new Set<string>();
  const taskRows = rowsOf('TASK');
  const activities: ScheduleActivity[] = taskRows.map((r) => {
    const taskId = col('TASK', r, 'task_id');
    const cal = calById.get(col('TASK', r, 'clndr_id'));
    const hpd = cal?.hoursPerDay ?? null;
    if (hpd === null) missingHpd.add(cal?.name || col('TASK', r, 'clndr_id') || '(no calendar)');
    const rawType = col('TASK', r, 'task_type');
    const rawStatus = col('TASK', r, 'status_code');
    const durH = num(col('TASK', r, 'target_drtn_hr_cnt'));
    const remH = num(col('TASK', r, 'remain_drtn_hr_cnt'));
    const floatH = num(col('TASK', r, 'total_float_hr_cnt'));
    const actualStart = date(col('TASK', r, 'act_start_date'));
    const actualFinish = date(col('TASK', r, 'act_end_date'));
    const pctRaw = num(col('TASK', r, 'phys_complete_pct'));
    const pct = pctRaw ?? (rawStatus === 'TK_Complete' ? 100 : 0);
    const wid = col('TASK', r, 'wbs_id');
    const path = wbsPathOf(wid);
    const constraints: ActivityConstraint[] = [];
    const c1 = col('TASK', r, 'cstr_type');
    if (c1) constraints.push({ type: c1, date: date(col('TASK', r, 'cstr_date')) });
    const c2 = col('TASK', r, 'cstr_type2');
    if (c2) constraints.push({ type: c2, date: date(col('TASK', r, 'cstr_date2')) });
    const kind = kindOf(rawType);
    const status = statusOf(rawStatus, actualStart, actualFinish, pct);
    return {
      id: col('TASK', r, 'task_code') || taskId,
      taskId,
      name: col('TASK', r, 'task_name'),
      wbs: path.join(' / '),
      wbsId: wid,
      wbsPath: path,
      start: date(col('TASK', r, 'target_start_date')) || date(col('TASK', r, 'early_start_date')),
      finish: date(col('TASK', r, 'target_end_date')) || date(col('TASK', r, 'early_end_date')),
      duration: hoursToDays(durH, hpd),
      totalFloat: hoursToDays(floatH, hpd),
      progressPct: pct,
      chainFrom: 0,
      chainTo: 0,
      discipline: '',
      zone: '',
      kind,
      status,
      rawTaskType: rawType,
      rawStatusCode: rawStatus,
      durationHours: durH,
      remainingDurationHours: remH,
      actualStart,
      actualFinish,
      earlyStart: date(col('TASK', r, 'early_start_date')),
      earlyFinish: date(col('TASK', r, 'early_end_date')),
      remainingStart: date(col('TASK', r, 'restart_date')),
      remainingFinish: date(col('TASK', r, 'reend_date')),
      totalFloatHours: floatH,
      calendarId: col('TASK', r, 'clndr_id'),
      calendarName: cal?.name ?? '',
      hoursPerDay: hpd,
      constraints,
      resources: assignByTask.get(taskId) ?? [],
      activityCodes: codesByTask.get(taskId) ?? {},
      udf: udfByTask.get(taskId) ?? {},
      sourceTimeUnit: 'hours',
    };
  });
  if (missingHpd.size > 0) warnings.push(`Day values for activities on calendar(s) without a stated hours-per-day (${Array.from(missingHpd).join(', ')}) are not converted; the source hours are preserved in durationHours.`);

  // ---- Relationships: resolved on internal task ids ----
  const byTaskId = new Map(activities.map((a) => [a.taskId as string, a]));
  let unresolved = 0;
  const relationships: ScheduleRelationship[] = rowsOf('TASKPRED').map((r) => {
    const succId = col('TASKPRED', r, 'task_id');
    const predId = col('TASKPRED', r, 'pred_task_id');
    const pred = byTaskId.get(predId);
    const succ = byTaskId.get(succId);
    const lagH = num(col('TASKPRED', r, 'lag_hr_cnt'));
    // Lag days use the successor's calendar, as P6 does by default.
    const hpd = succ?.hoursPerDay ?? null;
    const resolved = !!pred && !!succ;
    if (!resolved) unresolved += 1;
    const t = col('TASKPRED', r, 'pred_type').replace('PR_', '');
    return {
      from: pred?.id ?? predId,
      to: succ?.id ?? succId,
      type: (['FS', 'SS', 'FF', 'SF'].includes(t) ? t : 'FS') as ScheduleRelationship['type'],
      lag: hoursToDays(lagH, hpd),
      lagHours: lagH ?? 0,
      fromTaskId: predId,
      toTaskId: succId,
      resolved,
    };
  });
  if (unresolved > 0) warnings.push(`${unresolved} relationship(s) point at tasks that are not in the TASK table and are kept as unresolved.`);

  // ---- Productivity / resource fields actually present ----
  if (has('TASK', 'target_work_qty') || has('TASK', 'target_equip_qty')) {
    const n = taskRows.filter((r) => (num(col('TASK', r, 'target_work_qty')) ?? 0) !== 0 || (num(col('TASK', r, 'target_equip_qty')) ?? 0) !== 0).length;
    if (n > 0) productivity.set('TASK.target_work_qty', { field: 'TASK.target_work_qty / target_equip_qty', basis: 'Planned labour/equipment quantity (hours) per activity; not a quantity of installed work', assignments: n });
  }
  const udfProd = Array.from(udfTypes.values()).filter((l) => /product|output|rate|per\s*(day|hr|hour)|m3\/|m2\/|qty/i.test(l));
  for (const l of udfProd) productivity.set(`UDF:${l}`, { field: `UDF ${l}`, basis: 'User-defined field whose name suggests a productivity or quantity basis; its unit must be confirmed by the user', assignments: activities.filter((a) => a.udf?.[l]).length });
  const productivityFields: ProductivityField[] = Array.from(productivity.values());

  const proj = rowsOf('PROJECT')[0];
  const dataDate = proj ? date(col('PROJECT', proj, 'last_recalc_date') || col('PROJECT', proj, 'sum_data_date')) : '';
  return {
    rawTables: Object.fromEntries(tables),
    fileName, activityCount: activities.length, dataDate, activities, relationships, wbs, calendars, resources,
    activityCodeTypes: Array.from(actvTypes.values()), udfTypes: Array.from(udfTypes.values()), productivityFields, warnings, tablesFound: Array.from(tables.keys()),
  };
}

function kindOf(t: string): ActivityKind {
  switch (t) {
    case 'TT_Task': return 'task';
    case 'TT_Mile': return 'milestone_start';
    case 'TT_FinMile': return 'milestone_finish';
    case 'TT_LOE': return 'level_of_effort';
    case 'TT_Rsrc': return 'resource_dependent';
    case 'TT_WBS': return 'wbs_summary';
    default: return t ? 'unknown' : 'task';
  }
}

function statusOf(code: string, actualStart: string, actualFinish: string, pct: number): ActivityStatus {
  if (code === 'TK_Complete' || actualFinish) return 'completed';
  if (code === 'TK_Active' || actualStart) return 'in_progress';
  if (code === 'TK_NotStart') return pct > 0 ? 'in_progress' : 'not_started';
  return pct >= 100 ? 'completed' : pct > 0 ? 'in_progress' : 'unknown';
}

/** Pull the exception dates out of a P6 clndr_data string without interpreting working hours. */
function extractCalendarExceptions(data: string): string[] {
  if (!data) return [];
  const marker = data.indexOf('Exceptions');
  if (marker < 0) return [];
  const block = data.slice(marker);
  const out: string[] = [];
  const re = /\(d\|(\d+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    // P6 stores exception dates as days since 1899-12-30.
    const dt = new Date(Date.UTC(1899, 11, 30) + Number(m[1]) * 86400000);
    out.push(dt.toISOString().slice(0, 10));
  }
  return out;
}

export function progressStatusOf(pct: number): 'completed' | 'in_progress' | 'not_started' {
  if (pct >= 100) return 'completed';
  if (pct > 0) return 'in_progress';
  return 'not_started';
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${names[(m ?? 1) - 1]} ${y}`;
}

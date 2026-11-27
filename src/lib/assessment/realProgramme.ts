import type { ScheduleModel } from '../mapping/types';
import { addDays, calculateCpm, dayDiff, type CalendarDef, type ConstraintType, type CpmNetwork, type CpmResult } from './cpmEngine';

function table(model: ScheduleModel, name: string): Record<string, string>[] {
  const t = model.rawTables?.[name];
  return t ? t.rows.map(r => Object.fromEntries(t.fields.map((f, i) => [f, (r[i] ?? '').trim()]))) : [];
}
const iso = (v = '') => {
  if (!/^\d{4}-\d{2}-\d{2}(?:$|[ T])/.test(v)) return '';
  const d = v.slice(0, 10);
  const instant = new Date(`${d}T00:00:00Z`);
  return Number.isFinite(instant.valueOf()) && instant.toISOString().slice(0, 10) === d ? d : '';
};
const idOf = (a: ScheduleModel['activities'][number]) => a.taskId ?? a.id;
const setting = (m: ScheduleModel, projectId?: string) => table(m, 'SCHEDOPTIONS').filter(r => r.proj_id === projectId);
const comparableNumber = (v: string) => v && Number.isFinite(Number(v)) ? Number(v) : v ?? '';
const comparableCalendar = (c: NonNullable<ScheduleModel['calendars']>[number]) =>
  JSON.stringify([c.hoursPerDay, c.hoursPerWeek, c.hoursPerMonth, c.hoursPerYear, c.rawData]);
const settingFields = [
  'sched_outer_depend_type','sched_open_critical_flag','sched_lag_early_start_flag','sched_retained_logic',
  'sched_float_type','sched_calendar_on_relationship_lag','sched_use_expect_end_flag','sched_progress_override',
  'sched_use_project_end_date_for_float','enable_multiple_longest_path_calc','limit_multiple_longest_path_calc',
  'max_multiple_longest_path','use_total_float_multiple_longest_paths',
];
const projectFields = ['critical_path_type','critical_drtn_hr_cnt','plan_start_date','plan_end_date'];

export function describeProgramme(model: ScheduleModel) {
  const projects = table(model, 'PROJECT');
  const p = projects[0];
  const tasks = table(model, 'TASK');
  const map = new Map(tasks.map(t => [t.task_id, t]));
  const milestone = model.activities.filter(a => a.kind === 'milestone_finish').map(a => ({
    code: a.id, name: a.name, forecast: map.get(a.taskId ?? '')?.early_end_date || a.earlyFinish || '',
    floatHours: a.totalFloatHours ?? null,
  }));
  return { projectCount: projects.length, projectCode: p?.proj_short_name || '', dataDate: p?.last_recalc_date || p?.sum_data_date || model.dataDate,
    forecast: p?.scd_end_date || '', activityCount: model.activities.length, relationships: model.relationships.length,
    actualActivityCount: model.activities.filter(a => a.actualStart || a.actualFinish).length,
    unresolvedRelationships: model.relationships.filter(r => !r.resolved).length, milestone };
}

/** The impacted XER is reference evidence; never an input into the prediction. Align by activity code, not by re-export IDs. */
export function compareProgrammeEvidence(source: ScheduleModel, reference: ScheduleModel) {
  const lhs = describeProgramme(source), rhs = describeProgramme(reference);
  const a = new Map(table(source, 'TASK').map(t => [t.task_code || t.task_id, t]));
  const b = new Map(table(reference, 'TASK').map(t => [t.task_code || t.task_id, t]));
  const duplicateCodes = a.size !== source.activities.length || b.size !== reference.activities.length ||
    [...a.values(), ...b.values()].some(t => !t.task_code || !t.task_id);
  const sourceProject = table(source, 'PROJECT')[0], referenceProject = table(reference, 'PROJECT')[0];
  const scheduleSettingsA = setting(source, sourceProject?.proj_id), scheduleSettingsB = setting(reference, referenceProject?.proj_id);
  const changedSettingFields = [
    ...settingFields.filter(k => (scheduleSettingsA[0]?.[k] ?? '') !== (scheduleSettingsB[0]?.[k] ?? '')),
    ...projectFields.filter(k => (sourceProject?.[k] ?? '') !== (referenceProject?.[k] ?? '')),
  ];
  const calendarsA = new Map((source.calendars ?? []).map(c => [c.id, comparableCalendar(c)]));
  const calendarsB = new Map((reference.calendars ?? []).map(c => [c.id, comparableCalendar(c)]));
  const sourceProjectCalendar = calendarsA.get(sourceProject?.clndr_id);
  const referenceProjectCalendar = calendarsB.get(referenceProject?.clndr_id);
  const projectCalendarChanged = Boolean(sourceProjectCalendar && referenceProjectCalendar && sourceProjectCalendar !== referenceProjectCalendar);
  const checks = [
    ...(lhs.projectCount !== 1 || rhs.projectCount !== 1 ? ['Both XERs must contain a single project.'] : []),
    ...(duplicateCodes ? ['Activity codes are not unique or source task identities are incomplete.'] : []),
    ...(!iso(lhs.dataDate) || !iso(rhs.dataDate) || lhs.dataDate !== rhs.dataDate ? ['The XERs have different or missing data dates.'] : []),
    ...(!iso(lhs.forecast) || !iso(rhs.forecast) ? ['A stored forecast completion date is missing or invalid.'] : []),
    ...(source.integrityProblems?.length || reference.integrityProblems?.length ? ['One or both imports have structural diagnostics.'] : []),
    ...(lhs.unresolvedRelationships || rhs.unresolvedRelationships ? ['One or both XERs contain unresolved relationships; logic comparison is incomplete.'] : []),
    ...(scheduleSettingsA.length !== 1 || scheduleSettingsB.length !== 1 ? ['A unique project scheduling-options row is not available in both exports.'] : []),
    ...(changedSettingFields.length ? ['Stored project or scheduling settings differ between exports.'] : []),
    ...(projectCalendarChanged ? ['The stored project default calendar definition differs between exports.'] : []),
    ...(!sourceProjectCalendar || !referenceProjectCalendar ? ['A project default calendar definition is missing.'] : []),
  ];
  let progressChanges = 0;
  let existingCalendarChanges = 0, unknownCalendarComparisons = 0;
  let existingActivityTypeChanges = 0;
  const existingDurationChanges: {code: string; before: string; after: string}[] = [];
  let existingConstraintChanges = 0;
  for (const [code, l] of a) {
    const r = b.get(code);
    if (!r) continue;
    const lc = calendarsA.get(l.clndr_id), rc = calendarsB.get(r.clndr_id);
    if (!lc || !rc) unknownCalendarComparisons++;
    else if (lc !== rc) existingCalendarChanges++;
    if ((l.task_type ?? '') !== (r.task_type ?? '')) existingActivityTypeChanges++;
    if (['target_drtn_hr_cnt','remain_drtn_hr_cnt'].some(k => comparableNumber(l[k]) !== comparableNumber(r[k]))) {
      existingDurationChanges.push({code, before: l.remain_drtn_hr_cnt || 'unknown', after: r.remain_drtn_hr_cnt || 'unknown'});
    }
    if (['cstr_date','cstr_type','cstr_date2','cstr_type2','expect_end_date'].some(k => (l[k] ?? '') !== (r[k] ?? ''))) existingConstraintChanges++;
    if (['status_code', 'act_start_date', 'act_end_date', 'phys_complete_pct'].some(k => (l[k] ?? '') !== (r[k] ?? ''))) progressChanges++;
  }
  if (existingCalendarChanges) checks.push(`${existingCalendarChanges.toLocaleString()} common activities have different working calendars.`);
  if (unknownCalendarComparisons) checks.push(`${unknownCalendarComparisons.toLocaleString()} common activities lack a calendar definition on one or both sides.`);
  if (existingActivityTypeChanges) checks.push(`${existingActivityTypeChanges.toLocaleString()} common activities have different activity types.`);
  if (progressChanges) checks.push(`${progressChanges.toLocaleString()} common activities have different actual dates, status or physical progress.`);
  const added = [...b].filter(([code]) => !a.has(code)).map(([code, t]) => ({code, description: t.task_name, forecastFinish: t.early_end_date}));
  const removed = [...a.keys()].filter(code => !b.has(code)).length;
  const newCodes = new Set(added.map(x => x.code));
  const referenceTies = reference.relationships.filter(r => r.resolved && newCodes.has(r.from) !== newCodes.has(r.to)).map(r => ({
    from:r.from, to:r.to, type:r.type, lagHours:r.lagHours ?? null,
  }));
  const linkKey = (r: ScheduleModel['relationships'][number]) => JSON.stringify([r.from,r.to,r.type,r.lagHours ?? null]);
  const commonLinkKeys = (m: ScheduleModel) => new Set(m.relationships
    .filter(r => r.resolved && a.has(r.from) && a.has(r.to) && b.has(r.from) && b.has(r.to)).map(linkKey));
  const sourceLinks = commonLinkKeys(source), referenceLinks = commonLinkKeys(reference);
  const existingLinkAdds = [...referenceLinks].filter(k => !sourceLinks.has(k)).length;
  const existingLinkRemovals = [...sourceLinks].filter(k => !referenceLinks.has(k)).length;
  const referenceInternalTies = reference.relationships.filter(r => r.resolved && newCodes.has(r.from) && newCodes.has(r.to))
    .map(r => ({from:r.from, to:r.to, type:r.type, lagHours:r.lagHours ?? null}));
  const milestones = lhs.milestone.flatMap(x => { const y = rhs.milestone.find(z => z.code === x.code);
    return y && (x.forecast !== y.forecast || x.floatHours !== y.floatHours) ? [{code: x.code, name: x.name, before: x.forecast, after: y.forecast, floatBefore: x.floatHours, floatAfter: y.floatHours}] : [];
  });
  return { lhs, rhs, checks, progressChanges, added, removed, milestones, referenceTies, referenceInternalTies, existingDurationChanges, existingConstraintChanges, existingLinkAdds, existingLinkRemovals, changedSettingFields, projectCalendarChanged, existingCalendarChanges, unknownCalendarComparisons, existingActivityTypeChanges,
    observedCalendarDays: iso(lhs.forecast) && iso(rhs.forecast) ? dayDiff(iso(lhs.forecast), iso(rhs.forecast)) : null };
}

/** The embedded engine is day-level. Never round fractional activity or lag hours for real evidence. */
function dayCalendar(c: NonNullable<ScheduleModel['calendars']>[number]): CalendarDef | null {
  const raw = c.rawData;
  const week = raw.slice(raw.indexOf('DaysOfWeek'), raw.indexOf('Exceptions'));
  if (!raw.includes('DaysOfWeek') || !raw.includes('Exceptions') || !c.hoursPerDay) return null;
  const days = [...week.matchAll(/\(0\|\|([1-7])\(\)([\s\S]*?)(?=\(0\|\|[1-7]\(\)|\(0\|\|VIEW|$)/g)];
  if (days.length !== 7 || new Set(days.map(d => d[1])).size !== 7) return null;
  const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const workDays = days.filter(x => x[2].includes('s|')).map(x => {
    const times = [...x[2].matchAll(/s\|(\d\d:\d\d)\|f\|(\d\d:\d\d)/g)];
    const total = times.reduce((n, t) => n + minutes(t[2]) - minutes(t[1]), 0);
    return total === c.hoursPerDay! * 60 ? Number(x[1])-1 : -1;
  });
  if (!workDays.length || workDays.includes(-1)) return null;
  const exceptions = raw.slice(raw.indexOf('Exceptions'));
  // An exception with work shifts is not safely representable as a whole non-working day.
  if (/\bs\|\d/.test(exceptions)) return null;
  return {id:c.id,name:c.name,workDays,holidays:c.exceptions};
}

const CONS: Record<string, ConstraintType> = {CS_EarlyStart:'SNET',CS_LateStart:'SNLT',CS_EarlyEnd:'FNET',CS_LateEnd:'FNLT',CS_MandStart:'MSO',CS_MandEnd:'MFO'};

export function validateRealProgramme(model: ScheduleModel): { network: CpmNetwork | null; result: CpmResult | null; reasons: string[]; compared: number; mismatches: number } {
  const p = table(model, 'PROJECT');
  const taskRows = table(model, 'TASK');
  const dates = new Map(taskRows.map(x => [x.task_id,x]));
  const schedule = table(model, 'SCHEDOPTIONS').find(s => s.proj_id === p[0]?.proj_id);
  const reasons: string[] = [];
  const unavailable = {network:null,result:null,reasons,compared:0,mismatches:0};
  if (model.integrityProblems?.length) reasons.push(...model.integrityProblems);
  if (p.length !== 1 || !iso(model.dataDate) || !model.activities.length || taskRows.length !== model.activities.length) reasons.push('A single project, valid data date and source activity rows are required.');
  if (model.relationships.some(r => !r.resolved) || table(model,'TASKPRED').some(r => !['PR_FS','PR_SS','PR_FF','PR_SF'].includes(r.pred_type))) reasons.push('There are unresolved or unsupported relationships.');
  if (!schedule || schedule.sched_retained_logic !== 'Y' || schedule.sched_progress_override !== 'N' || schedule.sched_float_type !== 'FT_FF') reasons.push('P6 retained logic and finish float settings must be present and compatible.');
  if (!['CT_TotFloat', ''].includes(p[0]?.critical_path_type ?? '')) reasons.push('The source uses a different criticality definition.');
  if (schedule?.sched_calendar_on_relationship_lag !== 'rcal_Successor' && model.relationships.some(r => (r.lagHours ?? 0) !== 0)) reasons.push('The source uses a different calendar for relationship lags.');
  if (schedule?.sched_use_expect_end_flag === 'Y' && taskRows.some(t => t.expect_end_date)) reasons.push('The source uses expected-finish overrides.');
  if (model.activities.some(a => !['task','milestone_start','milestone_finish'].includes(a.kind ?? ''))) reasons.push('The source includes activity types that the day-level engine does not recalculate.');
  const used = new Set([p[0]?.clndr_id, ...model.activities.map(a => a.calendarId)]);
  const calendars = (model.calendars ?? []).filter(c => used.has(c.id)).flatMap(c => {const d = dayCalendar(c); return d ? [d] : [];});
  if (calendars.length !== used.size) reasons.push('One or more P6 calendars could not be represented without losing working time.');
  const hpd = new Map(model.activities.map(a => [idOf(a), a.hoursPerDay]));
  if (model.activities.some(a => !(a.hoursPerDay && a.hoursPerDay > 0) || (a.remainingDurationHours == null && a.kind === 'task') || (a.remainingDurationHours != null && !Number.isInteger(a.remainingDurationHours / (a.hoursPerDay ?? 1)))) || model.relationships.some(r => r.lagHours == null || !(hpd.get(r.toTaskId ?? '')! > 0) || !Number.isInteger(r.lagHours / hpd.get(r.toTaskId ?? '')!))) reasons.push('Fractional or missing duration/lag values require an hourly or P6 engine.');
  if (model.activities.some(a => (a.constraints?.length ?? 0) > 1 || a.constraints?.some(c => !CONS[c.type] || !iso(c.date)))) reasons.push('The source contains multiple or unsupported activity constraints.');
  if (reasons.length) return unavailable;
  const network: CpmNetwork = {
    activities: model.activities.map(a => ({ id:idOf(a), name:a.name, type:a.kind as CpmNetwork['activities'][number]['type'], calendarId:a.calendarId!,
      originalDuration:a.duration, remainingDuration:(a.remainingDurationHours ?? 0)/a.hoursPerDay!, actualStart:a.actualStart,actualFinish:a.actualFinish,
      constraint:a.constraints?.[0] ? {type:CONS[a.constraints[0].type],date:a.constraints[0].date} : undefined })),
    relationships:model.relationships.map(r => ({from:r.fromTaskId!,to:r.toTaskId!,type:r.type,lag:r.lag})), calendars,
    dataDate:model.dataDate, projectCalendarId:p[0].clndr_id,
    settings:{progressMode:'retained_logic',resourceLevelling:false,criticalDefinition:'total_float_lte_zero'},
  };
  let result: CpmResult;
  try { result=calculateCpm(network); }
  catch (e) { reasons.push(e instanceof Error ? e.message : 'Unable to recalculate the real programme.'); return unavailable; }
  if (!result.ok) {
    reasons.push(...result.issues.filter(i=>i.severity==='error').slice(0,4).map(i=>i.message));
    return {...unavailable,network,result};
  }
  let compared=0,mismatches=0;
  for(const a of model.activities) {
    const t=dates.get(idOf(a)), r=result.activities[idOf(a)];
    if (!t || !r || !iso(t.act_start_date || t.early_start_date) || !iso(t.act_end_date || t.early_end_date) || (a.status !== 'completed' && a.totalFloatHours == null)) {mismatches++;continue;}
    compared++;
    if(iso(t.act_start_date || t.early_start_date)!==r.earlyStart || iso(t.act_end_date || t.early_end_date)!==r.earlyFinish ||
      (a.status!=='completed' && Math.abs(r.totalFloat*a.hoursPerDay! - a.totalFloatHours!)>1e-6)) mismatches++;
  }
  if (!iso(p[0].scd_end_date) || result.projectFinish!==iso(p[0].scd_end_date)) reasons.push('The unchanged project finish did not reproduce the source.');
  if (mismatches || !compared) reasons.push(`The unchanged programme did not reproduce ${mismatches} activity date or float records.`);
  return {network,result,reasons,compared,mismatches};
}

export function testDurationChange(checked: ReturnType<typeof validateRealProgramme>, taskId: string, workingDays: number) {
  if (!checked.network || !checked.result?.ok || checked.reasons.length || !Number.isSafeInteger(workingDays) || workingDays < 1 || workingDays > 3650) return null;
  const original = checked.network.activities.find(a=>a.id===taskId);
  if (!original || original.type!=='task' || original.actualFinish) return null;
  const result=calculateCpm({...checked.network,activities:checked.network.activities.map(a=>a.id===taskId?{...a,remainingDuration:a.remainingDuration+workingDays}:a)});
  if (!result.ok || !result.projectFinish || !checked.result.projectFinish) return null;
  return {before:checked.result.projectFinish,after:result.projectFinish,calendarDays:dayDiff(checked.result.projectFinish,result.projectFinish),result};
}

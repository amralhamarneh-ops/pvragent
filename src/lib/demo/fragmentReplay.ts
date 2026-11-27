import { calculateCpm, type CalendarDef, type CpmActivity } from '@/lib/assessment/cpmEngine';
import { parseXerBytes } from '@/lib/mapping/xerParser';
import type { ScheduleCalendar, ScheduleModel } from '@/lib/mapping/types';

export const FRAGMENT_MAX_BYTES = 30_000_000;
const iso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;

export type FragmentResult = {
  filename: string;
  anchor: string;
  rows: {code: string; name: string; hours: number; hoursPerDay: number; days: number;
    calendar: string; weekDays: number; start: string; finish: string; storedFinish: string}[];
};

function calendar(c: ScheduleCalendar): CalendarDef {
  const [week, exceptions] = c.rawData.split('DaysOfWeek')[1]?.split('(0||Exceptions') ?? [];
  if (!week || exceptions === undefined || !c.hoursPerDay) throw new Error('The activity calendar has no explicit working week and exceptions.');
  const patterns = [...week.matchAll(/\(0\|\|([1-7])\(\)([\s\S]*?)(?=\(0\|\|[1-7]\(\)|\(0\|\|VIEW|$)/g)];
  if (patterns.length !== 7 || new Set(patterns.map(m => m[1])).size !== 7) throw new Error('The calendar does not define seven unique weekdays.');
  const minute = (h: string, m: string) => {
    if (+h > 24 || +m > 59 || (+h === 24 && +m !== 0)) throw new Error('The calendar includes an invalid shift time.');
    return +h * 60 + +m;
  };
  const workDays = patterns.flatMap(p => {
    const shifts = [...p[2].matchAll(/\(0\|\|\d+\(s\|(\d\d):(\d\d)\|f\|(\d\d):(\d\d)\)\(\)\)/g)];
    if (/[a-z|]/i.test(p[2].replace(/\(0\|\|\d+\(s\|\d\d:\d\d\|f\|\d\d:\d\d\)\(\)\)/g, '')))
      throw new Error('The calendar includes an unsupported shift definition.');
    if (!shifts.length) return [];
    const hours = shifts.map(s => [minute(s[1], s[2]), minute(s[3], s[4])]).sort((a,b)=>a[0]-b[0]);
    if (hours.some(([s,e],i) => e <= s || i > 0 && s < hours[i-1][1]) ||
      hours.reduce((sum,[s,e]) => sum + e-s, 0) !== c.hoursPerDay! * 60)
      throw new Error('Working days must have the stated, fixed hours with non-overlapping shifts.');
    return [+p[1]-1];
  });
  if (!workDays.length || [...exceptions.matchAll(/\(d\|[^)]*\)/g)].length !== c.exceptions.length)
    throw new Error('The calendar exception dates could not be fully read.');
  return { id: c.id, name: c.name, workDays, holidays: [] };
}

/** This checks two planned activities only. An impacted export supplies the inputs, never a measured quantity. */
export function runFragmentReplay(bytes: Uint8Array, filename: string, firstCode: string, nextCode: string): FragmentResult {
  if (!/\.xer$/i.test(filename) || !bytes.length || bytes.length > FRAGMENT_MAX_BYTES)
    throw new Error('Select an impacted Primavera XER file up to 30 MB.');
  return calculateProgrammeFragment(parseXerBytes(bytes, filename), firstCode, nextCode);
}

export function calculateProgrammeFragment(model: ScheduleModel, firstCode: string, nextCode: string, preChange?: ScheduleModel): FragmentResult {
  const codes = [firstCode.trim(), nextCode.trim()];
  if (codes.some(x => !x || x.length > 80) || codes[0] === codes[1]) throw new Error('Enter two different P6 activity codes.');
  if (preChange?.activities.some(a=>codes.includes(a.id)))
    throw new Error('This fallback applies only to activities missing from the pre-change programme.');
  if (model.integrityProblems?.length) throw new Error('The XER has invalid tables or activity IDs. Re-export it from P6.');
  const found = codes.map(code => {
    const candidates = model.activities.filter(a => a.id === code);
    if (candidates.length !== 1) throw new Error(`Activity ${code} is missing or its code is not unique.`);
    const a = candidates[0];
    if (a.rawTaskType !== 'TT_Task' || a.status !== 'not_started' || a.actualStart || a.actualFinish ||
      a.durationHours !== a.remainingDurationHours || !iso(a.earlyFinish))
      throw new Error(`Activity ${code} must be an unstarted, task-dependent activity with a stored early finish.`);
    return a;
  });
  const [first, next] = found;
  const anchor = first.constraints?.[0]?.date;
  if (first.constraints?.length !== 1 || first.constraints[0].type !== 'CS_MSO' || !iso(anchor) ||
      next.constraints?.length || !iso(model.dataDate) || anchor < model.dataDate)
    throw new Error('The first activity needs a mandatory start on or after the data date; the second must be unconstrained.');
  const inbound = model.relationships.filter(r => r.toTaskId === first.taskId || r.toTaskId === next.taskId);
  if (inbound.length !== 1 || inbound[0].fromTaskId !== first.taskId || inbound[0].toTaskId !== next.taskId ||
      !inbound[0].resolved || inbound[0].type !== 'FS' || inbound[0].lagHours !== 0)
    throw new Error('Use an isolated pair with one zero-lag finish-to-start link and no other incoming links.');
  const decoded = found.map(a => {
    const matching = model.calendars?.filter(c=>c.id===a.calendarId) ?? [];
    if (matching.length !== 1 || !a.hoursPerDay || !a.durationHours) throw new Error(`Missing explicit duration or calendar for ${a.id}.`);
    const source = matching[0];
    const table = model.rawTables?.CALENDAR;
    const idIndex = table?.fields.indexOf('clndr_id') ?? -1;
    const baseIndex = table?.fields.indexOf('base_clndr_id') ?? -1;
    if (baseIndex >= 0 && table?.rows.some(r => r[idIndex] === source.id && r[baseIndex]?.trim()))
      throw new Error('Inherited calendars are not supported in this limited replay.');
    const days = a.durationHours / a.hoursPerDay;
    if (!Number.isSafeInteger(days) || days <= 0 || days > 730)
      throw new Error(`Activity ${a.id} must have a whole duration of 1–730 working days.`);
    const c = calendar(source);
    const activity: CpmActivity = {id:a.id, name:a.name, type:'task', calendarId:c.id, originalDuration:days, remainingDuration:days,
      ...(a === first ? {constraint:{type:'MSO', date:anchor}} : {})};
    return {source, c, activity, hours:a.durationHours, hoursPerDay:a.hoursPerDay};
  });
  const result = calculateCpm({
    activities:decoded.map(d=>d.activity), calendars:[...new Map(decoded.map(d=>[d.c.id,d.c])).values()],
    relationships:[{from:first.id,to:next.id,type:'FS',lag:0}], dataDate:anchor, projectCalendarId:decoded[0].c.id,
    settings:{progressMode:'retained_logic',resourceLevelling:false,criticalDefinition:'total_float_lte_zero'}
  });
  if (!result.ok || !result.activities[first.id] || !result.activities[next.id] || result.activities[first.id].earlyStart !== anchor)
    throw new Error('The scheduling engine could not reproduce the mandatory start for this fragment.');
  const rows = decoded.map(({source,c,activity,hours,hoursPerDay}, i) => {
    const a = result.activities[activity.id];
    if (source.exceptions.some(d=>d>=anchor && d<=a.earlyFinish))
      throw new Error('A calendar exception falls inside the replay window. Use P6 for this fragment.');
    return {code:activity.id,name:activity.name,hours,hoursPerDay,days:activity.remainingDuration,calendar:c.name,
      weekDays:c.workDays.length,start:a.earlyStart,finish:a.earlyFinish,storedFinish:found[i].earlyFinish!};
  });
  return {filename:model.fileName, anchor, rows};
}

export function readSavedFragment(raw: string | null): FragmentResult | null {
  if (!raw || raw.length > 16_000) return null;
  try {
    const d = JSON.parse(raw);
    const str = (v: unknown) => typeof v === 'string' && v.length <= 1024;
    if (!d || !str(d.filename) || !iso(d.anchor) || !Array.isArray(d.rows) || d.rows.length !== 2 ||
        !d.rows.every((r: FragmentResult['rows'][number]) => r && [r.code,r.name,r.calendar].every(str) &&
          [r.start,r.finish,r.storedFinish].every(iso) &&
          [r.hours,r.hoursPerDay,r.days,r.weekDays].every(n=>typeof n==='number' && Number.isFinite(n) && n>0))) return null;
    return d;
  } catch { return null; }
}

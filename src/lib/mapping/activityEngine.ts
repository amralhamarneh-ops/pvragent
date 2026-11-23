import type { ActivityCandidate, ActivityMapping, BoqMapping, NewActivitySuggestion, ScheduleActivity, ScheduleModel, ScheduleRelationship } from './types';
import { progressStatusOf, formatDate } from './xerParser';
import { textSimilarity } from './boqEngine';

const mk = (id: string, name: string, wbs: string, start: string, finish: string, duration: number, totalFloat: number, progressPct: number, chainFrom: number, chainTo: number, discipline: string, zone = 'Zone C East Spine'): ScheduleActivity => ({
  id, name, wbs, start, finish, duration, totalFloat, progressPct, chainFrom, chainTo, discipline, zone,
});

export function buildFahidSchedule(): ScheduleModel {
  const activities: ScheduleActivity[] = [
    mk('C4005', 'Mobilise and survey', 'Fahid Island Roads / Zone C East Spine / R4 Access road', '2026-02-02', '2026-02-27', 20, 0, 100, 0, 7000, 'Civil Roads'),
    mk('C4010', 'R4 Earthworks, CH 0+000 to 5+000', 'Fahid Island Roads / Zone C East Spine / R4 Access road / Earthworks', '2026-03-02', '2026-07-14', 98, 0, 100, 0, 5000, 'Civil Roads'),
    mk('C4030', 'R4 Subbase, CH 0+000 to 5+000', 'Fahid Island Roads / Zone C East Spine / R4 Access road / Subbase', '2026-05-04', '2026-08-28', 85, 4, 100, 0, 5000, 'Civil Roads'),
    mk('C4050', 'R4 Binder course, CH 0+000 to 5+000', 'Fahid Island Roads / Zone C East Spine / R4 Access road / Pavement', '2026-07-01', '2026-09-02', 45, 3, 100, 0, 5000, 'Civil Roads'),
    mk('C4060', 'R4 Wearing course, CH 0+000 to 5+000', 'Fahid Island Roads / Zone C East Spine / R4 Access road / Pavement', '2026-08-03', '2026-11-18', 108, 6, 38, 0, 5000, 'Civil Roads'),
    mk('C4070', 'R4 Kerbs, CH 0+000 to 5+000', 'Fahid Island Roads / Zone C East Spine / R4 Access road / Kerbs', '2026-06-15', '2026-10-30', 100, 8, 55, 0, 5000, 'Civil Roads'),
    mk('C4080', 'R4 Turning head and end barrier', 'Fahid Island Roads / Zone C East Spine / R4 Access road / Kerbs', '2026-10-01', '2026-11-20', 36, 6, 10, 4900, 5000, 'Civil Roads'),
    mk('C4090', 'R4 Handover', 'Fahid Island Roads / Zone C East Spine / R4 Access road', '2027-04-01', '2027-04-01', 0, 0, 0, 0, 7000, 'Civil Roads'),
    mk('C4120', 'R4 Street lighting, install and test', 'Fahid Island Roads / Zone C East Spine / R4 Access road / Lighting', '2027-02-02', '2027-03-30', 38, 0, 0, 0, 7000, 'Lighting'),
    mk('C4130', 'R4 Road marking and signage', 'Fahid Island Roads / Zone C East Spine / R4 Access road / Marking', '2027-03-01', '2027-03-26', 20, 4, 0, 0, 7000, 'Signage'),
    mk('C4140', 'R4 Gully and drainage connections', 'Fahid Island Roads / Zone C East Spine / R4 Access road / Earthworks', '2026-04-01', '2026-09-30', 130, 12, 70, 0, 5000, 'Drainage'),
    mk('C5010', 'R7 Landscape planting, Zone A', 'Fahid Island Roads / Zone A West Spine / R7 Boulevard / Landscape', '2026-09-01', '2027-01-15', 90, 22, 0, 0, 3000, 'Landscape', 'Zone A West Spine'),
  ];
  const relationships: ScheduleRelationship[] = [
    { from: 'C4005', to: 'C4010', type: 'FS', lag: 0 },
    { from: 'C4010', to: 'C4030', type: 'SS', lag: 20 },
    { from: 'C4030', to: 'C4050', type: 'FS', lag: 0 },
    { from: 'C4050', to: 'C4060', type: 'FS', lag: 0 },
    { from: 'C4060', to: 'C4090', type: 'FS', lag: 0 },
    { from: 'C4060', to: 'C4130', type: 'FS', lag: 0 },
    { from: 'C4070', to: 'C4090', type: 'FS', lag: 0 },
    { from: 'C4120', to: 'C4090', type: 'FS', lag: 0 },
  ];
  return { fileName: 'FIR_Baseline_Oct26.xer', activityCount: 312, dataDate: '2026-10-12', activities, relationships };
}

export interface WbsNode {
  name: string;
  count: number;
}

export function wbsBranchCounts(model: ScheduleModel): WbsNode[] {
  const counts = new Map<string, number>();
  for (const a of model.activities) {
    const leaf = a.wbs.split(' / ').slice(-1)[0];
    counts.set(leaf, (counts.get(leaf) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([name, count]) => ({ name, count }));
}

export interface ScheduleFilters {
  zone: string;
  chainFrom: number;
  chainTo: number;
  discipline: string;
}

export const DEFAULT_FILTERS: ScheduleFilters = { zone: '', chainFrom: 0, chainTo: 0, discipline: '' };

/** Filters that describe the built-in demo programme only. Real cases never import this. */
export const DEMO_FIXTURE_FILTERS: ScheduleFilters = { zone: 'Zone C East Spine', chainFrom: 5000, chainTo: 7000, discipline: 'Civil Roads' };

function overlaps(a: ScheduleActivity, f: ScheduleFilters): boolean {
  if (!(f.chainTo > f.chainFrom) || !(a.chainTo > a.chainFrom)) return false;
  return a.chainFrom < f.chainTo && a.chainTo > f.chainFrom;
}

function disciplineMatches(a: ScheduleActivity, boq: BoqMapping): boolean {
  if (!a.discipline) return false;
  return `${boq.description} ${boq.preamble}`.toLowerCase().includes(a.discipline.toLowerCase());
}

/** Score an activity against a BoQ item. All inputs are deterministic. */
export function scoreActivity(a: ScheduleActivity, boq: BoqMapping, f: ScheduleFilters): { score: number; reason: string } {
  const parts: string[] = [];
  let score = 0;
  const sim = textSimilarity(boq.description, a.name);
  score += Math.min(0.4, sim * 1.4);
  if (disciplineMatches(a, boq)) { score += 0.2; parts.push('same discipline'); }
  if (f.zone && a.zone === f.zone) { score += 0.1; parts.push('same zone'); }
  if (overlaps(a, f)) { score += 0.25; parts.push('chainage overlaps the change'); }
  const status = progressStatusOf(a.progressPct);
  if (status === 'completed') { score -= 0.35; parts.push('already complete'); }
  // Milestones and summary rows can never take execution quantity.
  if (a.kind === 'milestone_start' || a.kind === 'milestone_finish' || a.kind === 'wbs_summary' || a.kind === 'summary' || (a.duration === 0 && /handover|completion/i.test(a.name))) { score = Math.min(score, 0.1); parts.push('milestone or summary: cannot take quantity'); }
  return { score: Math.max(0.05, Math.min(0.97, score)), reason: parts.join(', ') };
}

export function toCandidate(a: ScheduleActivity, score: number, reason: string): ActivityCandidate {
  const status = progressStatusOf(a.progressPct);
  return {
    activityId: a.id,
    name: a.name,
    wbsPath: a.wbs,
    baselineStart: formatDate(a.start),
    baselineFinish: formatDate(a.finish),
    durationDays: a.duration,
    totalFloat: a.totalFloat,
    progressStatus: status,
    progressPct: a.progressPct,
    isCritical: a.totalFloat <= 0,
    confidence: Math.round(score * 100),
    reason,
  };
}

export function candidatesFor(boq: BoqMapping, model: ScheduleModel, f: ScheduleFilters, limit = 3): ActivityCandidate[] {
  return model.activities
    .filter((a) => !f.zone || a.zone === f.zone)
    .filter((a) => a.kind !== 'milestone_start' && a.kind !== 'milestone_finish' && a.kind !== 'wbs_summary' && a.kind !== 'summary' && !(a.duration === 0 && /handover|completion|milestone/i.test(a.name)))
    .map((a) => ({ a, ...scoreActivity(a, boq, f) }))
    .filter((r) => r.score >= 0.4)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map((r) => toCandidate(r.a, r.score, r.reason));
}

/** Many-to-many mapping with quantity share. Generic: it reads only the supplied schedule and BoQ lines. */
export function mapBoqToActivities(boqs: BoqMapping[], model: ScheduleModel, f: ScheduleFilters = DEFAULT_FILTERS): { mappings: ActivityMapping[]; suggestions: NewActivitySuggestion[] } {
  const mappings: ActivityMapping[] = [];
  const suggestions: NewActivitySuggestion[] = [];
  for (const boq of boqs.filter((b) => b.included)) {
    const ranked = candidatesFor(boq, model, f, 3);
    const finishedOnly = ranked.length > 0 && ranked.every((c) => c.progressStatus === 'completed');
    const noGood = ranked.length === 0 || ranked[0].confidence < 55;
    const open = ranked.filter((c) => c.progressStatus !== 'completed');
    const chosen = boq.class === 'new' ? [] : open.length > 0 ? [open[0]] : [];
    const needsNew = boq.class === 'new' || ((finishedOnly || noGood) && boq.class !== 'omission');
    if (needsNew && chosen.length === 0) {
      const best = ranked[0];
      const anchor = best ? model.activities.find((a) => a.id === best.activityId) : undefined;
      const succAct = anchor ? neighbours(anchor.id, model).succs[0]?.activity : undefined;
      mappings.push({
        id: `AM-${boq.id}-new`, boqMappingId: boq.id, activityId: null, wbsPath: anchor?.wbs ?? '', baselineStart: '', baselineFinish: '', durationDays: 0, totalFloat: 0, progressStatus: 'not_started', isCritical: false, quantityShare: 100, confidence: 62,
        reason: best ? `${best.activityId} is ${best.progressStatus === 'completed' ? 'finished (its actual dates are kept)' : 'not a close match'}, so it cannot take the new quantity.` : 'No activity covers this scope in the programme.', newActivityNeeded: true, accepted: false, candidate: best,
      });
      suggestions.push({ boqMappingId: boq.id, name: `${boq.description}${anchor ? ` (after ${anchor.id})` : ''}`, predecessor: anchor ? `${anchor.id} ${anchor.name}` : 'No predecessor identified', successor: succAct ? `${succAct.id} ${succAct.name}` : 'No successor identified', accepted: false });
      continue;
    }
    chosen.forEach((c) => {
      mappings.push({
        id: `AM-${boq.id}-${c.activityId}`, boqMappingId: boq.id, activityId: c.activityId, wbsPath: c.wbsPath, baselineStart: c.baselineStart, baselineFinish: c.baselineFinish, durationDays: c.durationDays, totalFloat: c.totalFloat, progressStatus: c.progressStatus, isCritical: c.isCritical, quantityShare: 100 / chosen.length, confidence: c.confidence,
        reason: c.reason, newActivityNeeded: false, accepted: c.confidence >= 75, candidate: c,
      });
    });
    if (chosen.length === 0 && boq.class !== 'omission') {
      mappings.push({ id: `AM-${boq.id}-none`, boqMappingId: boq.id, activityId: null, wbsPath: '', baselineStart: '', baselineFinish: '', durationDays: 0, totalFloat: 0, progressStatus: 'not_started', isCritical: false, quantityShare: 0, confidence: 0, reason: 'No candidate activity found.', newActivityNeeded: false, accepted: false });
    }
  }
  return { mappings, suggestions };
}

export function neighbours(activityId: string, model: ScheduleModel): { preds: { activity?: ScheduleActivity; rel: ScheduleRelationship }[]; succs: { activity?: ScheduleActivity; rel: ScheduleRelationship }[] } {
  const byId = new Map(model.activities.map((a) => [a.id, a]));
  return {
    preds: model.relationships.filter((r) => r.to === activityId).map((rel) => ({ activity: byId.get(rel.from), rel })),
    succs: model.relationships.filter((r) => r.from === activityId).map((rel) => ({ activity: byId.get(rel.to), rel })),
  };
}

export function activitySummary(mappings: ActivityMapping[], boqCount: number): string {
  const mapped = new Set(mappings.filter((m) => m.activityId && m.accepted).map((m) => m.boqMappingId));
  const acts = new Set(mappings.filter((m) => m.activityId && m.accepted).map((m) => m.activityId));
  const needNew = new Set(mappings.filter((m) => m.newActivityNeeded).map((m) => m.boqMappingId));
  void boqCount;
  return `${mapped.size} BoQ items map to ${acts.size} activities; ${needNew.size} item${needNew.size === 1 ? '' : 's'} need new activities.`;
}

import type { ActivityMapping, BoqMapping, DrawingChange, MappingVersion } from './types';

type Issue = string;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

export function validateDrawingChange(c: DrawingChange): Issue[] {
  const issues: Issue[] = [];
  if (!isStr(c.id) || !c.id) issues.push('id missing');
  if (!['added', 'removed', 'modified'].includes(c.type)) issues.push(`${c.id}: type invalid`);
  if (!['length', 'area', 'count', 'volume'].includes(c.measure)) issues.push(`${c.id}: measure invalid`);
  if (!isNum(c.value) || c.value < 0) issues.push(`${c.id}: value invalid`);
  if (!isStr(c.unit) || !c.unit) issues.push(`${c.id}: unit missing`);
  if (!isNum(c.confidence) || c.confidence < 0 || c.confidence > 100) issues.push(`${c.id}: confidence out of range`);
  if (!c.bbox || !isNum(c.bbox.x) || !isNum(c.bbox.w)) issues.push(`${c.id}: bbox invalid`);
  const unitFor: Record<string, string> = { length: 'm', area: 'm²', count: 'nr', volume: 'm³' };
  if (unitFor[c.measure] && c.unit !== unitFor[c.measure]) issues.push(`${c.id}: unit ${c.unit} does not fit ${c.measure}`);
  return issues;
}

export function validateBoqMapping(m: BoqMapping): Issue[] {
  const issues: Issue[] = [];
  if (!isStr(m.id) || !m.id) issues.push('id missing');
  if (!['omission', 'addition', 'abortive', 'new'].includes(m.class)) issues.push(`${m.id}: class invalid`);
  if (!isNum(m.quantity) || m.quantity < 0) issues.push(`${m.id}: quantity invalid`);
  if (!isStr(m.unit) || !m.unit) issues.push(`${m.id}: unit missing`);
  if (!Array.isArray(m.changeIds) || m.changeIds.length === 0) issues.push(`${m.id}: no source change`);
  if (m.class === 'new' && m.rateRef !== null) issues.push(`${m.id}: new item must not carry a rate`);
  if (!isStr(m.rationale) || m.rationale.length < 10) issues.push(`${m.id}: rationale too short`);
  return issues;
}

export function validateActivityMapping(a: ActivityMapping): Issue[] {
  const issues: Issue[] = [];
  if (!isStr(a.id) || !a.id) issues.push('id missing');
  if (!a.newActivityNeeded && !a.activityId) issues.push(`${a.id}: activity id missing`);
  if (!isNum(a.quantityShare) || a.quantityShare < 0 || a.quantityShare > 100) issues.push(`${a.id}: quantity share out of range`);
  if (!['completed', 'in_progress', 'not_started'].includes(a.progressStatus)) issues.push(`${a.id}: progress status invalid`);
  return issues;
}

export function validateMappingVersion(v: MappingVersion): Issue[] {
  const issues: Issue[] = [];
  if (!v.caseId) issues.push('caseId missing');
  if (!v.confirmedBy) issues.push('confirmedBy missing');
  v.contents.drawingChanges.forEach((c) => issues.push(...validateDrawingChange(c)));
  v.contents.boqMappings.forEach((m) => issues.push(...validateBoqMapping(m)));
  v.contents.activityMappings.forEach((a) => issues.push(...validateActivityMapping(a)));
  return issues;
}

/** Strip a possible markdown fence and parse JSON. Returns null on failure. */
export function safeParseJson<T>(text: string): T | null {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

export interface RationaleResult {
  rationales: { id: string; text: string }[];
}

export function validateRationales(value: unknown, knownIds: string[]): RationaleResult | null {
  if (!value || typeof value !== 'object') return null;
  const list = (value as RationaleResult).rationales;
  if (!Array.isArray(list)) return null;
  const clean = list.filter((r) => r && isStr(r.id) && isStr(r.text) && knownIds.includes(r.id) && r.text.length > 0 && r.text.length < 400);
  return clean.length > 0 ? { rationales: clean } : null;
}

import { PROGRAMME_SNAPSHOT_KEY } from '../assessment/programmeSnapshot';
import type { AssessmentOutcome } from './matchEngine';
import type { DrawingDocument } from './drawingQuantities';

export const MATCH_SNAPSHOT_KEY = '__boqMatchSnapshotV1';
const MAX_ROWS = 300;
const MAX_TEXT = 300;
const MAX_SNAPSHOT = 640_000;

interface SnapshotRow {
  name: string; quantity: string; source: string; item: string; description: string; file: string; note: string;
}
export interface MatchSnapshot {
  version: 1; runAt: string; importSignature: string;
  drawings: DrawingDocument[]; rows: SnapshotRow[]; total: number;
}

const limit = (s: string) => s.slice(0, MAX_TEXT);
const rowFields = ['name', 'quantity', 'source', 'item', 'description', 'file', 'note'] as const;

/** Store a display-only record of reviewed candidates, not a valuation or a runnable agent object. */
export function makeMatchSnapshot(outcome: AssessmentOutcome, importSignature: string, drawings: DrawingDocument[], runAt: string): MatchSnapshot {
  const rows = outcome.lines.filter((line) => line.role === 'primary' && line.quantityOrigin === 'Measured from geometry' && !!line.item.ref);
  return {
    version: 1, runAt, importSignature, drawings, total: rows.length,
    rows: rows.slice(0, MAX_ROWS).map((l) => ({
      name: limit(l.componentName), quantity: limit(l.quantityText), source: limit(l.quantitySource),
      item: limit(l.item.ref), description: limit(l.item.description), file: limit(l.item.sourceFile),
      note: limit(l.status === 'ready' ? '' : l.statusNote || l.status),
    })),
  };
}

export function readMatchSnapshot(raw: unknown): MatchSnapshot | null {
  if (typeof raw !== 'string' || raw.length > MAX_SNAPSHOT) return null;
  try {
    const value = JSON.parse(raw) as MatchSnapshot;
    if (!value || value.version !== 1 || typeof value.runAt !== 'string' || !Number.isFinite(Date.parse(value.runAt)) ||
      typeof value.importSignature !== 'string' || !Array.isArray(value.rows) || value.rows.length > MAX_ROWS ||
      !Number.isSafeInteger(value.total) || value.total < value.rows.length ||
      !value.rows.every((row) => row && rowFields.every((key) => typeof row[key] === 'string' && row[key].length <= MAX_TEXT)) ||
      !Array.isArray(value.drawings) || value.drawings.length > 1000 ||
      !value.drawings.every((d) => d && d.role === 'drawings' && typeof d.id === 'string' && typeof d.name === 'string' &&
        typeof d.sha256 === 'string' && /^[a-f\d]{64}$/i.test(d.sha256) && Number.isSafeInteger(d.version))) return null;
    return value;
  } catch { return null; }
}

/** Preserve reserved data on ordinary answer updates; a snapshot-only save must never remove unrelated answers. */
export function mergeMatchSnapshotAnswers(current: Record<string, string>, answers?: Record<string, string>, snapshot?: string, programmeSnapshot?: string): Record<string, string> {
  const next = { ...(answers ?? current) };
  const has = (o: Record<string, string>, key: string) => Object.prototype.hasOwnProperty.call(o, key);
  if (answers && !has(answers, '__boqInclusion') && has(current, '__boqInclusion')) next.__boqInclusion = current.__boqInclusion;
  if (snapshot !== undefined) next[MATCH_SNAPSHOT_KEY] = snapshot;
  else if (has(current, MATCH_SNAPSHOT_KEY)) next[MATCH_SNAPSHOT_KEY] = current[MATCH_SNAPSHOT_KEY];
  else delete next[MATCH_SNAPSHOT_KEY];
  if (programmeSnapshot !== undefined) next[PROGRAMME_SNAPSHOT_KEY] = programmeSnapshot;
  else if (has(current, PROGRAMME_SNAPSHOT_KEY)) next[PROGRAMME_SNAPSHOT_KEY] = current[PROGRAMME_SNAPSHOT_KEY];
  else delete next[PROGRAMME_SNAPSHOT_KEY];
  return next;
}

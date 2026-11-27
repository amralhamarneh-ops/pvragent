import type { AnalysisOutput } from './analyse';
import { evidenceForObject } from './compare';
import { buildViewModel, type ViewModel } from './viewModel';

export const REPLAY_SPEEDS = [1, 2, 5, 10, 20, 40] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];
export const replayDelay = (speed: ReplaySpeed) => Math.max(16, Math.round(800 / speed));

const MAX_PAIRS = 8;
const MAX_ENTITIES_PER_PAIR = 2400;
const MAX_JSON_CHARS = 300_000;
export interface SavedDrawingReplay {
  version: 1;
  models: ViewModel[];
  eligiblePairCount: number;
}

const box = (b: ViewModel['extent']) => b && [b.minX,b.minY,b.maxX,b.maxY].every(Number.isFinite);
const point = (p: {x:number;y:number} | null | undefined) => !p || [p.x,p.y].every(Number.isFinite);
const itemStates = new Set(['added', 'removed', 'modified', 'unchanged']);
const validate = (m: ViewModel): boolean =>
  !!m && box(m.extent) && Number.isFinite(m.aspect) &&
  [m.drawingNumber,m.originalRevision,m.revisedRevision,m.originalFile,m.revisedFile,m.unitSource,m.alignmentNote].every((v)=>typeof v==='string') &&
  !!m.info && Array.isArray(m.info.coverageNotes) && m.info.coverageNotes.every((x)=>typeof x==='string') &&
  Array.isArray(m.layers) && m.layers.length <= MAX_ENTITIES_PER_PAIR &&
  m.layers.every((l)=>l && typeof l.name==='string' && [l.total,l.added,l.removed,l.unchanged].every(Number.isFinite)) &&
  Array.isArray(m.entities) && m.entities.length > 0 && m.entities.length <= MAX_ENTITIES_PER_PAIR &&
  m.entities.every((e)=>e && ['original','revised'].includes(e.side) && itemStates.has(e.state) &&
    [e.key,e.handle,e.kind,e.layer,e.d].every((v)=>typeof v==='string') &&
    box(e.bbox) && point(e.point) && point(e.offset) && [e.length,e.area].every(Number.isFinite) &&
    Array.isArray(e.changeIds) && e.changeIds.every((id)=>typeof id==='string'));

export function readSavedDrawingReplay(value: unknown): SavedDrawingReplay | null {
  const data = value as SavedDrawingReplay | null;
  if (!data || data.version !== 1 || !Number.isSafeInteger(data.eligiblePairCount) ||
      !Array.isArray(data.models) || !data.models.length || data.models.length > MAX_PAIRS || data.eligiblePairCount < data.models.length ||
      !data.models.every(validate)) return null;
  return JSON.stringify(data).length <= MAX_JSON_CHARS ? data : null;
}

/** Save a bounded copy of completed, verified-pair visuals. It is never fed back into measurement. */
export function buildSavedDrawingReplay(out: Pick<AnalysisOutput,'pairs'|'changes'|'relocationSentences'>): SavedDrawingReplay | null {
  const pairs = out.pairs.filter((p)=>p.validated);
  const models: ViewModel[] = [];
  const resolve = (layer: string) => evidenceForObject(layer, [], out.relocationSentences);
  const data: SavedDrawingReplay = { version:1, models, eligiblePairCount:pairs.length };
  for (const pair of pairs) {
    if (models.length >= MAX_PAIRS) break;
    if (pair.original.entities.length + pair.revised.entities.length > MAX_ENTITIES_PER_PAIR) continue;
    const model = buildViewModel(pair, out.changes, resolve);
    if (readSavedDrawingReplay({...data, models:[...models,model]})) models.push(model);
  }
  return models.length ? data : null;
}

export function hasReplaySources(handoff: unknown): handoff is { drawingReplay: unknown } & Record<string, unknown> {
  return typeof handoff === 'object' && handoff !== null && 'drawingReplay' in handoff;
}

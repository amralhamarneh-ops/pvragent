import type { AnalysisStage, DrawingEntity, GeometryBatch, ProcessingEvent } from './types';

export const STAGES: { id: AnalysisStage; label: string }[] = [
  { id: 'loading', label: 'Loading' },
  { id: 'parsing', label: 'Parsing' },
  { id: 'geometry', label: 'Geometry processing' },
  { id: 'alignment', label: 'Revision alignment' },
  { id: 'comparison', label: 'Comparison' },
  { id: 'measurement', label: 'Measurement' },
  { id: 'reconciliation', label: 'Reconciliation' },
];

export type StageStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

/** Geometry received so far for one file in the active run. Only batches that carried this run's id are added. */
export interface LiveFileGeometry {
  fileName: string;
  documentId: string;
  layers: Record<string, { entities: DrawingEntity[]; entityIds: string[]; batches: number }>;
  /** Layer order in which geometry really arrived. */
  layerOrder: string[];
  metresPerUnit: number | null;
  unit: 'mm' | 'cm' | 'm' | null;
  extents: { minX: number; minY: number; maxX: number; maxY: number } | null;
  delivered: number;
  total: number;
}

export interface RunState {
  runId: string | null;
  caseId: string | null;
  status: 'idle' | 'running' | 'complete' | 'cancelled' | 'failed';
  events: ProcessingEvent[];
  stages: Record<AnalysisStage, StageStatus>;
  /** Layers in the order their geometry really became available, with entity counts. */
  layers: { name: string; count: number; fileName: string; seq: number }[];
  /** Geometry batches received for this run, by file name. */
  live: Record<string, LiveFileGeometry>;
  /** Incremented whenever a batch is applied, so views can tell geometry changed without comparing large objects. */
  geometryVersion: number;
  startedAt: number | null;
  /** Events that were refused because they belonged to another run or case. Kept for transparency/tests. */
  ignored: number;
}

const emptyStages = (): Record<AnalysisStage, StageStatus> => ({ loading: 'pending', parsing: 'pending', geometry: 'pending', alignment: 'pending', comparison: 'pending', measurement: 'pending', reconciliation: 'pending' });

export const initialRun = (): RunState => ({ runId: null, caseId: null, status: 'idle', events: [], stages: emptyStages(), layers: [], live: {}, geometryVersion: 0, startedAt: null, ignored: 0 });

export type RunAction =
  | { type: 'start'; runId: string; caseId: string; at: number }
  | { type: 'event'; event: ProcessingEvent }
  | { type: 'complete'; runId: string; caseId: string }
  | { type: 'fail'; runId: string; caseId: string; message: string }
  | { type: 'cancel'; runId: string; caseId: string }
  | { type: 'reset' };

/** Keep memory bounded on long runs: only the most recent events are retained for display. */
const MAX_EVENTS = 400;

function applyBatch(live: Record<string, LiveFileGeometry>, b: GeometryBatch): Record<string, LiveFileGeometry> {
  const prev = live[b.fileName] ?? { fileName: b.fileName, documentId: b.documentId, layers: {}, layerOrder: [], metresPerUnit: null, unit: null, extents: null, delivered: 0, total: 0 };
  const layer = prev.layers[b.layer] ?? { entities: [], entityIds: [], batches: 0 };
  // A batch index already received for this layer is a duplicate delivery and is not applied twice.
  if (layer.batches > b.batchIndex) return live;
  const ext = b.extents;
  const merged = prev.extents && ext
    ? { minX: Math.min(prev.extents.minX, ext.minX), minY: Math.min(prev.extents.minY, ext.minY), maxX: Math.max(prev.extents.maxX, ext.maxX), maxY: Math.max(prev.extents.maxY, ext.maxY) }
    : prev.extents ?? ext;
  return {
    ...live,
    [b.fileName]: {
      ...prev,
      layers: { ...prev.layers, [b.layer]: { entities: layer.entities.concat(b.entities), entityIds: layer.entityIds.concat(b.entityIds), batches: layer.batches + 1 } },
      layerOrder: prev.layerOrder.includes(b.layer) ? prev.layerOrder : [...prev.layerOrder, b.layer],
      metresPerUnit: b.metresPerUnit ?? prev.metresPerUnit, unit: b.unit ?? prev.unit, extents: merged, delivered: b.delivered, total: b.total || prev.total,
    },
  };
}

/**
 * Reducer for a processing run. An event or terminal action is applied only when BOTH its run id and case id match the
 * active run. Late events from a cancelled run, an earlier run or another case are counted and discarded, and so are
 * geometry batches whose own run/case ids do not match the event that carried them.
 */
export function runReducer(s: RunState, a: RunAction): RunState {
  switch (a.type) {
    case 'reset': return initialRun();
    case 'start': return { ...initialRun(), runId: a.runId, caseId: a.caseId, status: 'running', startedAt: a.at };
    case 'event': {
      const e = a.event;
      if (s.status !== 'running' || e.runId !== s.runId || e.caseId !== s.caseId) return { ...s, ignored: s.ignored + 1 };
      if (e.batch && (e.batch.runId !== s.runId || e.batch.caseId !== s.caseId)) return { ...s, ignored: s.ignored + 1 };
      const stages = { ...s.stages };
      const next: StageStatus = e.status === 'done' ? 'done' : e.status === 'failed' ? 'failed' : e.status === 'skipped' ? 'skipped' : 'active';
      // Never regress a finished stage to active because a later progress event arrived.
      if (!(stages[e.stage] === 'done' && next === 'active')) stages[e.stage] = next;
      const layers = e.stage === 'geometry' && e.layer && !s.layers.some((l) => l.name === e.layer && l.fileName === (e.fileName ?? ''))
        ? [...s.layers, { name: e.layer, count: e.count ?? 0, fileName: e.fileName ?? '', seq: e.seq }]
        : e.stage === 'geometry' && e.layer
          ? s.layers.map((l) => (l.name === e.layer && l.fileName === (e.fileName ?? '') ? { ...l, count: e.count ?? l.count } : l))
          : s.layers;
      // The batch payload is kept in `live`; the event list keeps only the lightweight record.
      const { batch, ...light } = e;
      const events = s.events.length >= MAX_EVENTS ? [...s.events.slice(-(MAX_EVENTS - 1)), light] : [...s.events, light];
      return { ...s, events, stages, layers, live: batch ? applyBatch(s.live, batch) : s.live, geometryVersion: batch ? s.geometryVersion + 1 : s.geometryVersion };
    }
    case 'complete': return a.runId === s.runId && a.caseId === s.caseId && s.status === 'running' ? { ...s, status: 'complete', stages: s.stages.loading === 'active' ? { ...s.stages, loading: 'done' } : s.stages } : { ...s, ignored: s.ignored + 1 };
    case 'fail': return a.runId === s.runId && a.caseId === s.caseId && s.status === 'running' ? { ...s, status: 'failed' } : { ...s, ignored: s.ignored + 1 };
    case 'cancel': return a.runId === s.runId && a.caseId === s.caseId && s.status === 'running' ? { ...s, status: 'cancelled' } : s;
    default: return s;
  }
}

/**
 * Replay is purely visual and is only offered for a COMPLETED run. It re-reveals layers that were already processed;
 * it has its own state (paused, skipped, position) and never touches the run. It is never used while a run is live.
 */
export interface PlaybackState { position: number; paused: boolean; skipped: boolean; reducedMotion: boolean }
export const initialPlayback = (reducedMotion = false): PlaybackState => ({ position: 0, paused: false, skipped: reducedMotion, reducedMotion });

export type PlaybackAction = { type: 'tick'; available: number } | { type: 'pause' } | { type: 'resume' } | { type: 'skip'; available: number } | { type: 'replay' };

export function playbackReducer(p: PlaybackState, a: PlaybackAction): PlaybackState {
  switch (a.type) {
    case 'tick': return p.paused || p.skipped ? p : { ...p, position: Math.min(a.available, p.position + 1) };
    case 'pause': return { ...p, paused: true };
    case 'resume': return { ...p, paused: false };
    case 'skip': return { ...p, skipped: true, position: a.available };
    case 'replay': return { ...p, position: 0, paused: false, skipped: p.reducedMotion };
    default: return p;
  }
}

/** Number of layers to draw now. Reduced motion or a skip shows everything that is available immediately. */
export const visibleLayerCount = (p: PlaybackState, available: number): number => (p.skipped ? available : Math.min(p.position, available));

/**
 * Honest description of the picture. While a run is live the picture is exactly the geometry received so far.
 * After the run, anything animated is a Replay of results that already existed.
 */
export function playbackLabel(run: RunState, replaying: boolean): string {
  if (run.status === 'running') {
    const parsing = run.stages.parsing === 'active' && run.geometryVersion === 0;
    return parsing ? 'Parsing: the file is being read as a whole, so no geometry can be shown until parsing finishes' : 'Live: showing geometry as it is received from the parser';
  }
  if (replaying) return 'Replay of completed processing (not live)';
  if (run.status === 'complete') return 'Processing complete';
  if (run.status === 'cancelled') return 'Cancelled: partial geometry only';
  return 'Processing ended';
}

/** Rough coverage summary for the file, from what really arrived. */
export function coverageOf(f: LiveFileGeometry | undefined): { delivered: number; total: number; pct: number | null } {
  if (!f) return { delivered: 0, total: 0, pct: null };
  return { delivered: f.delivered, total: f.total, pct: f.total > 0 ? Math.min(100, Math.round((f.delivered / f.total) * 100)) : null };
}

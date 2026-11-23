/**
 * Pure helpers for persisted background jobs: progress, register rows, preview labelling, geometry assembly.
 * No I/O. Everything is derived from rows that the worker really wrote.
 */
import type { EventRow, JobRow, TaskRow } from './jobService';

export interface PolyGeo { kind: string; layer: string; closed: boolean; points: [number, number][]; length: number; fromBlock?: string }
export interface DxfCoverage {
  complete: boolean; scope: string; unit: 'mm' | 'cm' | 'm' | null; metresPerUnit: number | null;
  extents: { minX: number; minY: number; maxX: number; maxY: number } | null; issues: string[];
  layers: { layer: string; entities: number; lengthUnits: number }[];
  processedTypes: Record<string, number>; skippedTypes: Record<string, number>; skippedEntityCount: number;
  supportedEntityTypes: string[]; geometryEntities: number; textEntities: number; insertsExpanded: number;
  unresolvedXrefs: string[]; batches: number; geometryHash: string;
}
export interface TaskResult { kind?: string; ok?: boolean; state?: string; label?: string; fileName?: string; sha256?: string; coverage?: DxfCoverage; converter?: string | null; converterVersion?: string; error?: string }

export type DisplayState = 'queued' | 'running' | 'stopping' | 'stopped' | 'completed' | 'partial' | 'failed';
export const STATE_LABEL: Record<DisplayState, string> = { queued: 'Queued', running: 'Running', stopping: 'Stopping…', stopped: 'Stopped', completed: 'Completed', partial: 'Completed with limits', failed: 'Failed' };
export const isActive = (s: string) => s === 'queued' || s === 'running' || s === 'stopping';

export interface JobProgress {
  totalTasks: number; completed: number; reused: number; running: number; queued: number; failed: number; cancelled: number; partial: number;
  /** Null when the denominator is unknown. We never invent a percentage. */
  fractionDone: number | null;
  perDocument: { docId: string; fileName: string; stages: { stage: string; status: string; attempts: number; error: string | null; detail: string | null }[] }[];
  lastUpdate: string | null; elapsedMs: number | null; heartbeatAgeMs: number | null; stalled: boolean;
}

/** `now` is injected so tests (and hydration-safe components) never read the clock in render. */
export function summariseProgress(job: JobRow, tasks: TaskRow[], now: number): JobProgress {
  const by = (s: string) => tasks.filter((t) => t.status === s).length;
  const done = by('completed') + by('partial') + by('reused');
  const docs = new Map<string, JobProgress['perDocument'][number]>();
  for (const t of tasks) {
    const d = docs.get(t.doc_id) ?? { docId: t.doc_id, fileName: t.file_name, stages: [] };
    d.stages.push({ stage: t.stage, status: t.status, attempts: t.attempts, error: t.error, detail: typeof t.progress?.detail === 'string' ? (t.progress.detail as string) : null });
    docs.set(t.doc_id, d);
  }
  const stamps = [job.updated_at, ...tasks.map((t) => t.updated_at)].filter(Boolean).map((s) => Date.parse(s));
  const last = stamps.length ? Math.max(...stamps) : null;
  const start = job.started_at ? Date.parse(job.started_at) : job.created_at ? Date.parse(job.created_at) : null;
  const end = job.finished_at ? Date.parse(job.finished_at) : now;
  const hb = tasks.filter((t) => t.status === 'running' && t.heartbeat_at).map((t) => Date.parse(t.heartbeat_at as string));
  const hbAge = hb.length ? now - Math.max(...hb) : null;
  return {
    totalTasks: tasks.length, completed: by('completed'), reused: by('reused'), running: by('running'), queued: by('queued'), failed: by('failed'), cancelled: by('cancelled'), partial: by('partial'),
    fractionDone: tasks.length > 0 ? done / tasks.length : null,
    perDocument: [...docs.values()], lastUpdate: last ? new Date(last).toISOString() : null,
    elapsedMs: start ? Math.max(0, end - start) : null, heartbeatAgeMs: hbAge,
    // A running task whose heartbeat is long overdue: the worker is probably not alive (recovery happens once its lease expires).
    stalled: job.state === 'running' && hbAge !== null && hbAge > 90_000,
  };
}

/** What the user is looking at, stated plainly. Never "complete" unless the worker's own coverage says so. */
export type PreviewKind = 'partial' | 'supported_complete' | 'original_file' | 'replay' | 'none';
export function previewKind(args: { receiving: boolean; coverage: DxfCoverage | undefined; hasGeometry: boolean; replaying: boolean }): { kind: PreviewKind; label: string; detail: string } {
  if (args.replaying) return { kind: 'replay', label: 'Replay', detail: 'A recorded replay of geometry that was already processed. It is not live processing.' };
  if (!args.hasGeometry) return { kind: 'none', label: 'No geometry', detail: 'No geometry has been received for this drawing.' };
  if (args.receiving) return { kind: 'partial', label: 'Partial preview', detail: 'Geometry received so far from the running job. More is still arriving.' };
  if (args.coverage && args.coverage.complete) return { kind: 'supported_complete', label: 'Complete supported-geometry preview', detail: 'Every entity in this file was of a supported type and is drawn.' };
  return { kind: 'supported_complete', label: 'Supported geometry only', detail: 'All geometry of the supported types is drawn. Unsupported content is NOT shown, so this is not a complete reproduction of the CAD file.' };
}

export interface RegisterRow {
  docId: string; fileName: string; format: string; role: 'original' | 'revised' | 'unpaired'; pairKey: string | null; counterpart: string | null;
  status: 'processed' | 'partial' | 'failed' | 'pending' | 'not_processed'; statusLabel: string; reason: string | null;
  unit: string | null; scale: string; layers: number; processedTypes: string; skippedTypes: { name: string; count: number }[]; xrefs: string[];
  changeCount: number; hasGeometry: boolean; sha256: string | null; geometryHash: string | null; converter: string | null; limits: string[];
}

const baseName = (n: string) => n.replace(/\.[a-z0-9]+$/i, '');
const normKey = (n: string) => baseName(n).toLowerCase().replace(/[\s_.-]*(rev(ision)?|r)[\s_.-]*[a-z0-9]+$/i, '').replace(/[\s_.-]+$/g, '');
const revOf = (n: string) => (baseName(n).match(/[\s_.-](?:rev(?:ision)?|r)[\s_.-]*([a-z0-9]+)$/i) ?? [])[1]?.toUpperCase() ?? null;
const extOf = (n: string) => (n.match(/\.([a-z0-9]+)$/i) ?? [])[1]?.toLowerCase() ?? '';

/**
 * One row per included drawing document. Pairs are inferred from file names (same base, different revision marker) and
 * SAID to be inferred; a document with no partner is shown as unpaired with the reason. Nothing is hidden.
 */
export function buildRegister(tasks: TaskRow[], results: Record<string, TaskResult | undefined>, changeCounts: Record<string, number> = {}): RegisterRow[] {
  const docs = new Map<string, TaskRow>();
  for (const t of tasks) if (!docs.has(t.doc_id)) docs.set(t.doc_id, t);
  const groups = new Map<string, TaskRow[]>();
  for (const t of docs.values()) { const k = normKey(t.file_name); groups.set(k, [...(groups.get(k) ?? []), t]); }
  const rows: RegisterRow[] = [];
  for (const t of docs.values()) {
    const g = groups.get(normKey(t.file_name)) ?? [t];
    const sorted = [...g].sort((a, b) => (revOf(a.file_name) ?? '').localeCompare(revOf(b.file_name) ?? '') || a.file_name.localeCompare(b.file_name));
    const paired = sorted.length === 2 && revOf(sorted[0].file_name) !== revOf(sorted[1].file_name);
    const role: RegisterRow['role'] = !paired ? 'unpaired' : sorted[0].doc_id === t.doc_id ? 'original' : 'revised';
    const other = paired ? sorted.find((x) => x.doc_id !== t.doc_id) : undefined;
    const tasksOfDoc = tasks.filter((x) => x.doc_id === t.doc_id);
    const res = results[t.doc_id];
    const cov = res?.coverage;
    const failed = tasksOfDoc.some((x) => x.status === 'failed'); const pending = tasksOfDoc.some((x) => x.status === 'queued' || x.status === 'running');
    const fmt = extOf(t.file_name);
    const dwgUnavailable = fmt === 'dwg' && (failed || res?.ok === false) && /converter|DWG_CONVERTER|not found|not set/i.test(`${res?.error ?? ''} ${tasksOfDoc.map((x) => x.error ?? '').join(' ')}`);
    const status: RegisterRow['status'] = dwgUnavailable ? 'not_processed' : failed ? 'failed' : pending ? 'pending' : cov ? (cov.complete ? 'processed' : 'partial') : res?.ok ? 'processed' : 'not_processed';
    const statusLabel = dwgUnavailable ? 'Not processed: converter unavailable' : status === 'processed' ? 'Processed (all entities supported)' : status === 'partial' ? 'Processed with coverage limits' : status === 'failed' ? 'Failed' : status === 'pending' ? 'Waiting / in progress' : 'Not processed';
    const limits: string[] = [];
    if (cov) { limits.push(...cov.issues); if (cov.skippedEntityCount) limits.push(`${cov.skippedEntityCount} entit${cov.skippedEntityCount === 1 ? 'y' : 'ies'} of unsupported type were not processed.`); if (cov.unresolvedXrefs.length) limits.push(`${cov.unresolvedXrefs.length} external reference(s) unresolved.`); if (!cov.unit) limits.push('Units not declared; no scale.'); }
    if (!paired) limits.push(sorted.length > 2 ? `Ambiguous: ${sorted.length} files share the base name "${normKey(t.file_name)}", so no original/revised pairing was made.` : `No counterpart revision found for "${normKey(t.file_name)}". Compared against nothing, so no change can be measured for this drawing.`);
    rows.push({
      docId: t.doc_id, fileName: t.file_name, format: fmt.toUpperCase(), role, pairKey: paired ? normKey(t.file_name) : null, counterpart: other?.file_name ?? null,
      status, statusLabel, reason: failed ? (tasksOfDoc.find((x) => x.error)?.error ?? res?.error ?? null) : null,
      unit: cov?.unit ?? null, scale: cov?.metresPerUnit ? `1 unit = ${cov.metresPerUnit} m` : 'Not established',
      layers: cov?.layers.length ?? 0, processedTypes: cov ? Object.entries(cov.processedTypes).map(([k, v]) => `${k}×${v}`).join(', ') || 'none' : '—',
      skippedTypes: cov ? Object.entries(cov.skippedTypes).map(([name, count]) => ({ name, count })) : [], xrefs: cov?.unresolvedXrefs ?? [],
      changeCount: changeCounts[t.doc_id] ?? 0, hasGeometry: !!cov && cov.geometryEntities > 0, sha256: res?.sha256 ?? t.input_hash, geometryHash: cov?.geometryHash ?? null, converter: res?.converter ?? null, limits,
    });
  }
  return rows.sort((a, b) => (a.pairKey ?? `~${a.fileName}`).localeCompare(b.pairKey ?? `~${b.fileName}`) || (a.role === 'original' ? -1 : 1));
}

/** Assemble geometry per document from persisted 'geometry' events. Duplicate (layer, batchIndex) deliveries are ignored. */
export function assembleGeometry(events: EventRow[]): Record<string, { layers: Record<string, PolyGeo[]>; delivered: number; total: number; extents: { minX: number; minY: number; maxX: number; maxY: number } | null; unit: string | null; seen: Set<string> }> {
  const out: Record<string, { layers: Record<string, PolyGeo[]>; delivered: number; total: number; extents: { minX: number; minY: number; maxX: number; maxY: number } | null; unit: string | null; seen: Set<string> }> = {};
  for (const e of events) {
    if (e.kind !== 'geometry' || !e.task_id || !e.payload) continue;
    const p = e.payload as { layer?: string; batchIndex?: number; entities?: PolyGeo[]; delivered?: number; total?: number; extents?: { minX: number; minY: number; maxX: number; maxY: number } | null; unit?: string | null };
    if (!p.layer || !Array.isArray(p.entities)) continue;
    const doc = e.task_id.split(':')[1] ?? e.task_id;
    const d = (out[doc] ??= { layers: {}, delivered: 0, total: 0, extents: null, unit: null, seen: new Set() });
    const key = `${p.layer}#${p.batchIndex ?? 0}`;
    if (d.seen.has(key)) continue;
    d.seen.add(key);
    (d.layers[p.layer] ??= []).push(...p.entities);
    d.delivered = Math.max(d.delivered, p.delivered ?? 0); d.total = Math.max(d.total, p.total ?? 0); d.extents = p.extents ?? d.extents; d.unit = p.unit ?? d.unit;
  }
  return out;
}

export const fmtDuration = (ms: number | null) => { if (ms === null) return '—'; const s = Math.floor(ms / 1000); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}m ${s % 60}s` : m ? `${m}m ${s % 60}s` : `${s}s`; };

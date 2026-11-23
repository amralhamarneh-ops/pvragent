import type { AnalysisOutput } from './analyse';
import type { ExtractedDocument, ReconciledChange } from './types';
import type { ScheduleModel } from '@/lib/mapping/types';

/**
 * Compact, persistable record of one finished analysis. Geometry is NOT stored here: it is re-read from the stored
 * original bytes (identified by sha256), so the picture can never drift from the file. What is stored is the result
 * (changes with entity references, extracted text with page references, parsed programmes) and the exact document
 * versions it was computed from, so a changed document set marks it stale instead of silently reusing it.
 *
 * Every finished run is appended as a new version. Earlier versions are kept (bounded) and never overwritten.
 */
export interface AnalysisSnapshot {
  v: 1;
  caseId: string;
  runId: string;
  /** 1-based version number within the case. */
  version: number;
  savedAt: string;
  /** Documents the result was computed from. */
  inputs: { id: string; name: string; sha256: string; role: string }[];
  narrativeHash: string;
  changes: ReconciledChange[];
  documents: ExtractedDocument[];
  schedules: { fileName: string; model: ScheduleModel }[];
  pairs: { original: string; revised: string; validated: boolean; blockers: string[]; drawingNumber: string; originShift?: { dx: number; dy: number } | null }[];
  relocationEvidence: boolean;
  events: { step: string; detail: string }[];
  /** Fingerprint of the change records, so a dependent mapping can tell whether it was built from these exact records. */
  changeFingerprint: string;
}

const KEY = (caseId: string) => `pvr-agent-analysis-v1:${caseId}`;
const HISTORY_KEY = (caseId: string) => `pvr-agent-analysis-history-v1:${caseId}`;
const MAX_HISTORY = 8;

export function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

/** Stable fingerprint of the records a downstream mapping depends on. */
export function fingerprintChanges(changes: ReconciledChange[]): string {
  const parts = changes.map((c) => `${c.id}|${c.unit}|${c.changeQty}|${c.addedQty ?? ''}|${c.omittedQty ?? ''}|${c.basis}|${c.change ?? ''}|${(c.entityRefs?.original ?? []).length}|${(c.entityRefs?.revised ?? []).length}`).sort();
  return hashText(parts.join('\n'));
}

export function buildSnapshot(caseId: string, runId: string, out: AnalysisOutput, inputs: AnalysisSnapshot['inputs'], narrative: string, version = 1): AnalysisSnapshot {
  return {
    v: 1, caseId, runId, version, savedAt: new Date().toISOString(), inputs, narrativeHash: hashText(narrative),
    changes: out.changes, documents: out.documents, schedules: out.schedules, relocationEvidence: out.relocationEvidence, events: out.events,
    pairs: out.pairs.map((p) => ({ original: p.original.fileName, revised: p.revised.fileName, validated: p.validated, blockers: p.blockers, drawingNumber: p.revised.titleBlock?.drawingNumber ?? '', originShift: p.originShift ? { dx: p.originShift.dx, dy: p.originShift.dy } : null })),
    changeFingerprint: fingerprintChanges(out.changes),
  };
}

export function loadHistory(caseId: string): AnalysisSnapshot[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY(caseId));
    if (!raw) return [];
    const list = JSON.parse(raw) as AnalysisSnapshot[];
    return Array.isArray(list) ? list.filter((s) => s && s.v === 1 && s.caseId === caseId) : [];
  } catch { return []; }
}

/** The next version number for a case, one more than the highest saved. */
export function nextVersion(caseId: string): number {
  let h = loadHistory(caseId);
  return h.reduce((m, s) => Math.max(m, s.version ?? 0), 0) + 1;
}

/** Save as the current snapshot and append to the version history. Earlier versions are kept, newest last. */
export function saveSnapshot(s: AnalysisSnapshot): boolean {
  try {
    window.localStorage.setItem(KEY(s.caseId), JSON.stringify(s));
  } catch { return false; }
  try {
    const history = loadHistory(s.caseId).filter((x) => x.runId !== s.runId);
    const next = [...history, s].slice(-MAX_HISTORY);
    window.localStorage.setItem(HISTORY_KEY(s.caseId), JSON.stringify(next));
  } catch {
    // The current snapshot was saved; only the history copy could not be (storage full). Report that honestly.
    return true;
  }
  return true;
}

export function loadSnapshot(caseId: string): AnalysisSnapshot | null {
  try {
    const raw = window.localStorage.getItem(KEY(caseId));
    if (!raw) return null;
    const s = JSON.parse(raw) as AnalysisSnapshot;
    return s && s.v === 1 && s.caseId === caseId && Array.isArray(s.changes) ? { ...s, version: s.version ?? 1, changeFingerprint: s.changeFingerprint ?? fingerprintChanges(s.changes) } : null;
  } catch { return null; }
}

/** Removes the current snapshot only. Version history is kept so earlier results stay recoverable. */
export function clearSnapshot(caseId: string): void {
  try { window.localStorage.removeItem(KEY(caseId)); } catch { /* ignore */ }
}

/** A snapshot is current only when every input is still an active document with the same content and the narrative matches. */
export function snapshotStatus(s: AnalysisSnapshot, active: { id: string; sha256: string; role: string }[], narrative: string): { current: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const byId = new Map(active.map((d) => [d.id, d]));
  for (let i of s.inputs) {
    const a = byId.get(i.id);
    if (!a) reasons.push(`${i.name} is no longer part of this PVR.`);
    else if (a.sha256 !== i.sha256) reasons.push(`${i.name} was replaced.`);
    else if (a.role !== i.role) reasons.push(`${i.name} was reclassified.`);
  }
  const known = new Set(s.inputs.map((i) => i.id));
  for (const a of active) if (!known.has(a.id) && ['drawings', 'pvr', 'correspondence', 'schedule', 'contract', 'reference', 'site'].includes(a.role)) reasons.push(`A document was added after this analysis (role ${a.role}).`);
  if (hashText(narrative) !== s.narrativeHash) reasons.push('The narrative changed.');
  return { current: reasons.length === 0, reasons };
}

/** True when a dependent record was built from different change records than the current analysis produced. */
export function dependentIsStale(builtFrom: string | undefined | null, current: AnalysisSnapshot | null): boolean {
  if (!current) return false;
  return !!builtFrom && builtFrom !== current.changeFingerprint;
}

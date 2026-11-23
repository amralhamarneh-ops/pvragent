'use client';

import type { BoqImport, CaseRecord, ParsedRow } from '@/lib/boq/types';
import type { SavedCalculation } from '@/lib/boq/revisions';
import { getAccessToken } from '@/lib/supabase/client';
import { planBatches, utf8Bytes, MAX_ROW_BYTES, type OversizedRow, type StageAck } from '@/lib/boq/importBatches';

export type PersistenceMode = 'server' | 'session_only';

export interface Persistence {
  mode: PersistenceMode;
  /** Exact reason the server could not be used, when mode is session_only. */
  blocker: string;
}

/** Why a request did not succeed. `not_signed_in` and `forbidden` never fall back to temporary storage. */
export type FailureKind = 'not_signed_in' | 'forbidden' | 'not_found' | 'unavailable' | 'invalid' | 'other';

/** Sanitised, structured cause returned by the server. Never contains tokens, keys or document contents. */
export interface FailureDiagnostic {
  code: string;
  operation: string;
  resource: string;
  httpStatus: number | null;
  dbCode: string;
  message: string;
  details: string;
  hint: string;
  nextAction: string;
}

export const SESSION_LOSS_WARNING = 'Held only in this browser tab. It is lost when the tab is closed, the browser clears site data, or you open the case on another device. Nothing is stored on the server.';

const SESSION_PREFIX = 'pvr-real-case:';

interface SessionBlob { case: CaseRecord; imports: BoqImport[] }

function sessionRead(caseId: string): SessionBlob | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_PREFIX + caseId);
    return raw ? (JSON.parse(raw) as SessionBlob) : null;
  } catch { return null; }
}
function sessionWrite(blob: SessionBlob): boolean {
  try { window.sessionStorage.setItem(SESSION_PREFIX + blob.case.id, JSON.stringify(blob)); return true; } catch { return false; }
}

interface Body { error?: string; blocker?: string; diagnostic?: FailureDiagnostic }
async function json<T>(res: Response): Promise<T & Body> {
  try { return (await res.json()) as T & Body; } catch { return { error: `HTTP ${res.status}` } as T & Body; }
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function kindOf(status: number, blocker?: string): FailureKind {
  if (status === 401 || blocker === 'not_signed_in') return 'not_signed_in';
  if (status === 403 || blocker === 'forbidden') return 'forbidden';
  if (status === 404 || blocker === 'not_found') return 'not_found';
  if (status === 400) return 'invalid';
  if (status === 503 || ['not_configured', 'tables_missing', 'network', 'rejected'].includes(blocker ?? '')) return 'unavailable';
  return 'other';
}

export interface CreateResult {
  case: CaseRecord | null;
  persistence: Persistence;
  /** Set when no case was created. A sign-in or permission failure never produces a temporary case. */
  error: string;
  failure: FailureKind | null;
}

export async function createRealCase(title: string, currency: string): Promise<CreateResult> {
  const session = (blocker: string): CreateResult => {
    const local: CaseRecord = { id: `session-${crypto.randomUUID()}`, title, mode: 'real', currency, createdAt: new Date().toISOString(), selectedImportId: null };
    if (!sessionWrite({ case: local, imports: [] })) return { case: null, persistence: { mode: 'session_only', blocker }, error: 'Server storage is unavailable and this browser could not hold a temporary copy either.', failure: 'unavailable' };
    return { case: local, persistence: { mode: 'session_only', blocker: `${blocker} ${SESSION_LOSS_WARNING}` }, error: '', failure: null };
  };
  try {
    const res = await fetch('/api/boq-cases', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ title, currency }) });
    const data = await json<{ case: CaseRecord }>(res);
    if (res.ok && data.case) return { case: data.case, persistence: { mode: 'server', blocker: '' }, error: '', failure: null };
    const failure = kindOf(res.status, data.blocker);
    // Only an unreachable or unconfigured server may fall back, and the fallback is labelled temporary.
    if (failure === 'unavailable') return session(`Server storage is unavailable: ${data.error ?? `HTTP ${res.status}`}`);
    return { case: null, persistence: { mode: 'server', blocker: data.blocker ?? '' }, error: data.error ?? `Could not create the case (HTTP ${res.status}).`, failure };
  } catch (e) {
    return session(`Could not reach the server (${e instanceof Error ? e.message : 'network error'}).`);
  }
}

export interface LoadedCase {
  case: CaseRecord | null;
  /** COMPLETE imports with all rows (loaded page by page). Pending imports are never in this list. */
  imports: BoqImport[];
  /** Imports whose staged save did not finish. They are not usable until resumed and finalised. */
  pending: PendingImport[];
  persistence: Persistence;
  /** Set when the case could not be loaded. The caller must show this and must not substitute sample data. */
  error: string;
  failure: FailureKind | null;
  /** Specific verified cause when the server supplied one. */
  diagnostic?: FailureDiagnostic | null;
}

/** An interrupted staged import, described without its rows. */
export interface PendingImport {
  id: string;
  revision: number;
  fileName: string;
  revisionLabel: string;
  expectedRows: number;
  savedRows: number;
  expectedBatches: number;
  savedBatches: number;
}

interface SummaryDto {
  id: string; caseId: string; revision: number; source: BoqImport['source']; mappings: BoqImport['mappings']; confirmedAt: string | null;
  status: 'pending' | 'complete'; expectedRows: number; expectedBatches: number; savedRows: number; savedBatches: number;
}

const ROW_PAGE = 500;

/** Load every row of a complete import through the paginated endpoint. The whole BOQ is returned, not the first page. */
async function loadAllRows(caseId: string, importId: string, expected: number): Promise<{ rows: ParsedRow[]; error: string }> {
  const rows: ParsedRow[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const res: Response = await fetch(`/api/boq-cases/${encodeURIComponent(caseId)}/imports/${encodeURIComponent(importId)}/rows?offset=${offset}&limit=${ROW_PAGE}`, { cache: 'no-store', headers: await authHeaders() });
    const data: { rows?: ParsedRow[]; nextOffset?: number | null } & Body = await json<{ rows: ParsedRow[]; nextOffset: number | null }>(res);
    if (!res.ok || !data.rows) return { rows: [], error: data.error ?? `Could not load BOQ rows (HTTP ${res.status}).` };
    rows.push(...data.rows);
    offset = data.nextOffset ?? null;
  }
  if (rows.length !== expected) return { rows: [], error: `The BOQ rows loaded (${rows.length}) do not match the saved total (${expected}).` };
  return { rows, error: '' };
}

export async function loadRealCase(caseId: string): Promise<LoadedCase> {
  if (caseId.startsWith('session-')) {
    const b = sessionRead(caseId);
    if (!b) return { case: null, imports: [], pending: [], persistence: { mode: 'session_only', blocker: SESSION_LOSS_WARNING }, error: 'This temporary case is no longer available in this browser tab. It was never saved to a server, so it cannot be recovered.', failure: 'not_found' };
    return { case: b.case, imports: b.imports, pending: [], persistence: { mode: 'session_only', blocker: SESSION_LOSS_WARNING }, error: '', failure: null };
  }
  try {
    const res = await fetch(`/api/boq-cases/${encodeURIComponent(caseId)}`, { cache: 'no-store', headers: await authHeaders() });
    const data = await json<{ case: CaseRecord; summaries: SummaryDto[] }>(res);
    if (res.ok && data.case) {
      const imports: BoqImport[] = [];
      const pending: PendingImport[] = [];
      for (const s of data.summaries ?? []) {
        if (s.status === 'pending') {
          pending.push({ id: s.id, revision: s.revision, fileName: s.source.fileName, revisionLabel: s.source.revisionLabel, expectedRows: s.expectedRows, savedRows: s.savedRows, expectedBatches: s.expectedBatches, savedBatches: s.savedBatches });
          continue;
        }
        const r = await loadAllRows(caseId, s.id, s.expectedRows);
        if (r.error) return { case: null, imports: [], pending: [], persistence: { mode: 'server', blocker: '' }, error: r.error, failure: 'other' };
        imports.push({ id: s.id, caseId: s.caseId, revision: s.revision, source: s.source, mappings: s.mappings, rows: r.rows, confirmedAt: s.confirmedAt });
      }
      return { case: data.case, imports, pending, persistence: { mode: 'server', blocker: '' }, error: '', failure: null };
    }
    return { case: null, imports: [], pending: [], persistence: { mode: 'server', blocker: data.blocker ?? '' }, error: data.error ?? `Could not load case (HTTP ${res.status}).`, failure: kindOf(res.status, data.blocker), diagnostic: data.diagnostic ?? null };
  } catch (e) {
    return { case: null, imports: [], pending: [], persistence: { mode: 'server', blocker: 'network' }, error: `Could not reach the server: ${e instanceof Error ? e.message : 'network error'}.`, failure: 'unavailable' };
  }
}

/** Where a staged save is, for the UI. */
export type SavePhase = 'initialising' | 'saving' | 'finalising' | 'complete';
export interface SaveProgress { phase: SavePhase; savedRows: number; totalRows: number; savedBatches: number; totalBatches: number }

export interface StagedSaveResult {
  persistence: Persistence;
  /** Empty when the import is complete. */
  error: string;
  failure: FailureKind | null;
  /** True when the failure was the request size limit (HTTP 413), so the UI can explain it specifically. */
  tooLarge: boolean;
  /** True when some batches are stored and the save can be resumed. */
  resumable: boolean;
  complete: boolean;
  /** Rows that individually exceed the batch ceiling. Never truncated. */
  oversized: OversizedRow[];
  progress: SaveProgress;
}

interface AckDto extends StageAck { ok?: boolean; message?: string; bytes?: number; limit?: number }

async function post(caseId: string, payload: unknown): Promise<{ res: Response; data: AckDto & Body; bytes: number }> {
  const body = JSON.stringify(payload);
  const res = await fetch(`/api/boq-cases/${encodeURIComponent(caseId)}/imports`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body });
  return { res, data: await json<AckDto>(res), bytes: utf8Bytes(body) };
}

/**
 * Save an import in stages: initialise (metadata only), upload bounded batches, then finalise.
 * Safe to call again after any failure: the same import id and batch ids are reused, batches the server already holds
 * are skipped, and the server ignores a repeated batch. Only the missing batches are sent.
 */
export async function saveImportStaged(c: CaseRecord, imp: BoqImport, onProgress?: (p: SaveProgress) => void): Promise<StagedSaveResult> {
  const plan = await planBatches(imp.id, imp.rows);
  const prog: SaveProgress = { phase: 'initialising', savedRows: 0, totalRows: plan.totalRows, savedBatches: 0, totalBatches: plan.batches.length };
  const emit = (patch: Partial<SaveProgress>) => { Object.assign(prog, patch); onProgress?.({ ...prog }); };
  const fail = (error: string, status: number, blocker: string | undefined, resumable: boolean): StagedSaveResult => ({ persistence: { mode: 'server', blocker: blocker ?? '' }, error, failure: kindOf(status, blocker), tooLarge: status === 413, resumable, complete: false, oversized: [], progress: { ...prog } });

  if (plan.oversized.length > 0) {
    const o = plan.oversized[0];
    return { persistence: { mode: 'server', blocker: '' }, error: `Row ${o.rowNumber} on sheet "${o.sheet}" is ${o.bytes.toLocaleString('en-US')} bytes, larger than the ${MAX_ROW_BYTES.toLocaleString('en-US')}-byte limit for one row. Nothing was saved and no row was shortened. Reduce that row in the source file or split it.`, failure: 'invalid', tooLarge: true, resumable: false, complete: false, oversized: plan.oversized, progress: { ...prog } };
  }
  if (c.id.startsWith('session-')) {
    return { persistence: { mode: 'session_only', blocker: SESSION_LOSS_WARNING }, error: 'Temporary cases are saved through the in-browser path.', failure: 'invalid', tooLarge: false, resumable: false, complete: false, oversized: [], progress: { ...prog } };
  }
  try {
    emit({ phase: 'initialising' });
    const init = await post(c.id, { action: 'init', init: { importId: imp.id, revision: imp.revision, expectedRows: plan.totalRows, expectedBatches: plan.batches.length, importChecksum: plan.importChecksum, meta: { fileName: imp.source.fileName, sha256: imp.source.sha256, sizeBytes: imp.source.sizeBytes, format: imp.source.format, currency: imp.source.currency, revisionLabel: imp.source.revisionLabel, mappings: imp.mappings, confirmedAt: imp.confirmedAt, storagePath: imp.source.storagePath ?? null, uploadedAt: imp.source.uploadedAt ?? null, fileStored: !!imp.source.fileStored } } });
    if (!init.res.ok) return fail(init.data.error ?? `Could not start the import (HTTP ${init.res.status}).`, init.res.status, init.data.blocker, false);
    if (init.data.status === 'complete') {
      emit({ phase: 'complete', savedRows: plan.totalRows, savedBatches: plan.batches.length });
      return { persistence: { mode: 'server', blocker: '' }, error: '', failure: null, tooLarge: false, resumable: false, complete: true, oversized: [], progress: { ...prog } };
    }
    const have = new Set(init.data.savedBatchIds ?? []);
    const rowsOf = new Map(plan.batches.map((b) => [b.batchId, b.rows.length]));
    emit({ phase: 'saving', savedBatches: have.size, savedRows: Array.from(have).reduce((n, id) => n + (rowsOf.get(id) ?? 0), 0) });

    for (const b of plan.batches) {
      if (have.has(b.batchId)) continue;
      const r = await post(c.id, { action: 'batch', batch: { importId: imp.id, batchId: b.batchId, index: b.index, checksum: b.checksum, rows: b.rows } });
      if (!r.res.ok) {
        const msg = r.res.status === 413
          ? `The extracted-data batch (${r.bytes.toLocaleString('en-US')} bytes, ${b.rows.length} rows) exceeded the request limit. ${prog.savedRows.toLocaleString('en-US')} of ${prog.totalRows.toLocaleString('en-US')} rows are already saved safely. Resume save will send only the remaining batches.`
          : `${r.data.error ?? `Batch ${b.index + 1} failed (HTTP ${r.res.status}).`} ${prog.savedRows.toLocaleString('en-US')} of ${prog.totalRows.toLocaleString('en-US')} rows are saved. Resume save will continue from the next missing batch.`;
        return fail(msg, r.res.status, r.data.blocker, true);
      }
      have.add(b.batchId);
      emit({ savedBatches: r.data.savedBatches ?? have.size, savedRows: r.data.savedRows ?? prog.savedRows + b.rows.length });
    }

    emit({ phase: 'finalising' });
    const fin = await post(c.id, { action: 'finalize', importId: imp.id, importChecksum: plan.importChecksum });
    if (!fin.res.ok || !fin.data.ok) return fail(fin.data.message ?? fin.data.error ?? `The import could not be finalised (HTTP ${fin.res.status}). Your saved batches are kept; use Resume save.`, fin.res.status, fin.data.blocker, true);
    emit({ phase: 'complete', savedRows: plan.totalRows, savedBatches: plan.batches.length });
    return { persistence: { mode: 'server', blocker: '' }, error: '', failure: null, tooLarge: false, resumable: false, complete: true, oversized: [], progress: { ...prog } };
  } catch (e) {
    return { persistence: { mode: 'server', blocker: 'network' }, error: `Could not reach the server: ${e instanceof Error ? e.message : 'network error'}. ${prog.savedRows.toLocaleString('en-US')} of ${prog.totalRows.toLocaleString('en-US')} rows are saved. Use Resume save.`, failure: 'unavailable', tooLarge: false, resumable: true, complete: false, oversized: [], progress: { ...prog } };
  }
}

/**
 * Session-only (temporary) save. Server cases NEVER use a single large request: they go through saveImportStaged.
 */
export async function saveImport(c: CaseRecord, imp: BoqImport, existing: BoqImport[]): Promise<{ persistence: Persistence; error: string; failure: FailureKind | null }> {
  if (!c.id.startsWith('session-')) {
    return { persistence: { mode: 'server', blocker: '' }, error: 'Server cases must be saved with the staged import (saveImportStaged).', failure: 'invalid' };
  }
  const others = existing.filter((i) => i.id !== imp.id);
  const selected = c.selectedImportId ?? (imp.confirmedAt ? imp.id : null);
  const ok = sessionWrite({ case: { ...c, selectedImportId: selected }, imports: [...others, imp] });
  if (!ok) return { persistence: { mode: 'session_only', blocker: SESSION_LOSS_WARNING }, error: 'This browser could not hold the temporary copy (storage full or blocked). The import was NOT saved anywhere.', failure: 'unavailable' };
  return { persistence: { mode: 'session_only', blocker: SESSION_LOSS_WARNING }, error: '', failure: null };
}

export async function selectImportRevision(c: CaseRecord, importId: string, imports: BoqImport[]): Promise<{ case: CaseRecord | null; error: string }> {
  if (c.id.startsWith('session-')) {
    const target = imports.find((i) => i.id === importId);
    if (!target || !target.confirmedAt) return { case: null, error: 'Only a confirmed import of this case can be selected.' };
    const next = { ...c, selectedImportId: importId };
    if (!sessionWrite({ case: next, imports })) return { case: null, error: 'This browser could not hold the temporary copy. The selection was not saved.' };
    return { case: next, error: '' };
  }
  try {
    const res = await fetch(`/api/boq-cases/${encodeURIComponent(c.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ selectImportId: importId }) });
    const data = await json<{ case: CaseRecord }>(res);
    if (res.ok && data.case) return { case: data.case, error: '' };
    return { case: null, error: data.error ?? `Could not select revision (HTTP ${res.status}).` };
  } catch (e) {
    return { case: null, error: `Could not reach the server: ${e instanceof Error ? e.message : 'network error'}.` };
  }
}

export interface FileStoreResult {
  stored: boolean;
  storagePath?: string;
  uploadedAt?: string;
  /** Exact reason the original file was not stored. Empty when stored. */
  error: string;
}

/**
 * Store the original file in the private bucket. Session-only cases have no server, so the file is NOT stored and
 * the result says so. This never reports success unless the server confirmed the write.
 */
export async function storeOriginalFile(caseId: string, imp: BoqImport, bytes: Uint8Array): Promise<FileStoreResult> {
  if (caseId.startsWith('session-')) return { stored: false, error: 'This is a temporary case, so the original file was not stored anywhere. Only the parsed rows are held in this browser tab.' };
  try {
    const q = new URLSearchParams({ importId: imp.id, fileName: imp.source.fileName, sha256: imp.source.sha256 });
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    const res = await fetch(`/api/boq-cases/${encodeURIComponent(caseId)}/file?${q.toString()}`, { method: 'POST', headers: { 'Content-Type': imp.source.format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ...(await authHeaders()) }, body });
    const data = await json<{ storagePath: string; uploadedAt: string }>(res);
    if (res.ok && data.storagePath) return { stored: true, storagePath: data.storagePath, uploadedAt: data.uploadedAt, error: '' };
    return { stored: false, error: data.error ?? `The original file was not stored (HTTP ${res.status}).` };
  } catch (e) {
    return { stored: false, error: `Could not reach the server to store the original file: ${e instanceof Error ? e.message : 'network error'}.` };
  }
}

export async function markStoredOnServer(caseId: string, importId: string, storagePath: string, uploadedAt: string): Promise<string> {
  try {
    const res = await fetch(`/api/boq-cases/${encodeURIComponent(caseId)}/file`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ importId, storagePath, uploadedAt }) });
    if (res.ok) return '';
    const data = await json<Record<string, never>>(res);
    return data.error ?? `HTTP ${res.status}`;
  } catch (e) {
    return e instanceof Error ? e.message : 'network error';
  }
}

/** A short-lived link to the original file for evidence review. Authorised on the server per request. */
export async function getOriginalFileLink(caseId: string, importId: string): Promise<{ url: string; fileName: string; error: string }> {
  try {
    const res = await fetch(`/api/boq-cases/${encodeURIComponent(caseId)}/file?importId=${encodeURIComponent(importId)}`, { cache: 'no-store', headers: await authHeaders() });
    const data = await json<{ url: string; fileName: string }>(res);
    if (res.ok && data.url) return { url: data.url, fileName: data.fileName, error: '' };
    return { url: '', fileName: '', error: data.error ?? `Could not get the file (HTTP ${res.status}).` };
  } catch (e) {
    return { url: '', fileName: '', error: `Could not reach the server: ${e instanceof Error ? e.message : 'network error'}.` };
  }
}

const CALC_PREFIX = 'pvr-real-calcs:';

function calcSessionRead(caseId: string): SavedCalculation[] {
  try { const raw = window.sessionStorage.getItem(CALC_PREFIX + caseId); return raw ? (JSON.parse(raw) as SavedCalculation[]) : []; } catch { return []; }
}
function calcSessionWrite(caseId: string, list: SavedCalculation[]): boolean {
  try { window.sessionStorage.setItem(CALC_PREFIX + caseId, JSON.stringify(list)); return true; } catch { return false; }
}

export async function loadCalculations(caseId: string): Promise<{ calculations: SavedCalculation[]; error: string }> {
  if (caseId.startsWith('session-')) return { calculations: calcSessionRead(caseId), error: '' };
  try {
    const res = await fetch(`/api/boq-cases/${encodeURIComponent(caseId)}/calculations`, { cache: 'no-store', headers: await authHeaders() });
    const data = await json<{ calculations: SavedCalculation[] }>(res);
    if (res.ok) return { calculations: data.calculations ?? [], error: '' };
    return { calculations: [], error: data.error ?? `Could not load saved calculations (HTTP ${res.status}).` };
  } catch (e) {
    return { calculations: [], error: `Could not reach the server: ${e instanceof Error ? e.message : 'network error'}.` };
  }
}

export async function persistCalculation(calc: SavedCalculation, existing: SavedCalculation[]): Promise<{ saved: boolean; mode: PersistenceMode; error: string }> {
  if (calc.caseId.startsWith('session-')) {
    const ok = calcSessionWrite(calc.caseId, [...existing, calc]);
    return ok ? { saved: true, mode: 'session_only', error: '' } : { saved: false, mode: 'session_only', error: 'This browser could not hold the temporary copy. The calculation was not saved.' };
  }
  try {
    const res = await fetch(`/api/boq-cases/${encodeURIComponent(calc.caseId)}/calculations`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ calculation: calc }) });
    if (res.ok) return { saved: true, mode: 'server', error: '' };
    const data = await json<Record<string, never>>(res);
    return { saved: false, mode: 'server', error: data.error ?? `Save failed (HTTP ${res.status}).` };
  } catch (e) {
    return { saved: false, mode: 'server', error: `Could not reach the server: ${e instanceof Error ? e.message : 'network error'}. The calculation was NOT saved.` };
  }
}

export async function reviewCalculation(caseId: string, calcId: string, importId: string, existing: SavedCalculation[]): Promise<string> {
  if (caseId.startsWith('session-')) {
    const next = existing.map((c) => (c.id === calcId ? { ...c, reviewedAgainstImportId: importId } : c));
    return calcSessionWrite(caseId, next) ? '' : 'This browser could not hold the temporary copy.';
  }
  try {
    const res = await fetch(`/api/boq-cases/${encodeURIComponent(caseId)}/calculations`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ calculationId: calcId, importId }) });
    if (res.ok) return '';
    const data = await json<Record<string, never>>(res);
    return data.error ?? `HTTP ${res.status}`;
  } catch (e) {
    return e instanceof Error ? e.message : 'network error';
  }
}

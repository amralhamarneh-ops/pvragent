import { mergeMatchSnapshotAnswers } from './matchSnapshot';
import type { CaseStore } from './store';
import type { BoqImport, CaseRecord, ParsedRow } from './types';
import type { SavedCalculation } from './revisions';
import { verifyBatch, type BatchPayload, type InitPayload, type StageAck } from './importBatches';

/** A BOQ import without its rows. `status` is 'pending' while a staged save is incomplete. */
export interface ImportSummary extends Omit<BoqImport, 'rows'> {
  status: 'pending' | 'complete';
  expectedRows: number;
  expectedBatches: number;
  savedRows: number;
  savedBatches: number;
  savedBatchIds: string[];
}

/** Specific, verified reason a storage request failed. Never claims more than was observed. */
export type StorageFailureCode =
  | 'not_configured' |'table_missing' |'column_missing' |'schema_cache' |'endpoint_not_found' |'bucket_missing' |'permission_denied' |'rejected' |'network' |'service_error';

/** Kept for existing callers: the legacy `kind` values the API routes already forward as `blocker`. */
export type StorageUnavailableKind = 'not_configured' | 'tables_missing' | 'rejected' | 'network';

export interface StorageDiagnostic {
  code: StorageFailureCode;
  operation: string;
  resource: string;
  httpStatus: number | null;
  dbCode: string;
  message: string;
  details: string;
  hint: string;
}

export class StorageUnavailableError extends Error {
  readonly kind: StorageUnavailableKind;
  readonly diagnostic: StorageDiagnostic | null;
  constructor(kind: StorageUnavailableKind, message: string, diagnostic: StorageDiagnostic | null = null) {
    super(message);
    this.kind = kind;
    this.diagnostic = diagnostic;
    this.name = 'StorageUnavailableError';
  }
}

/** Thrown when the caller is not signed in, or is signed in but does not own the case. */
export class AccessDeniedError extends Error {
  readonly status: 401 | 403 | 404;
  readonly diagnostic: StorageDiagnostic | null;
  constructor(status: 401 | 403 | 404, message: string, diagnostic: StorageDiagnostic | null = null) {
    super(message);
    this.status = status;
    this.diagnostic = diagnostic;
    this.name = 'AccessDeniedError';
  }
}

interface PostgrestError { code?: string; message?: string; details?: string; hint?: string }

/** Remove anything that could be a credential or contact detail before it is stored or returned. */
export function sanitise(s: string | undefined | null, max = 240): string {
  if (!s) return '';
  return String(s)
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[token]')
    .replace(/(apikey|authorization|bearer|secret|password)\s*[:=]?\s*\S+/gi, '$1 [redacted]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function parseBody(body: string): PostgrestError {
  try {
    const j = JSON.parse(body) as PostgrestError;
    return j && typeof j === 'object' ? j : {};
  } catch {
    return { message: body };
  }
}

/** The table or relation a PostgREST path targets, for example `pvr_boq_imports?case_id=eq.x` gives `pvr_boq_imports`. */
export function resourceOf(path: string): string {
  return path.split('?')[0].split('/')[0] || path;
}

/**
 * Classify a failed PostgREST response using its structured error code first and the HTTP status second.
 * The affected resource is the one named in the request path, so a single missing table is reported as that table.
 */
export function classifyRestFailure(operation: string, path: string, status: number, rawBody: string): StorageDiagnostic {
  const err = parseBody(rawBody);
  const dbCode = err.code ?? '';
  const message = sanitise(err.message ?? rawBody);
  const diag = (code: StorageFailureCode): StorageDiagnostic => ({
    code, operation, resource: resourceOf(path), httpStatus: status, dbCode, message, details: sanitise(err.details), hint: sanitise(err.hint),
  });
  // PGRST205: PostgREST cannot find the table in its schema cache. 42P01: Postgres says the relation does not exist.
  if (dbCode === 'PGRST205' || dbCode === '42P01') return diag('table_missing');
  // 42703 (Postgres) and PGRST204 (PostgREST) both mean a column the code uses is absent from a table that exists.
  if (dbCode === '42703' || dbCode === 'PGRST204') return diag('column_missing');
  // Schema cache or exposure problems that are not a specific missing table.
  if (/^PGRST1(0\d|1\d)$/.test(dbCode) || /PGRST106|schema must be one of|invalid schema/i.test(`${dbCode} ${message}`)) return diag('schema_cache');
  if (dbCode === '42501' || /row-level security|permission denied/i.test(message) || status === 401 || status === 403) return diag('permission_denied');
  if (status >= 500 || /^08|^53|^57/.test(dbCode)) return diag('service_error');
  // A bare 404 with no structured database code is the endpoint or project URL, not proof of a missing table.
  if (status === 404 && !dbCode) return diag('endpoint_not_found');
  return diag('rejected');
}

/** Plain-language explanation and next action for a diagnostic. Names only what was actually observed. */
export function explainDiagnostic(d: StorageDiagnostic): { message: string; nextAction: string } {
  const r = d.resource || 'a required table';
  switch (d.code) {
    case 'table_missing':
      if (d.resource === 'pvr_boq_import_batches') return { message: `The database table "${r}" does not exist or is not visible to the API. It is required for staged BOQ imports.`, nextAction: 'Apply the migration supabase/migrations/20261118090000_pvr_boq_staged_import.sql, then retry. It is additive and keeps existing cases, imports and files.' };
      return { message: `The database table "${r}" does not exist or is not visible to the API. Other tables were not reported missing by this request.`, nextAction: `Apply the migration supabase/migrations/20261109090000_pvr_boq_tables_repair.sql, then retry. It creates only missing tables and keeps existing cases and documents.` };
    case 'column_missing':
      return { message: `The table "${r}" exists but a column the app needs is missing (${d.message || 'schema is older than the code'}).`, nextAction: 'Apply the newest additive migration that adds the column (for BOQ staged imports: supabase/migrations/20261118090000_pvr_boq_staged_import.sql). Do not recreate the table.' };
    case 'schema_cache':
      return { message: `The API could not use the schema for "${r}" (${d.message || 'schema cache or exposure problem'}).`, nextAction: 'Reload the API schema cache (run NOTIFY pgrst, \'reload schema\') and confirm the public schema is exposed in the project API settings.' };
    case 'endpoint_not_found':
      return { message: `The database service answered 404 for "${r}" without a database error code. This usually means the project URL or API path is wrong, not that a table is missing.`, nextAction: 'Check that NEXT_PUBLIC_SUPABASE_URL points at the intended project for this deployment (preview and published apps can differ).' };
    case 'bucket_missing':
      return { message: 'The private storage bucket "pvr-boq-files" is not available.', nextAction: 'Create the bucket from the earlier BOQ migration. Case records are not affected.' };
    case 'permission_denied':
      return { message: `The database refused access to "${r}" (${d.dbCode || `HTTP ${d.httpStatus}`}).`, nextAction: 'This is a permission problem, not missing data. Check the row-level security policies and the signed-in or guest identity.' };
    case 'service_error':
      return { message: `The database service failed while reading "${r}" (HTTP ${d.httpStatus}).`, nextAction: 'Retry shortly. If it persists, check the Supabase project status.' };
    case 'network':
      return { message: 'The database could not be reached from the server.', nextAction: 'Retry. If it persists, check the Supabase project URL and status.' };
    case 'not_configured':
      return { message: 'Server storage is not configured: the Supabase URL or key is not set for this deployment.', nextAction: 'Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY for this environment.' };
    default:
      return { message: `The database rejected the request on "${r}" (${d.dbCode || `HTTP ${d.httpStatus}`}${d.message ? `: ${d.message}` : ''}).`, nextAction: 'Retry. If it persists, share the diagnostic code with support.' };
  }
}

/** Legacy `blocker` value the existing routes and client still understand. */
function legacyKind(code: StorageFailureCode): StorageUnavailableKind {
  if (code === 'not_configured') return 'not_configured';
  if (code === 'network') return 'network';
  if (code === 'rejected') return 'rejected';
  return 'tables_missing';
}

export function toStorageError(d: StorageDiagnostic): StorageUnavailableError {
  const ex = explainDiagnostic(d);
  return new StorageUnavailableError(legacyKind(d.code), ex.message, d);
}

export interface VerifiedUser { id: string; email: string; token: string }

/**
 * Build the JSON body and HTTP status an API route returns for a storage error.
 * `blocker` keeps the legacy value; `diagnostic` carries the specific, sanitised cause and the next action.
 */
export function failureResponse(e: unknown): { status: number; body: Record<string, unknown> } {
  if (e instanceof AccessDeniedError) {
    const blocker = e.status === 401 ? 'not_signed_in' : e.status === 404 ? 'not_found' : 'forbidden';
    const d = e.diagnostic;
    return { status: e.status, body: { error: e.message, blocker, ...(d ? { diagnostic: { ...d, nextAction: explainDiagnostic(d).nextAction } } : {}) } };
  }
  if (e instanceof StorageUnavailableError) {
    const d = e.diagnostic;
    return { status: 503, body: { error: e.message, blocker: e.kind, ...(d ? { diagnostic: { ...d, nextAction: explainDiagnostic(d).nextAction } } : {}) } };
  }
  return { status: 500, body: { error: e instanceof Error ? sanitise(e.message, 300) : 'Unexpected error.' } };
}

/** Fixed identity used for every request while sign-in is switched off. Matches the anon-role policies in the migration. */
export const GUEST_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Sign-in is currently not required. When no session is sent, the request acts as the shared guest user
 * through the anon role. If a valid Bearer session is sent it is still honoured.
 */
export async function verifyUser(authHeader: string | null, url: string | undefined, anonKey: string | undefined): Promise<VerifiedUser> {
  if (!url || !anonKey) throw new StorageUnavailableError('not_configured', 'NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is not set on the server.', { code: 'not_configured', operation: 'verifyUser', resource: 'environment', httpStatus: null, dbCode: '', message: 'Supabase URL or key not set.', details: '', hint: '' });
  const m = /^Bearer\s+(.+)$/i.exec(authHeader ?? '');
  const token = m ? m[1].trim() : '';
  if (!token || token === anonKey) return { id: GUEST_USER_ID, email: 'guest@local', token: anonKey };
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/$/, '')}/auth/v1/user`, { headers: { apikey: anonKey, Authorization: `Bearer ${token}` }, cache: 'no-store' });
  } catch {
    return { id: GUEST_USER_ID, email: 'guest@local', token: anonKey };
  }
  if (!res.ok) return { id: GUEST_USER_ID, email: 'guest@local', token: anonKey };
  const u = (await res.json()) as { id?: string; email?: string };
  if (!u.id) return { id: GUEST_USER_ID, email: 'guest@local', token: anonKey };
  return { id: u.id, email: u.email ?? '', token };
}

interface ImportRow { id: string; case_id: string; owner_id: string | null; revision: number; file_name: string; file_sha256: string; size_bytes: number; format: 'xlsx' | 'csv'; currency: string; revision_label: string; mappings: BoqImport['mappings']; confirmed_at: string | null; storage_path?: string | null; uploaded_at?: string | null; file_stored?: boolean | null; import_status?: 'pending' | 'complete' | null; expected_rows?: number | null; expected_batches?: number | null; import_checksum?: string | null; pending_confirmed_at?: string | null }
interface CaseRow { id: string; owner_id: string | null; title: string; mode: 'real' | 'demo'; currency: string; selected_import_id: string | null; created_at: string }
interface RowRow { id: string; import_id: string; row_data: ParsedRow }
interface CalcRow { id: string; case_id: string; owner_id: string | null; import_id: string; record: SavedCalculation; reviewed_against_import_id: string | null; created_at: string }

/**
 * Server-side Supabase REST store that acts AS the signed-in user.
 *
 * Two independent layers enforce access:
 *  1. Database row-level security (the user's JWT is forwarded, never the anon key alone).
 *  2. An explicit ownership check here on every read, create, update and revision selection.
 * No service-role key is used anywhere.
 */
export class SupabaseRestStore implements CaseStore {
  private readonly base: string;
  private readonly anonKey: string;
  private readonly user: VerifiedUser;

  constructor(url: string | undefined, anonKey: string | undefined, user: VerifiedUser) {
    if (!url || !anonKey) throw new StorageUnavailableError('not_configured', 'NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is not set on the server.');
    this.base = `${url.replace(/\/$/, '')}/rest/v1`;
    this.anonKey = anonKey;
    this.user = user;
  }

  private async req<T>(path: string, init: RequestInit & { prefer?: string } = {}): Promise<T> {
    const operation = `${init.method ?? 'GET'} ${resourceOf(path)}`;
    let res: Response;
    try {
      res = await fetch(`${this.base}/${path}`, {
        ...init,
        cache: 'no-store',
        headers: { apikey: this.anonKey, Authorization: `Bearer ${this.user.token}`, 'Content-Type': 'application/json', ...(init.prefer ? { Prefer: init.prefer } : {}), ...(init.headers ?? {}) },
      });
    } catch (e) {
      throw toStorageError({ code: 'network', operation, resource: resourceOf(path), httpStatus: null, dbCode: '', message: sanitise(e instanceof Error ? e.message : 'network error'), details: '', hint: '' });
    }
    if (!res.ok) {
      const body = await res.text();
      const d = classifyRestFailure(operation, path, res.status, body);
      // Server-side record of the exact failed operation. Contains no tokens, keys or row data.
      console.error('[boq-store]', JSON.stringify({ op: d.operation, resource: d.resource, status: d.httpStatus, code: d.code, dbCode: d.dbCode, message: d.message, details: d.details, hint: d.hint }));
      if (d.code === 'permission_denied') throw new AccessDeniedError(403, 'You do not have access to that case.', d);
      if (d.code === 'rejected' && /23514/.test(d.dbCode)) throw new Error('That import cannot be selected: it must be a confirmed import of this case.');
      if (d.code === 'rejected') throw new Error(`Database error on ${d.resource} (${d.dbCode || `HTTP ${d.httpStatus}`}): ${d.message}`);
      throw toStorageError(d);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  private toCase(r: CaseRow): CaseRecord {
    return { id: r.id, title: r.title, mode: r.mode, currency: r.currency, createdAt: r.created_at, selectedImportId: r.selected_import_id, ownerId: r.owner_id ?? undefined };
  }

  /**
   * Layer 2 ownership check. Always filters by owner_id in the query as well as relying on RLS.
   * A case that exists but belongs to someone else is reported as "not found", so ids cannot be probed.
   */
  private async ownedCase(id: string): Promise<CaseRow> {
    const rows = await this.req<CaseRow[]>(`pvr_cases?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(this.user.id)}&select=*`);
    if (!rows.length || rows[0].owner_id !== this.user.id) throw new AccessDeniedError(404, `Case ${id} was not found.`);
    return rows[0];
  }

  async createCase(c: CaseRecord): Promise<CaseRecord> {
    // owner_id is always the verified user. A client-supplied owner is ignored.
    const rows = await this.req<CaseRow[]>('pvr_cases', { method: 'POST', prefer: 'return=representation', body: JSON.stringify({ id: c.id, owner_id: this.user.id, title: c.title, mode: 'real', currency: c.currency, selected_import_id: null, created_at: c.createdAt }) });
    return this.toCase(rows[0]);
  }

  async getCase(id: string): Promise<CaseRecord | null> {
    try {
      return this.toCase(await this.ownedCase(id));
    } catch (e) {
      if (e instanceof AccessDeniedError && e.status === 404) return null;
      throw e;
    }
  }

  private toImport(i: ImportRow, rows: ParsedRow[]): BoqImport {
    return { id: i.id, caseId: i.case_id, revision: i.revision, source: { fileName: i.file_name, sha256: i.file_sha256, sizeBytes: Number(i.size_bytes), format: i.format, currency: i.currency, revisionLabel: i.revision_label, storagePath: i.storage_path ?? undefined, fileStored: !!i.file_stored, uploadedAt: i.uploaded_at ?? undefined }, mappings: i.mappings, rows, confirmedAt: i.import_status === 'pending' ? null : i.confirmed_at };
  }

  /** Every row of one import, paged server-side. Used for complete imports only, so calculations see the whole BOQ. */
  private async allRowsOf(caseId: string, importId: string): Promise<ParsedRow[]> {
    const rows: ParsedRow[] = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await this.req<RowRow[]>(`pvr_boq_rows?import_id=eq.${encodeURIComponent(importId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&select=id,import_id,row_data&order=sheet.asc,row_number.asc,id.asc&limit=1000&offset=${offset}`);
      rows.push(...page.map((p) => p.row_data));
      if (page.length < 1000) break;
    }
    return rows;
  }

  /** COMPLETE imports with all rows. Pending (partial) imports are never returned, so they cannot be selected or used in calculations. */
  async listImports(caseId: string): Promise<BoqImport[]> {
    await this.ownedCase(caseId);
    const imps = await this.req<ImportRow[]>(`pvr_boq_imports?case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&import_status=eq.complete&select=*&order=revision.asc`);
    const out: BoqImport[] = [];
    for (let i of imps) out.push(this.toImport(i, await this.allRowsOf(caseId, i.id)));
    return out;
  }

  /** Small per-import summaries with no rows, including pending imports so an interrupted save can be resumed. */
  async listImportSummaries(caseId: string): Promise<ImportSummary[]> {
    await this.ownedCase(caseId);
    const imps = await this.req<ImportRow[]>(`pvr_boq_imports?case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&select=*&order=revision.asc`);
    const out: ImportSummary[] = [];
    for (let i of imps) {
      const status = i.import_status === 'pending' ? 'pending' : 'complete';
      let savedRows = i.expected_rows ?? 0;
      let savedBatches = i.expected_batches ?? 0;
      let savedBatchIds: string[] = [];
      if (status === 'pending') {
        const b = await this.req<{ batch_id: string; row_count: number }[]>(`pvr_boq_import_batches?import_id=eq.${encodeURIComponent(i.id)}&case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&select=batch_id,row_count&order=batch_index.asc`);
        savedBatchIds = b.map((x) => x.batch_id);
        savedBatches = b.length;
        savedRows = b.reduce((n, x) => n + x.row_count, 0);
      }
      const base = this.toImport(i, []);
      out.push({ id: base.id, caseId: base.caseId, revision: base.revision, source: base.source, mappings: base.mappings, confirmedAt: base.confirmedAt, status, expectedRows: i.expected_rows ?? savedRows, expectedBatches: i.expected_batches ?? savedBatches, savedRows, savedBatches, savedBatchIds });
    }
    return out;
  }

  /** One page of a COMPLETE import's rows. Ordered by sheet then row number so pages are stable. */
  async listImportRows(caseId: string, importId: string, offset: number, limit: number): Promise<{ rows: ParsedRow[]; total: number; offset: number; nextOffset: number | null }> {
    await this.ownedCase(caseId);
    const lim = Math.max(1, Math.min(1000, Math.floor(limit) || 500));
    const off = Math.max(0, Math.floor(offset) || 0);
    const imp = await this.req<ImportRow[]>(`pvr_boq_imports?id=eq.${encodeURIComponent(importId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&select=id,import_status,expected_rows`);
    if (!imp.length) throw new AccessDeniedError(404, 'That import was not found for this case.');
    if (imp[0].import_status === 'pending') throw new Error('That import is still being saved, so its rows are not available yet.');
    const page = await this.req<RowRow[]>(`pvr_boq_rows?import_id=eq.${encodeURIComponent(importId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&select=id,import_id,row_data&order=sheet.asc,row_number.asc,id.asc&limit=${lim}&offset=${off}`);
    const total = imp[0].expected_rows ?? off + page.length;
    return { rows: page.map((p) => p.row_data), total, offset: off, nextOffset: page.length === lim && off + page.length < total ? off + page.length : null };
  }

  // ---- Staged import: initialise, batches, status, finalise ----

  private async findImport(caseId: string, importId: string): Promise<ImportRow | null> {
    const rows = await this.req<ImportRow[]>(`pvr_boq_imports?id=eq.${encodeURIComponent(importId)}&select=*`);
    if (!rows.length) return null;
    // An id that exists under a different case or owner is reported as a plain denial, never as data.
    if (rows[0].case_id !== caseId || rows[0].owner_id !== this.user.id) throw new AccessDeniedError(403, 'That import belongs to a different case.');
    return rows[0];
  }

  private async batchLedger(caseId: string, importId: string): Promise<{ batch_id: string; batch_index: number; row_count: number; checksum: string }[]> {
    return this.req(`pvr_boq_import_batches?import_id=eq.${encodeURIComponent(importId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&select=batch_id,batch_index,row_count,checksum&order=batch_index.asc`);
  }

  private ack(imp: ImportRow, ledger: { batch_id: string; row_count: number }[], status: 'pending' | 'complete', batch?: StageAck['batch']): StageAck {
    return { importId: imp.id, status, expectedRows: imp.expected_rows ?? 0, expectedBatches: imp.expected_batches ?? 0, savedRows: ledger.reduce((n, b) => n + b.row_count, 0), savedBatches: ledger.length, savedBatchIds: ledger.map((b) => b.batch_id), ...(batch ? { batch } : {}) };
  }

  /**
   * Initialise (or re-initialise) a staged import using metadata only. Idempotent: the same import id with the same
   * checksum returns the existing progress. A COMPLETE import is never reset, and no existing rows are deleted.
   */
  async initImport(caseId: string, p: InitPayload): Promise<StageAck> {
    await this.ownedCase(caseId);
    const existing = await this.findImport(caseId, p.importId);
    if (existing) {
      if (existing.import_status !== 'pending') return this.ack({ ...existing, expected_rows: existing.expected_rows ?? p.expectedRows, expected_batches: existing.expected_batches ?? p.expectedBatches }, [], 'complete');
      if (existing.import_checksum !== p.importChecksum || existing.expected_rows !== p.expectedRows || existing.expected_batches !== p.expectedBatches) {
        throw new Error('This import id was already started with different contents. Start a new import instead of resuming it.');
      }
      // Reuse: refresh only the file reference, which may have been stored after the first attempt.
      if (p.meta.fileStored && p.meta.storagePath && !existing.file_stored) {
        await this.req(`pvr_boq_imports?id=eq.${encodeURIComponent(p.importId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ storage_path: p.meta.storagePath, uploaded_at: p.meta.uploadedAt ?? null, file_stored: true }) });
      }
      return this.ack(existing, await this.batchLedger(caseId, p.importId), 'pending');
    }
    // Revision numbers are unique per case. A concurrent import that took this number is reported, not overwritten.
    try {
      await this.req('pvr_boq_imports', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ id: p.importId, case_id: caseId, owner_id: this.user.id, revision: p.revision, file_name: p.meta.fileName, original_file_name: p.meta.fileName, file_sha256: p.meta.sha256, size_bytes: p.meta.sizeBytes, format: p.meta.format, currency: p.meta.currency, revision_label: p.meta.revisionLabel, mappings: p.meta.mappings, confirmed_at: null, pending_confirmed_at: p.meta.confirmedAt, import_status: 'pending', expected_rows: p.expectedRows, expected_batches: p.expectedBatches, import_checksum: p.importChecksum, storage_path: p.meta.storagePath ?? null, uploaded_at: p.meta.uploadedAt ?? null, file_stored: !!p.meta.fileStored }) });
    } catch (error) {
      // Uniqueness conflicts can reveal identifiers used by other accounts. Return only a generic inaccessible result.
      if (error instanceof Error && /\b23505\b/.test(error.message)) throw new AccessDeniedError(404, 'That import could not be initialised for this case.');
      throw error;
    }
    const created = await this.findImport(caseId, p.importId);
    if (!created) throw new Error('The import could not be initialised.');
    return this.ack(created, [], 'pending');
  }

  /**
   * Store one batch. Idempotent: a batch id already in the ledger with the same checksum is acknowledged without
   * writing again. Row ids are deterministic and written with merge-duplicates, so a replay can never duplicate rows.
   */
  async saveImportBatch(caseId: string, b: BatchPayload): Promise<StageAck> {
    await this.ownedCase(caseId);
    const bad = await verifyBatch(b);
    if (bad) throw new Error(bad);
    const imp = await this.findImport(caseId, b.importId);
    if (!imp) throw new AccessDeniedError(404, 'That import has not been initialised for this case.');
    if (imp.import_status !== 'pending') return this.ack(imp, await this.batchLedger(caseId, b.importId), 'complete', { batchId: b.batchId, state: 'already_saved', rowCount: b.rows.length });
    if (b.index >= (imp.expected_batches ?? 0)) throw new Error('That batch is outside the declared import.');
    const ledger = await this.batchLedger(caseId, b.importId);
    const prior = ledger.find((x) => x.batch_index === b.index);
    if (prior) {
      if (prior.checksum !== b.checksum || prior.batch_id !== b.batchId) throw new Error('A different batch was already stored at this position. Start a new import.');
      return this.ack(imp, ledger, 'pending', { batchId: b.batchId, state: 'already_saved', rowCount: prior.row_count });
    }
    const payload = b.rows.map((r) => ({ id: `${b.importId}:${r.id}`, import_id: b.importId, case_id: caseId, owner_id: this.user.id, batch_id: b.batchId, sheet: r.sheet, row_number: r.rowNumber, row_class: r.rowClass, included: r.included, row_data: r }));
    // Rows first, ledger second: a crash between the two leaves rows that the retry rewrites identically.
    await this.req('pvr_boq_rows?on_conflict=id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: JSON.stringify(payload) });
    await this.req('pvr_boq_import_batches?on_conflict=batch_id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: JSON.stringify({ batch_id: b.batchId, import_id: b.importId, case_id: caseId, owner_id: this.user.id, batch_index: b.index, row_count: b.rows.length, checksum: b.checksum }) });
    return this.ack(imp, await this.batchLedger(caseId, b.importId), 'pending', { batchId: b.batchId, state: 'saved', rowCount: b.rows.length });
  }

  /** Small status for resume. No rows. */
  async getImportStatus(caseId: string, importId: string): Promise<StageAck> {
    await this.ownedCase(caseId);
    const imp = await this.findImport(caseId, importId);
    if (!imp) throw new AccessDeniedError(404, 'That import was not found for this case.');
    return this.ack(imp, await this.batchLedger(caseId, importId), imp.import_status === 'pending' ? 'pending' : 'complete');
  }

  /** Verify completeness and publish atomically through one database function. An incomplete import stays pending. */
  async finalizeImport(caseId: string, importId: string, importChecksum: string): Promise<StageAck & { ok: boolean; message?: string }> {
    await this.ownedCase(caseId);
    const imp = await this.findImport(caseId, importId);
    if (!imp) throw new AccessDeniedError(404, 'That import was not found for this case.');
    let res = await this.req<{ ok: boolean; message?: string; code?: string }>('rpc/pvr_finalise_boq_import', { method: 'POST', body: JSON.stringify({ p_case_id: caseId, p_import_id: importId, p_import_checksum: importChecksum }) });
    const after = await this.findImport(caseId, importId);
    const status = after?.import_status === 'pending' ? 'pending' : 'complete';
    return { ...this.ack(after ?? imp, await this.batchLedger(caseId, importId), status), ok: !!res?.ok, ...(res?.ok ? {} : { message: res?.message ?? 'The import is not complete yet.' }) };
  }

  private async allRowIds(caseId: string, importId: string): Promise<string[]> {
    const ids: string[] = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await this.req<{ id: string }[]>(`pvr_boq_rows?import_id=eq.${encodeURIComponent(importId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&select=id&order=id.asc&limit=1000&offset=${offset}`);
      ids.push(...page.map((p) => p.id));
      if (page.length < 1000) break;
    }
    return ids;
  }

  async saveImport(imp: BoqImport): Promise<BoqImport> {
    const c = await this.ownedCase(imp.caseId);
    // Never overwrite a different owner's or a different case's import that happens to share this id.
    const existing = await this.req<{ id: string; case_id: string; import_status?: string | null }[]>(`pvr_boq_imports?id=eq.${encodeURIComponent(imp.id)}&select=id,case_id,import_status`);
    if (existing.length && existing[0].case_id !== imp.caseId) throw new AccessDeniedError(403, 'That import belongs to a different case.');
    if (existing.length && existing[0].import_status === 'pending') throw new Error('That import is being saved in stages. Resume the staged save instead of replacing it.');
    await this.req('pvr_boq_imports?on_conflict=id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: JSON.stringify({ id: imp.id, case_id: imp.caseId, owner_id: this.user.id, revision: imp.revision, file_name: imp.source.fileName, original_file_name: imp.source.fileName, file_sha256: imp.source.sha256, size_bytes: imp.source.sizeBytes, format: imp.source.format, currency: imp.source.currency, revision_label: imp.source.revisionLabel, mappings: imp.mappings, confirmed_at: imp.confirmedAt, import_status: 'complete', storage_path: imp.source.storagePath ?? null, uploaded_at: imp.source.uploadedAt ?? null, file_stored: !!imp.source.fileStored }) });
    // Write the replacement rows first (deterministic ids, merge on conflict), THEN prune rows no longer present.
    // A failure part-way therefore never leaves a working import without its rows.
    const keep = new Set<string>();
    for (let i = 0; i < imp.rows.length; i += 200) {
      const chunk = imp.rows.slice(i, i + 200).map((r) => { const id = `${imp.id}:${r.id}`; keep.add(id); return { id, import_id: imp.id, case_id: imp.caseId, owner_id: this.user.id, sheet: r.sheet, row_number: r.rowNumber, row_class: r.rowClass, included: r.included, row_data: r }; });
      if (chunk.length) await this.req('pvr_boq_rows?on_conflict=id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: JSON.stringify(chunk) });
    }
    const stored = await this.allRowIds(imp.caseId, imp.id);
    const stale = stored.filter((id) => !keep.has(id));
    for (let i = 0; i < stale.length; i += 100) {
      const list = stale.slice(i, i + 100).map((x) => `"${x.replace(/"/g, '')}"`).join(',');
      await this.req(`pvr_boq_rows?id=in.(${encodeURIComponent(list)})&import_id=eq.${encodeURIComponent(imp.id)}&case_id=eq.${encodeURIComponent(imp.caseId)}`, { method: 'DELETE', prefer: 'return=minimal' });
    }
    // The first confirmed import is selected automatically. Later imports never switch the selection silently.
    if (imp.confirmedAt && !c.selected_import_id) {
      await this.req(`pvr_cases?id=eq.${encodeURIComponent(imp.caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ selected_import_id: imp.id }) });
    }
    return imp;
  }

  async selectImport(caseId: string, importId: string): Promise<CaseRecord> {
    await this.ownedCase(caseId);
    const imps = await this.req<ImportRow[]>(`pvr_boq_imports?id=eq.${encodeURIComponent(importId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&select=id,confirmed_at,import_status`);
    if (!imps.length) throw new Error('That import does not belong to this case.');
    if (imps[0].import_status === 'pending') throw new Error('That import is still being saved and cannot be selected until it is complete.');
    if (!imps[0].confirmed_at) throw new Error('Only a confirmed import can be selected.');
    const rows = await this.req<CaseRow[]>(`pvr_cases?id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}`, { method: 'PATCH', prefer: 'return=representation', body: JSON.stringify({ selected_import_id: importId }) });
    if (!rows.length) throw new AccessDeniedError(404, `Case ${caseId} was not found.`);
    return this.toCase(rows[0]);
  }

  // ---- Original file storage (private bucket, owner folder) ----

  /** Object path convention: <owner uid>/<case id>/<import id>-<safe file name>. */
  storagePathFor(caseId: string, importId: string, fileName: string): string {
    const safe = fileName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'boq';
    return `${this.user.id}/${caseId}/${importId}-${safe}`;
  }

  private async storageFetch(path: string, init: RequestInit): Promise<Response> {
    const root = this.base.replace(/\/rest\/v1$/, '');
    try {
      return await fetch(`${root}/storage/v1/${path}`, { ...init, cache: 'no-store', headers: { apikey: this.anonKey, Authorization: `Bearer ${this.user.token}`, ...(init.headers ?? {}) } });
    } catch (e) {
      throw new StorageUnavailableError('network', `Could not reach Supabase Storage: ${e instanceof Error ? e.message : 'network error'}.`);
    }
  }

  /**
   * Reuse the original file already stored for this import, after verifying case, ownership and hash.
   * Returns null when there is nothing stored yet. Never creates a second object.
   */
  async existingOriginal(caseId: string, importId: string, sha256: string): Promise<{ storagePath: string; uploadedAt: string } | null> {
    await this.ownedCase(caseId);
    const imps = await this.req<ImportRow[]>(`pvr_boq_imports?id=eq.${encodeURIComponent(importId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&select=id,file_sha256,file_stored,storage_path,uploaded_at`);
    const imp = imps[0];
    if (!imp || !imp.file_stored || !imp.storage_path) return null;
    if (imp.file_sha256 !== sha256) throw new Error('A different file is already stored for this import id.');
    if (!imp.storage_path.startsWith(`${this.user.id}/${caseId}/`)) throw new AccessDeniedError(403, 'You do not have access to that file.');
    return { storagePath: imp.storage_path, uploadedAt: imp.uploaded_at ?? new Date().toISOString() };
  }

  /** Upload the original bytes. The case must be owned by the caller; the path embeds the caller's uid so bucket policy applies. */
  async uploadOriginal(caseId: string, importId: string, fileName: string, bytes: Uint8Array, contentType: string): Promise<string> {
    await this.ownedCase(caseId);
    const path = this.storagePathFor(caseId, importId, fileName);
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    let res = await this.storageFetch(`object/pvr-boq-files/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'POST', headers: { 'Content-Type': contentType || 'application/octet-stream', 'x-upsert': 'false' }, body });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 404 || /Bucket not found/i.test(text)) throw toStorageError({ code: 'bucket_missing', operation: 'POST storage/pvr-boq-files', resource: 'pvr-boq-files', httpStatus: res.status, dbCode: '', message: sanitise(text), details: '', hint: '' });
      if (res.status === 401 || res.status === 403 || /row-level security|Unauthorized/i.test(text)) throw new AccessDeniedError(403, 'You are not permitted to store files for that case.');
      if (res.status === 409 || /Duplicate|already exists/i.test(text)) throw new Error('A file for this import is already stored.');
      throw new Error(`Storage error ${res.status}: ${text.slice(0, 200)}`);
    }
    return path;
  }

  /** Short-lived signed URL for evidence review. Only for an import of a case the caller owns. */
  async signedOriginalUrl(caseId: string, importId: string, expiresInSeconds = 120): Promise<{ url: string; fileName: string }> {
    await this.ownedCase(caseId);
    const imps = await this.req<ImportRow[]>(`pvr_boq_imports?id=eq.${encodeURIComponent(importId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&select=id,storage_path,file_stored,file_name`);
    const imp = imps[0];
    if (!imp) throw new AccessDeniedError(404, 'That import was not found for this case.');
    if (!imp.file_stored || !imp.storage_path) throw new Error('The original file was not stored for this import.');
    if (!imp.storage_path.startsWith(`${this.user.id}/`)) throw new AccessDeniedError(403, 'You do not have access to that file.');
    let res = await this.storageFetch(`object/sign/pvr-boq-files/${imp.storage_path.split('/').map(encodeURIComponent).join('/')}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: expiresInSeconds }) });
    if (!res.ok) throw new Error(`Could not create a retrieval link (HTTP ${res.status}).`);
    const j = (await res.json()) as { signedURL?: string; signedUrl?: string };
    const rel = j.signedURL ?? j.signedUrl;
    if (!rel) throw new Error('Storage did not return a retrieval link.');
    const root = this.base.replace(/\/rest\/v1$/, '');
    return { url: rel.startsWith('http') ? rel : `${root}/storage/v1${rel.startsWith('/') ? '' : '/'}${rel}`, fileName: imp.file_name };
  }

  /** Record that the original file is stored. Used after a successful upload when the import row already exists. */
  async markFileStored(caseId: string, importId: string, path: string, uploadedAt: string): Promise<void> {
    await this.ownedCase(caseId);
    await this.req(`pvr_boq_imports?id=eq.${encodeURIComponent(importId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ storage_path: path, uploaded_at: uploadedAt, file_stored: true }) });
  }

  // ---- Saved calculations (immutable evidence) ----

  async listCalculations(caseId: string): Promise<SavedCalculation[]> {
    await this.ownedCase(caseId);
    const rows = await this.req<CalcRow[]>(`pvr_calculations?case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&select=*&order=created_at.asc`);
    return rows.map((r) => ({ ...r.record, reviewedAgainstImportId: r.reviewed_against_import_id ?? null }));
  }

  async saveCalculation(calc: SavedCalculation): Promise<SavedCalculation> {
    await this.ownedCase(calc.caseId);
    const imp = await this.req<{ id: string }[]>(`pvr_boq_imports?id=eq.${encodeURIComponent(calc.importId)}&case_id=eq.${encodeURIComponent(calc.caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&select=id`);
    if (!imp.length) throw new AccessDeniedError(404, 'The import this calculation uses was not found for this case.');
    await this.req('pvr_calculations', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ id: calc.id, case_id: calc.caseId, owner_id: this.user.id, import_id: calc.importId, import_revision: calc.importRevision, item_id: calc.itemId, signed_amount: calc.signedAmount, reviewed_against_import_id: calc.reviewedAgainstImportId, record: calc, created_at: calc.createdAt }) });
    return calc;
  }

  /** A reviewer confirms the remapped item for the selected import. The original numbers are untouched. */
  async markCalculationReviewed(caseId: string, calcId: string, importId: string): Promise<void> {
    await this.ownedCase(caseId);
    const imp = await this.req<{ id: string; confirmed_at: string | null }[]>(`pvr_boq_imports?id=eq.${encodeURIComponent(importId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&select=id,confirmed_at`);
    if (!imp.length || !imp[0].confirmed_at) throw new Error('Only a confirmed import of this case can be reviewed against.');
    await this.req(`pvr_calculations?id=eq.${encodeURIComponent(calcId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ reviewed_against_import_id: importId }) });
  }

  // ---- Shared document registry (authorised storage of ALL accepted evidence files) ----

  async listDocuments(caseId: string): Promise<CaseDocumentRecord[]> {
    await this.ownedCase(caseId);
    const rows = await this.req<DocRow[]>(`pvr_case_documents?case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&removed_at=is.null&select=*&order=uploaded_at.asc`);
    return rows.map((r) => ({ id: r.id, path: r.path, name: r.file_name, role: r.role, sha256: r.sha256, size: Number(r.size_bytes), version: r.version, storagePath: r.storage_path ?? undefined, stored: !!r.stored, state: r.state, stateDetail: r.state_detail, uploadedAt: r.uploaded_at, subrole: r.subrole ?? '', metadata: r.metadata ?? {}, roleManual: !!r.role_manual }));
  }

  /**
   * Unlink documents from this PVR. The row is kept (soft removal) with removed_at set, and the stored original is NOT
   * deleted, because historical assessment versions may still reference it. Returns the ids actually unlinked.
   */
  async unlinkDocuments(caseId: string, docIds: string[], replacedBy?: string): Promise<string[]> {
    await this.ownedCase(caseId);
    if (!docIds.length) return [];
    const list = docIds.map((i) => `"${i.replace(/"/g, '')}"`).join(',');
    const patch: Record<string, unknown> = { removed_at: new Date().toISOString(), state_detail: 'Removed from this PVR.' };
    if (replacedBy) patch.replaced_by = replacedBy;
    const rows = await this.req<{ id: string }[]>(`pvr_case_documents?id=in.(${encodeURIComponent(list)})&case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&removed_at=is.null`, { method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(patch) });
    return rows.map((r) => r.id);
  }

  /** Change role / sub-role / metadata. The previous values are appended to role_history; a manual correction is flagged so automatic classification cannot overwrite it. */
  async reclassifyDocument(caseId: string, docId: string, next: { role: string; subrole?: string; metadata?: Record<string, string> }): Promise<void> {
    await this.ownedCase(caseId);
    const rows = await this.req<DocRow[]>(`pvr_case_documents?id=eq.${encodeURIComponent(docId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&removed_at=is.null&select=*`);
    const d = rows[0];
    if (!d) throw new AccessDeniedError(404, 'That document was not found in this PVR.');
    const history = Array.isArray(d.role_history) ? d.role_history : [];
    history.push({ at: new Date().toISOString(), fromRole: d.role, fromSubrole: d.subrole ?? '', fromMetadata: d.metadata ?? {}, toRole: next.role, toSubrole: next.subrole ?? '', by: 'user' });
    await this.req(`pvr_case_documents?id=eq.${encodeURIComponent(docId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ role: next.role, subrole: next.subrole ?? '', metadata: next.metadata ?? d.metadata ?? {}, role_manual: true, role_history: history, state: 'uploaded', state_detail: 'Category changed by you. Not yet parsed under the new category.' }) });
  }

  /** Mark the case's current analysis evidence stale. Historical versions are untouched. */
  async markEvidenceStale(caseId: string, reason: string): Promise<void> {
    await this.ownedCase(caseId);
    await this.req(`pvr_case_evidence?case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ stale: true, stale_reason: reason, stale_at: new Date().toISOString() }) });
  }

  /** Short-lived signed URL for a stored document (view/download). */
  async signedDocumentUrl(caseId: string, docId: string, expiresInSeconds = 120): Promise<{ url: string; fileName: string }> {
    await this.ownedCase(caseId);
    const rows = await this.req<DocRow[]>(`pvr_case_documents?id=eq.${encodeURIComponent(docId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&select=*`);
    const d = rows[0];
    if (!d) throw new AccessDeniedError(404, 'That document was not found for this case.');
    if (!d.stored || !d.storage_path) throw new Error('The file contents were not stored for this document.');
    if (!d.storage_path.startsWith(`${this.user.id}/`)) throw new AccessDeniedError(403, 'You do not have access to that file.');
    let res = await this.storageFetch(`object/sign/pvr-boq-files/${d.storage_path.split('/').map(encodeURIComponent).join('/')}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: expiresInSeconds }) });
    if (!res.ok) throw new Error(`Could not create a retrieval link (HTTP ${res.status}).`);
    const j = (await res.json()) as { signedURL?: string; signedUrl?: string };
    const rel = j.signedURL ?? j.signedUrl;
    if (!rel) throw new Error('Storage did not return a retrieval link.');
    const root = this.base.replace(/\/rest\/v1$/, '');
    return { url: rel.startsWith('http') ? rel : `${root}/storage/v1${rel.startsWith('/') ? '' : '/'}${rel}`, fileName: d.file_name };
  }

  /** Store the bytes in the private bucket first, then record the document. The record says stored only if the bytes were written. */
  async storeDocument(caseId: string, meta: { id: string; path: string; name: string; role: string; sha256: string; version: number; subrole?: string; manual?: boolean; metadata?: Record<string, string> }, bytes: Uint8Array, contentType: string): Promise<CaseDocumentRecord> {
    await this.ownedCase(caseId);
    const safe = meta.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'file';
    const storagePath = `${this.user.id}/${caseId}/docs/${meta.id}-${safe}`;
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    let res = await this.storageFetch(`object/pvr-boq-files/${storagePath.split('/').map(encodeURIComponent).join('/')}`, { method: 'POST', headers: { 'Content-Type': contentType || 'application/octet-stream', 'x-upsert': 'true' }, body });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 404 || /Bucket not found/i.test(text)) throw toStorageError({ code: 'bucket_missing', operation: 'POST storage/pvr-boq-files', resource: 'pvr-boq-files', httpStatus: res.status, dbCode: '', message: sanitise(text), details: '', hint: '' });
      if (res.status === 401 || res.status === 403 || /row-level security|Unauthorized/i.test(text)) throw new AccessDeniedError(403, 'You are not permitted to store files for that case.');
      throw new Error(`Storage error ${res.status}: ${text.slice(0, 200)}`);
    }
    const uploadedAt = new Date().toISOString();
    await this.req('pvr_case_documents?on_conflict=id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: JSON.stringify({ id: meta.id, case_id: caseId, owner_id: this.user.id, file_name: meta.name, path: meta.path, role: meta.role, sha256: meta.sha256, size_bytes: bytes.byteLength, version: meta.version, storage_path: storagePath, stored: true, state: 'stored', state_detail: 'Stored privately on the server.', uploaded_at: uploadedAt, removed_at: null, subrole: meta.subrole ?? '', metadata: meta.metadata ?? {}, ...(meta.manual ? { role_manual: true } : {}) }) });
    return { id: meta.id, path: meta.path, name: meta.name, role: meta.role, sha256: meta.sha256, size: bytes.byteLength, version: meta.version, storagePath, stored: true, state: 'stored', stateDetail: 'Stored privately on the server.', uploadedAt };
  }

  async setDocumentRole(caseId: string, docId: string, role: string): Promise<void> {
    await this.ownedCase(caseId);
    await this.req(`pvr_case_documents?id=eq.${encodeURIComponent(docId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ role }) });
  }

  async setDocumentState(caseId: string, docId: string, state: string, detail: string): Promise<void> {
    await this.ownedCase(caseId);
    await this.req(`pvr_case_documents?id=eq.${encodeURIComponent(docId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ state, state_detail: detail }) });
  }

  /** Authorised retrieval of a stored document's bytes (the caller must own the case and the path must be in their folder). */
  async readDocument(caseId: string, docId: string): Promise<{ bytes: Uint8Array; name: string; sha256: string }> {
    await this.ownedCase(caseId);
    const rows = await this.req<DocRow[]>(`pvr_case_documents?id=eq.${encodeURIComponent(docId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&select=*`);
    const d = rows[0];
    if (!d) throw new AccessDeniedError(404, 'That document was not found for this case.');
    if (!d.stored || !d.storage_path) throw new Error('The file contents were not stored for this document. Reconnect the file.');
    if (!d.storage_path.startsWith(`${this.user.id}/`)) throw new AccessDeniedError(403, 'You do not have access to that file.');
    let res = await this.storageFetch(`object/authenticated/pvr-boq-files/${d.storage_path.split('/').map(encodeURIComponent).join('/')}`, { method: 'GET' });
    if (!res.ok) throw new Error(`Could not read the stored file (HTTP ${res.status}).`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), name: d.file_name, sha256: d.sha256 };
  }

  // ---- Persisted case evidence (original narrative, structured handoff, applied answers) ----

  async getEvidence(caseId: string): Promise<CaseEvidenceRecord | null> {
    await this.ownedCase(caseId);
    const rows = await this.req<EvidenceRow[]>(`pvr_case_evidence?case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&select=*`);
    const r = rows[0];
    return r ? { narrative: r.narrative, handoff: r.handoff, answers: r.answers ?? {}, updatedAt: r.updated_at } : null;
  }

  async saveEvidence(caseId: string, e: { narrative?: string; handoff?: unknown; answers?: Record<string, string>; matchSnapshot?: string }): Promise<CaseEvidenceRecord> {
    await this.ownedCase(caseId);
    const filter = `case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}`;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const existing = await this.getEvidence(caseId);
      const answers = mergeMatchSnapshotAnswers(existing?.answers ?? {}, e.answers, e.matchSnapshot);
      const merged = { narrative: e.narrative ?? existing?.narrative ?? '', handoff: e.handoff !== undefined ? e.handoff : existing?.handoff ?? null, answers };
      // Compare-and-set so a saved preview and a concurrent case edit do not erase each other.
      const updatedAt = new Date(Math.max(Date.now(), existing ? Date.parse(existing.updatedAt) + 1 : 0)).toISOString();
      const data = { narrative: merged.narrative, handoff: merged.handoff, answers: merged.answers, updated_at: updatedAt };
      const result = existing
        ? await this.req<EvidenceRow[]>(`pvr_case_evidence?${filter}&updated_at=eq.${encodeURIComponent(existing.updatedAt)}`, { method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(data) })
        : await this.req<EvidenceRow[]>('pvr_case_evidence?on_conflict=case_id', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=representation', body: JSON.stringify({ ...data, case_id: caseId, owner_id: this.user.id }) });
      if (Array.isArray(result) && result.length === 1) return { ...merged, updatedAt };
    }
    throw new Error('The case evidence changed during the save. Reload the case and retry.');
  }

  // ---- Persisted valuation state (manual rates, exclusions, deferrals, items, groups, fingerprint) ----

  async getValuation(caseId: string): Promise<CaseValuationRecord | null> {
    await this.ownedCase(caseId);
    const rows = await this.req<ValuationRow[]>(`pvr_case_valuation?case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&select=*`);
    const r = rows[0];
    return r ? { decisions: r.decisions ?? {}, items: r.items ?? [], groups: r.groups ?? [], replacements: r.replacements ?? [], fingerprint: r.fingerprint ?? null, stale: !!r.stale, staleReasons: r.stale_reasons ?? [], version: r.version ?? 1, updatedAt: r.updated_at } : null;
  }

  /**
   * Save valuation state. `expectedVersion` makes concurrent saves safe: a save made against an older version is
   * rejected instead of overwriting newer decisions.
   */
  async saveValuation(caseId: string, v: Partial<Omit<CaseValuationRecord, 'updatedAt' | 'version'>>, expectedVersion?: number): Promise<CaseValuationRecord> {
    await this.ownedCase(caseId);
    const existing = await this.getValuation(caseId);
    if (existing && expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new Error('The valuation was changed elsewhere since you loaded it. Reload to see the latest decisions before saving.');
    }
    const next: CaseValuationRecord = {
      decisions: v.decisions ?? existing?.decisions ?? {},
      items: v.items ?? existing?.items ?? [],
      groups: v.groups ?? existing?.groups ?? [],
      replacements: v.replacements ?? existing?.replacements ?? [],
      fingerprint: v.fingerprint !== undefined ? v.fingerprint : existing?.fingerprint ?? null,
      stale: v.stale ?? false,
      staleReasons: v.staleReasons ?? [],
      version: (existing?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.req('pvr_case_valuation?on_conflict=case_id', {
      method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
      body: JSON.stringify({ case_id: caseId, owner_id: this.user.id, decisions: next.decisions, items: next.items, groups: next.groups, replacements: next.replacements, fingerprint: next.fingerprint, stale: next.stale, stale_reasons: next.staleReasons, version: next.version, updated_at: next.updatedAt }),
    });
    return next;
  }

  /** Mark saved valuation stale because an input changed. Decisions are kept as history; nothing is deleted. */
  async markValuationStale(caseId: string, reasons: string[]): Promise<void> {
    await this.ownedCase(caseId);
    const existing = await this.getValuation(caseId);
    if (!existing) return;
    await this.req(`pvr_case_valuation?case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ stale: true, stale_reasons: reasons, updated_at: new Date().toISOString() }) });
  }
}

export interface CaseDocumentRecord {
  id: string; path: string; name: string; role: string; sha256: string; size: number; version: number;
  storagePath?: string; stored: boolean; state: string; stateDetail: string; uploadedAt: string;
  subrole?: string; metadata?: Record<string, string>; roleManual?: boolean;
}

export interface CaseEvidenceRecord { narrative: string; handoff: unknown; answers: Record<string, string>; updatedAt: string }

/** Case-scoped valuation state: decisions, assessment items, aggregation groups, replacement methods and the source fingerprint. */
export interface CaseValuationRecord {
  decisions: Record<string, unknown>;
  items: unknown[];
  groups: unknown[];
  replacements: unknown[];
  fingerprint: unknown;
  stale: boolean;
  staleReasons: string[];
  version: number;
  updatedAt: string;
}

interface ValuationRow { case_id: string; decisions: Record<string, unknown> | null; items: unknown[] | null; groups: unknown[] | null; replacements: unknown[] | null; fingerprint: unknown; stale: boolean | null; stale_reasons: string[] | null; version: number | null; updated_at: string }

interface DocRow { id: string; case_id: string; owner_id: string | null; file_name: string; path: string; role: string; sha256: string; size_bytes: number; version: number; storage_path: string | null; stored: boolean | null; state: string; state_detail: string; uploaded_at: string; removed_at?: string | null; role_manual?: boolean | null; role_history?: unknown[] | null; subrole?: string | null; metadata?: Record<string, string> | null }
interface EvidenceRow { case_id: string; narrative: string; handoff: unknown; answers: Record<string, string> | null; updated_at: string }

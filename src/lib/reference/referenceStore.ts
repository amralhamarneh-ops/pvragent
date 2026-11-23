import { AccessDeniedError, StorageUnavailableError, classifyRestFailure, sanitise, toStorageError, type VerifiedUser } from '@/lib/boq/supabaseStore';
import { missingEvidence } from './lifecycle';
import type { EvaluationRun, LearningRecord, ReferenceCase, ReferenceSource, ReviewEntry, SourceRole, ReferenceStatus, ReferencePartition } from './types';

interface CaseRow {
  id: string; owner_id: string; case_group: string; version: number; title: string; status: ReferenceStatus; partition: ReferencePartition;
  record: LearningRecord; missing_evidence: string[]; review_history: ReviewEntry[]; replaced_by: string | null; used_in_fine_tuning: boolean; created_at: string; updated_at: string;
}
interface SourceRow {
  id: string; reference_id: string; role: SourceRole; file_name: string; sha256: string; size_bytes: number; storage_path: string | null; stored: boolean;
  read_status: ReferenceSource['readStatus']; read_detail: string; text_excerpt: string; uploaded_at: string;
}

/**
 * Reference library store. Acts AS the verified user (their JWT is forwarded, no service key) and always filters by
 * owner_id as well as relying on row-level security. Another user's case is reported as not found.
 */
export class ReferenceStore {
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
    const resource = path.split('?')[0];
    let res: Response;
    try {
      res = await fetch(`${this.base}/${path}`, { ...init, cache: 'no-store', headers: { apikey: this.anonKey, Authorization: `Bearer ${this.user.token}`, 'Content-Type': 'application/json', ...(init.prefer ? { Prefer: init.prefer } : {}), ...(init.headers ?? {}) } });
    } catch (e) {
      throw toStorageError({ code: 'network', operation: `${init.method ?? 'GET'} ${resource}`, resource, httpStatus: null, dbCode: '', message: sanitise(e instanceof Error ? e.message : 'network error'), details: '', hint: '' });
    }
    if (!res.ok) {
      const d = classifyRestFailure(`${init.method ?? 'GET'} ${resource}`, path, res.status, await res.text());
      if (d.code === 'permission_denied') throw new AccessDeniedError(403, 'You do not have access to that reference case.', d);
      if (d.code === 'table_missing') throw new StorageUnavailableError('tables_missing', `The reference library tables are not available. Apply supabase/migrations/20261201090000_pvr_reference_cases.sql, then retry.`, d);
      if (d.code === 'rejected') throw new Error(`Database error on ${d.resource}: ${d.message}`);
      throw toStorageError(d);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  private owner(): string { return `owner_id=eq.${encodeURIComponent(this.user.id)}`; }

  private toSource(r: SourceRow): ReferenceSource {
    return { id: r.id, role: r.role, fileName: r.file_name, sha256: r.sha256, sizeBytes: Number(r.size_bytes), stored: r.stored, storagePath: r.storage_path, readStatus: r.read_status, readDetail: r.read_detail, textExcerpt: r.text_excerpt, uploadedAt: r.uploaded_at };
  }

  private toCase(r: CaseRow, sources: SourceRow[]): ReferenceCase {
    const mine = sources.filter((s) => s.reference_id === r.id).map((s) => this.toSource(s));
    return { id: r.id, caseGroup: r.case_group, version: r.version, title: r.title, status: r.status, partition: r.partition, record: r.record, sources: mine, missingEvidence: missingEvidence(mine), reviewHistory: r.review_history ?? [], replacedBy: r.replaced_by, usedInFineTuning: false, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  async list(): Promise<ReferenceCase[]> {
    const cases = await this.req<CaseRow[]>(`pvr_reference_cases?${this.owner()}&select=*&order=created_at.desc`);
    if (!cases.length) return [];
    const sources = await this.req<SourceRow[]>(`pvr_reference_sources?${this.owner()}&select=*`);
    return cases.map((c) => this.toCase(c, sources));
  }

  async get(id: string): Promise<ReferenceCase> {
    const rows = await this.req<CaseRow[]>(`pvr_reference_cases?id=eq.${encodeURIComponent(id)}&${this.owner()}&select=*`);
    if (!rows.length || rows[0].owner_id !== this.user.id) throw new AccessDeniedError(404, `Reference case ${id} was not found.`);
    const sources = await this.req<SourceRow[]>(`pvr_reference_sources?reference_id=eq.${encodeURIComponent(id)}&${this.owner()}&select=*`);
    return this.toCase(rows[0], sources);
  }

  /** Create or fully overwrite a case row. owner_id is always the verified user, never client-supplied. */
  async save(c: ReferenceCase): Promise<ReferenceCase> {
    const body = { id: c.id, owner_id: this.user.id, case_group: c.caseGroup, version: c.version, title: c.title, status: c.status, partition: c.partition, record: c.record, missing_evidence: c.missingEvidence, review_history: c.reviewHistory, replaced_by: c.replacedBy, used_in_fine_tuning: false };
    await this.req<CaseRow[]>('pvr_reference_cases?on_conflict=id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=representation', body: JSON.stringify(body) });
    return this.get(c.id);
  }

  /** Register a source. Identical content (same hash) in the same case is reused, never duplicated. */
  async addSource(referenceId: string, s: ReferenceSource): Promise<{ source: ReferenceSource; reused: boolean }> {
    await this.get(referenceId);
    const existing = await this.req<SourceRow[]>(`pvr_reference_sources?reference_id=eq.${encodeURIComponent(referenceId)}&sha256=eq.${s.sha256}&${this.owner()}&select=*`);
    if (existing.length) return { source: this.toSource(existing[0]), reused: true };
    const row = { id: s.id, reference_id: referenceId, owner_id: this.user.id, role: s.role, file_name: s.fileName, sha256: s.sha256, size_bytes: s.sizeBytes, storage_path: s.storagePath, stored: s.stored, read_status: s.readStatus, read_detail: s.readDetail, text_excerpt: s.textExcerpt.slice(0, 4000) };
    const out = await this.req<SourceRow[]>('pvr_reference_sources', { method: 'POST', prefer: 'return=representation', body: JSON.stringify(row) });
    return { source: this.toSource(out[0]), reused: false };
  }

  // ---- Original source files: private bucket, <uid>/reference/<case id>/... ----

  storagePathFor(referenceId: string, sourceId: string, fileName: string): string {
    const safe = fileName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'file';
    return `${this.user.id}/reference/${referenceId}/${sourceId}-${safe}`;
  }

  private async storageFetch(path: string, init: RequestInit): Promise<Response> {
    const root = this.base.replace(/\/rest\/v1$/, '');
    try { return await fetch(`${root}/storage/v1/${path}`, { ...init, cache: 'no-store', headers: { apikey: this.anonKey, Authorization: `Bearer ${this.user.token}`, ...(init.headers ?? {}) } }); }
    catch (e) { throw new StorageUnavailableError('network', `Could not reach Supabase Storage: ${e instanceof Error ? e.message : 'network error'}.`); }
  }

  async uploadSourceFile(referenceId: string, sourceId: string, fileName: string, bytes: Uint8Array, contentType: string): Promise<string> {
    await this.get(referenceId);
    const path = this.storagePathFor(referenceId, sourceId, fileName);
    const body = new Uint8Array(bytes.byteLength); body.set(bytes);
    let res = await this.storageFetch(`object/pvr-boq-files/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'POST', headers: { 'Content-Type': contentType || 'application/octet-stream', 'x-upsert': 'false' }, body });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 409 || /Duplicate|already exists/i.test(text)) return path;
      if (res.status === 401 || res.status === 403) throw new AccessDeniedError(403, 'You are not permitted to store files for that reference case.');
      throw new Error(`Storage error ${res.status}: ${sanitise(text, 200)}`);
    }
    return path;
  }

  async markSourceStored(sourceId: string, referenceId: string, storagePath: string): Promise<void> {
    await this.req(`pvr_reference_sources?id=eq.${encodeURIComponent(sourceId)}&reference_id=eq.${encodeURIComponent(referenceId)}&${this.owner()}`, { method: 'PATCH', body: JSON.stringify({ stored: true, storage_path: storagePath }) });
  }

  /** Short-lived signed link to inspect a preserved source. Owner only. */
  async signedSourceUrl(referenceId: string, sourceId: string): Promise<{ url: string; fileName: string }> {
    const c = await this.get(referenceId);
    const s = c.sources.find((x) => x.id === sourceId);
    if (!s) throw new AccessDeniedError(404, 'That source was not found.');
    if (!s.stored || !s.storagePath) throw new Error('The original file was not stored for this source.');
    if (!s.storagePath.startsWith(`${this.user.id}/`)) throw new AccessDeniedError(403, 'You do not have access to that file.');
    let res = await this.storageFetch(`object/sign/pvr-boq-files/${s.storagePath.split('/').map(encodeURIComponent).join('/')}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 120 }) });
    if (!res.ok) throw new Error(`Could not create a retrieval link (HTTP ${res.status}).`);
    const j = (await res.json()) as { signedURL?: string; signedUrl?: string };
    const rel = j.signedURL ?? j.signedUrl;
    if (!rel) throw new Error('Storage did not return a retrieval link.');
    const root = this.base.replace(/\/rest\/v1$/, '');
    return { url: rel.startsWith('http') ? rel : `${root}/storage/v1${rel.startsWith('/') ? '' : '/'}${rel}`, fileName: s.fileName };
  }

  async saveEvaluation(run: EvaluationRun): Promise<void> {
    await this.req('pvr_reference_evaluations', { method: 'POST', body: JSON.stringify({ id: run.id, owner_id: this.user.id, run_at: run.runAt, result: run }) });
  }

  async listEvaluations(): Promise<EvaluationRun[]> {
    const rows = await this.req<{ result: EvaluationRun }[]>(`pvr_reference_evaluations?${this.owner()}&select=result&order=run_at.desc&limit=10`);
    return rows.map((r) => r.result);
  }
}

/**
 * App-side durable job service. Runs ONLY in route handlers. It acts AS the signed-in user (their JWT, explicit
 * case_id/owner_id filters on top of RLS). It never executes analysis: it writes the job and its tasks to Postgres and
 * the independent worker picks them up. Nothing here depends on the browser staying connected.
 */
import { createHash } from 'node:crypto';
import { AccessDeniedError, SupabaseRestStore, StorageUnavailableError, type VerifiedUser } from '@/lib/boq/supabaseStore';

export const CONFIG_VERSION = 'agents-1';
export const STAGES_FOR: Record<string, string[]> = { dxf: ['geometry'], dwg: ['geometry'], pdf: ['extract'], docx: ['extract'], png: ['extract'], jpg: ['extract'], jpeg: ['extract'] };
const SIGNED_URL_SECONDS = 6 * 3600;

export type JobState = 'queued' | 'running' | 'stopping' | 'stopped' | 'completed' | 'partial' | 'failed';
export type TaskStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'skipped' | 'reused';

export interface JobRow { id: string; case_id: string; run_id: string; state: JobState; cancel_requested_at: string | null; cancel_acknowledged_at: string | null; config_version: string; source_hashes: Record<string, string>; resumed_from: string | null; last_error: string | null; created_at: string; started_at: string | null; finished_at: string | null; updated_at: string }
export interface TaskRow { id: string; job_id: string; doc_id: string; file_name: string; stage: string; input_hash: string; config_version: string; status: TaskStatus; attempts: number; max_attempts: number; worker_id: string | null; heartbeat_at: string | null; lease_expires_at: string | null; progress: Record<string, unknown>; error: string | null; reused_from: string | null; started_at: string | null; finished_at: string | null; updated_at: string; result?: unknown }
export interface EventRow { seq: number; job_id: string; task_id: string | null; kind: string; detail: string; payload: Record<string, unknown> | null; created_at: string }

const extOf = (n: string) => (n.match(/\.([a-z0-9]+)$/i) ?? [])[1]?.toLowerCase() ?? '';
export const isProcessable = (name: string) => extOf(name) in STAGES_FOR;

export class JobService {
  private readonly base: string;
  private readonly url: string | undefined;
  private readonly anonKey: string | undefined;
  private readonly user: VerifiedUser;
  private readonly store: SupabaseRestStore;
  constructor(url: string | undefined, anonKey: string | undefined, user: VerifiedUser, store: SupabaseRestStore) {
    this.url = url;
    this.anonKey = anonKey;
    this.user = user;
    this.store = store;
    if (!url || !anonKey) throw new StorageUnavailableError('not_configured', 'NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is not set on the server.');
    this.base = `${url.replace(/\/$/, '')}/rest/v1`;
  }

  private async call<T>(path: string, init: RequestInit & { prefer?: string } = {}): Promise<T> {
    const { prefer, ...rest } = init;
    const res = await fetch(`${this.base}/${path}`, { ...rest, cache: 'no-store', headers: { apikey: this.anonKey!, Authorization: `Bearer ${this.user.token}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}), ...(rest.headers ?? {}) } });
    const text = await res.text();
    let body: unknown = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) {
      const b = (body && typeof body === 'object' ? body : {}) as { message?: string; code?: string };
      if (b.code === '42883' || b.code === 'PGRST202' || b.code === '42P01' || b.code === 'PGRST205') throw new StorageUnavailableError('not_configured', 'Durable processing tables/functions are missing. Apply supabase/migrations/20261121090000_pvr_processing_jobs.sql.');
      if (b.code === '42501') throw new AccessDeniedError(404, 'Job not found for this case.');
      if (b.code === '55000') throw Object.assign(new Error(b.message ?? 'The job is still active.'), { status: 409 });
      throw Object.assign(new Error(b.message ?? `Request failed (HTTP ${res.status}).`), { status: res.status >= 400 && res.status < 600 ? res.status : 500 });
    }
    return body as T;
  }

  private rpc<T>(fn: string, args: Record<string, unknown>) { return this.call<T>(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) }); }

  /** Ownership gate for every operation. A case owned by someone else is reported as not found. */
  private async own(caseId: string) { await this.store.listDocuments(caseId); }

  /** Attach a fresh signed source link to each queued task. The worker needs no storage credential. */
  private async attachSources(caseId: string, jobId: string, docIds: string[]) {
    const sources: Record<string, { url: string; expiresAt: string; kind: string }> = {};
    const expiresAt = new Date(Date.now() + SIGNED_URL_SECONDS * 1000).toISOString();
    for (const id of docIds) {
      const s = await this.store.signedDocumentUrl(caseId, id, SIGNED_URL_SECONDS);
      sources[id] = { url: s.url, expiresAt, kind: extOf(s.fileName) };
    }
    if (docIds.length) await this.rpc('pvr_attach_sources', { p_case_id: caseId, p_job_id: jobId, p_sources: sources });
  }

  /** Create a job and its tasks, then return immediately with the job id. The worker does the work. */
  async submit(caseId: string, runId: string, docIds?: string[]) {
    await this.own(caseId);
    const all = await this.store.listDocuments(caseId);
    const chosen = all.filter((d) => isProcessable(d.name) && (!docIds || docIds.includes(d.id)) && d.stored);
    const skipped = all.filter((d) => !chosen.includes(d)).map((d) => ({ docId: d.id, fileName: d.name, reason: !isProcessable(d.name) ? 'Format not processed by the background worker.' : !d.stored ? 'Original file contents are not stored.' : 'Not selected for this run.' }));
    if (!chosen.length) throw Object.assign(new Error('No stored drawings or documents are available to process.'), { status: 422 });
    const jobId = `job-${Date.now().toString(36)}-${createHash('sha256').update(`${caseId}:${runId}`).digest('hex').slice(0, 8)}`;
    const hashes: Record<string, string> = {}; for (const d of chosen) hashes[d.id] = d.sha256;
    try {
      await this.call('pvr_processing_jobs', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ id: jobId, case_id: caseId, run_id: runId, state: 'queued', config_version: CONFIG_VERSION, source_hashes: hashes }) });
    } catch (e) {
      if ((e as { status?: number }).status === 409) { const existing = await this.findByRun(caseId, runId); if (existing) return { jobId: existing.id, state: existing.state, duplicate: true, skipped }; }
      throw e;
    }
    const tasks = chosen.flatMap((d) => (STAGES_FOR[extOf(d.name)] ?? []).map((stage) => ({ id: `${jobId}:${d.id}:${stage}`, job_id: jobId, case_id: caseId, doc_id: d.id, file_name: d.name, stage, input_hash: d.sha256, config_version: CONFIG_VERSION, status: 'queued' })));
    await this.call('pvr_processing_tasks', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(tasks) });
    await this.attachSources(caseId, jobId, chosen.map((d) => d.id));
    return { jobId, state: 'queued' as JobState, duplicate: false, tasks: tasks.length, skipped };
  }

  private async findByRun(caseId: string, runId: string) {
    const r = await this.call<JobRow[]>(`pvr_processing_jobs?case_id=eq.${encodeURIComponent(caseId)}&run_id=eq.${encodeURIComponent(runId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&select=*`);
    return r[0] ?? null;
  }

  async list(caseId: string) {
    await this.own(caseId);
    return this.call<JobRow[]>(`pvr_processing_jobs?case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&select=*&order=created_at.desc&limit=20`);
  }

  /** Persisted state. Completed results are included only when asked for (they can be large). */
  async get(caseId: string, jobId: string, opts: { sinceSeq?: number; withResults?: boolean } = {}) {
    await this.own(caseId);
    const jobs = await this.call<JobRow[]>(`pvr_processing_jobs?id=eq.${encodeURIComponent(jobId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&select=*`);
    const job = jobs[0]; if (!job) throw new AccessDeniedError(404, 'Job not found for this case.');
    const cols = 'id,job_id,doc_id,file_name,stage,input_hash,config_version,status,attempts,max_attempts,worker_id,heartbeat_at,lease_expires_at,progress,error,reused_from,started_at,finished_at,updated_at' + (opts.withResults ? ',result' : '');
    const tasks = await this.call<TaskRow[]>(`pvr_processing_tasks?job_id=eq.${encodeURIComponent(jobId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&select=${cols}&order=created_at.asc`);
    const events = await this.call<EventRow[]>(`pvr_processing_events?job_id=eq.${encodeURIComponent(jobId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_id=eq.${encodeURIComponent(this.user.id)}&seq=gt.${Number(opts.sinceSeq ?? 0)}&select=*&order=seq.asc&limit=400`);
    return { job, tasks, events };
  }

  /** Request a stop. The job shows "stopping" until the worker acknowledges (or nothing was executing). */
  async stop(caseId: string, jobId: string) { await this.own(caseId); return this.rpc<{ state: JobState; changed: boolean }>('pvr_request_stop', { p_case_id: caseId, p_job_id: jobId }); }

  /**
   * Resume: a NEW job (the interrupted one is kept untouched) that reuses every completed task whose document hash and
   * configuration still match, and queues the rest. Changed or removed files invalidate only their own tasks.
   */
  async resume(caseId: string, jobId: string) {
    await this.own(caseId);
    const docs = (await this.store.listDocuments(caseId)).filter((d) => isProcessable(d.name) && d.stored);
    const current: Record<string, string> = {}; for (const d of docs) current[d.id] = d.sha256;
    const newId = `job-${Date.now().toString(36)}-r${createHash('sha256').update(`${jobId}:${Date.now()}`).digest('hex').slice(0, 6)}`;
    const r = await this.rpc<{ jobId: string; reused: number; queued: number; invalidated: number }>('pvr_resume_job', { p_case_id: caseId, p_job_id: jobId, p_new_job_id: newId, p_new_run_id: `run-${newId}`, p_current: current, p_config_version: CONFIG_VERSION });
    if (r.queued > 0) await this.attachSources(caseId, newId, Object.keys(current));
    return r;
  }

  /** Re-queue only the failed tasks of a finished job; completed work is kept. Refreshes signed links first. */
  async retryFailed(caseId: string, jobId: string) {
    await this.own(caseId);
    const r = await this.rpc<{ requeued: number; state: JobState }>('pvr_retry_failed', { p_case_id: caseId, p_job_id: jobId });
    if (r.requeued > 0) {
      const t = await this.call<{ doc_id: string }[]>(`pvr_processing_tasks?job_id=eq.${encodeURIComponent(jobId)}&status=eq.queued&select=doc_id`);
      await this.attachSources(caseId, jobId, [...new Set(t.map((x) => x.doc_id))]);
    }
    return r;
  }
}

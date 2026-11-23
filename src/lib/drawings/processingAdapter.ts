/**
 * Server-side adapter to the processing worker. Runs ONLY in route handlers (Node). Credentials come from server
 * environment variables and are never returned to the browser.
 *
 *   PROCESSING_WORKER_URL    base URL of a deployed services/processing-worker (no trailing slash)
 *   PROCESSING_WORKER_TOKEN  bearer secret shared with the worker (its WORKER_API_TOKEN)
 *
 * With both set, jobs go to the remote worker. Without them the adapter reports mode "in_process": the same
 * extraction code runs inside this Next.js runtime, which cannot host a DWG converter or long OCR jobs on serverless
 * hosting. It never invents a remote URL and never claims a connection it has not tested.
 */
import { createHash } from 'node:crypto';
import { extractByExtension, MAX_BYTES } from './extractServer';
import { convertDwg, dwgStatus } from './dwgConvert';
import type { ExtractedDocument } from './types';

export type JobState = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';

export interface JobView {
  id: string; caseId: string; runId: string; fileName: string; sha256: string; kind: string;
  state: JobState; progress: { done?: number; total?: number; detail?: string }; error: string | null;
  createdAt: number; updatedAt: number; mode: 'remote' | 'in_process';
}

export interface JobResult {
  kind: 'text' | 'dwg'; ok: boolean; error?: string;
  doc?: ExtractedDocument | { unitKind: string; units: unknown[]; coverage: Record<string, unknown> };
  dxfBase64?: string; converter?: string; converterVersion?: string; sourceSha256?: string; dxfSha256?: string; warnings?: string[]; validation?: { issues: string[] };
}

export const workerConfig = () => {
  const url = (process.env.PROCESSING_WORKER_URL ?? '').replace(/\/$/, '');
  const token = process.env.PROCESSING_WORKER_TOKEN ?? '';
  return { url, token, remote: !!(url && token), partial: !!(url || token) && !(url && token) };
};

export const ALLOWED_EXT = ['pdf', 'docx', 'png', 'jpg', 'jpeg', 'dwg'] as const;
const extOf = (n: string) => (n.match(/\.([a-z0-9]+)$/i) ?? [])[1]?.toLowerCase() ?? '';
export const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export function validateUpload(name: string, bytes: Uint8Array): string | null {
  const e = extOf(name);
  if (!(ALLOWED_EXT as readonly string[]).includes(e)) return `.${e || '(none)'} is not accepted. Allowed: ${ALLOWED_EXT.join(', ')}.`;
  if (bytes.byteLength === 0) return 'The file is empty.';
  if (bytes.byteLength > MAX_BYTES) return `The file is larger than the ${MAX_BYTES / 1048576} MB limit.`;
  const h = Buffer.from(bytes.subarray(0, 8));
  const ok =
    (e === 'pdf' && h.subarray(0, 5).toString('latin1') === '%PDF-') ||
    (e === 'docx' && h[0] === 0x50 && h[1] === 0x4b) ||
    (e === 'dwg' && h.subarray(0, 2).toString('latin1') === 'AC') ||
    (e === 'png' && h[0] === 0x89 && h.subarray(1, 4).toString('latin1') === 'PNG') ||
    ((e === 'jpg' || e === 'jpeg') && h[0] === 0xff && h[1] === 0xd8);
  return ok ? null : `The content of "${name}" does not look like a .${e} file (signature check failed).`;
}

/** Real call to the worker's /health. A set env var is NOT a successful test; only this response is. */
export async function testWorker(): Promise<{ state: 'not_configured' | 'failed' | 'passed'; detail: string; testedAt: string; durationMs?: number; dependencies?: unknown }> {
  const c = workerConfig(); const testedAt = new Date().toISOString();
  if (!c.url) return { state: 'not_configured', detail: 'PROCESSING_WORKER_URL is not set. Heavy conversion/OCR runs only in this app runtime (no DWG converter).', testedAt };
  if (!c.token) return { state: 'failed', detail: 'PROCESSING_WORKER_URL is set but PROCESSING_WORKER_TOKEN is not, so jobs cannot be authenticated.', testedAt };
  const t0 = Date.now();
  try {
    const h = await fetch(`${c.url}/health`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (!h.ok) return { state: 'failed', detail: `Worker /health returned HTTP ${h.status}.`, testedAt, durationMs: Date.now() - t0 };
    const body = (await h.json()) as { status?: string; authConfigured?: boolean; dependencies?: unknown };
    // Authenticated probe: a request for an unknown job must give 404 (authorised) not 401 (token rejected).
    const a = await fetch(`${c.url}/jobs/00000000-0000-0000-0000-000000000000`, { headers: { Authorization: `Bearer ${c.token}` }, cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (a.status === 401 || a.status === 503) return { state: 'failed', detail: a.status === 401 ? 'The worker rejected PROCESSING_WORKER_TOKEN (it does not match the worker\'s WORKER_API_TOKEN).' : 'The worker has no WORKER_API_TOKEN configured.', testedAt, durationMs: Date.now() - t0 };
    if (body.status !== 'ok') return { state: 'failed', detail: 'Worker health did not report ok.', testedAt, durationMs: Date.now() - t0 };
    return { state: 'passed', detail: 'Worker reachable; /health ok; bearer token accepted.', testedAt, durationMs: Date.now() - t0, dependencies: body.dependencies };
  } catch (e) {
    return { state: 'failed', detail: `Worker unreachable: ${e instanceof Error ? e.message : 'network error'}`, testedAt, durationMs: Date.now() - t0 };
  }
}

// ---------------- in-process jobs (fallback when no remote worker is configured) ----------------

interface LocalJob extends JobView { result?: JobResult; controller: AbortController }
const g = globalThis as unknown as { __pvrLocalJobs?: Map<string, LocalJob>; __pvrLatestRun?: Map<string, string> };
const localJobs = (g.__pvrLocalJobs ??= new Map());
/** caseId+fileSha -> newest runId, so a late result from an older run is never presented as current. */
const latestRun = (g.__pvrLatestRun ??= new Map());

export async function submitJob(args: { caseId: string; runId: string; fileName: string; bytes: Uint8Array; userId: string }): Promise<JobView> {
  const invalid = validateUpload(args.fileName, args.bytes);
  if (invalid) throw Object.assign(new Error(invalid), { status: 415 });
  const sha = sha256Hex(args.bytes);
  latestRun.set(`${args.caseId}:${sha}`, args.runId);
  const c = workerConfig();
  if (c.remote) {
    const fd = new FormData();
    fd.append('caseId', args.caseId); fd.append('runId', args.runId); fd.append('sha256', sha);
    const copy = new Uint8Array(args.bytes.byteLength); copy.set(args.bytes);
    fd.append('file', new Blob([copy]), args.fileName);
    const r = await fetch(`${c.url}/jobs`, { method: 'POST', headers: { Authorization: `Bearer ${c.token}` }, body: fd, cache: 'no-store' });
    const j = (await r.json().catch(() => ({}))) as { job?: Omit<JobView, 'mode'>; error?: string };
    if (!r.ok || !j.job) throw Object.assign(new Error(j.error ?? `The processing worker returned HTTP ${r.status}.`), { status: r.status === 401 || r.status === 503 ? 502 : r.status });
    return { ...j.job, mode: 'remote' };
  }
  const id = crypto.randomUUID();
  const job: LocalJob = { id, caseId: args.caseId, runId: args.runId, fileName: args.fileName, sha256: sha, kind: extOf(args.fileName), state: 'queued', progress: { detail: 'Queued' }, error: null, createdAt: Date.now(), updatedAt: Date.now(), mode: 'in_process', controller: new AbortController() };
  localJobs.set(id, job);
  void runLocal(job, args.bytes);
  return view(job);
}

const view = (j: LocalJob): JobView => { const { result: _r, controller: _c, ...v } = j; void _r; void _c; return v; };

async function runLocal(job: LocalJob, bytes: Uint8Array) {
  job.state = 'running'; job.updatedAt = Date.now();
  const timer = setTimeout(() => job.controller.abort(), 240_000);
  try {
    let res: JobResult;
    if (job.kind === 'dwg') {
      job.progress = { detail: 'Converting DWG to DXF' };
      const r = await convertDwg(bytes);
      res = r.ok && r.dxf
        ? { kind: 'dwg', ok: true, dxfBase64: Buffer.from(r.dxf).toString('base64'), converter: r.converter, converterVersion: r.converterVersion, sourceSha256: r.sourceSha256, dxfSha256: r.dxfSha256, warnings: r.warnings ?? [] }
        : { kind: 'dwg', ok: false, error: r.error ?? 'Conversion failed.' };
    } else {
      const doc = await extractByExtension(job.fileName, bytes, (p) => { if (job.state === 'running') { job.progress = { done: p.page, total: p.total, detail: `${p.method}: page ${p.page} of ${p.total}` }; job.updatedAt = Date.now(); } });
      res = doc ? { kind: 'text', ok: doc.pages.some((p) => p.text.trim().length > 0), doc, ...(doc.pages.some((p) => p.text.trim()) ? {} : { error: doc.limitation || 'No text could be read.' }) } : { kind: 'text', ok: false, error: 'Unsupported format.' };
    }
    if (job.state !== 'running') return; // cancelled meanwhile: discard
    job.result = res; job.error = res.ok ? null : res.error ?? 'Processing failed.';
    const partial = res.kind === 'text' && res.ok && res.doc && 'pages' in res.doc && (res.doc.truncated || /NOT (read|OCR)|could not|failed|recognised no text/i.test(res.doc.limitation) || res.doc.pages.some((p) => !p.text.trim()));
    job.state = !res.ok ? 'failed' : partial ? 'partial' : 'completed';
  } catch (e) {
    if (job.state === 'running') { job.state = 'failed'; job.error = job.controller.signal.aborted ? 'Processing exceeded the 240 s limit.' : e instanceof Error ? e.message : 'Processing failed.'; }
  } finally { clearTimeout(timer); job.updatedAt = Date.now(); }
}

export async function getJob(id: string, opts: { withResult?: boolean } = {}): Promise<{ job: JobView; result?: JobResult } | { error: string; status: number }> {
  const c = workerConfig();
  const local = localJobs.get(id);
  if (local) return { job: view(local), ...(opts.withResult && ['completed', 'partial', 'failed'].includes(local.state) ? { result: local.result } : {}) };
  if (!c.remote) return { error: 'Job not found.', status: 404 };
  const r = await fetch(`${c.url}/jobs/${id}${opts.withResult ? '/result' : ''}`, { headers: { Authorization: `Bearer ${c.token}` }, cache: 'no-store' });
  const j = (await r.json().catch(() => ({}))) as { job?: Omit<JobView, 'mode'> & { result?: JobResult }; error?: string };
  if (!j.job) return { error: j.error ?? `Worker returned HTTP ${r.status}.`, status: r.status === 401 ? 502 : r.status };
  const { result, ...rest } = j.job;
  return { job: { ...rest, mode: 'remote' }, ...(result ? { result } : {}) };
}

export async function cancelJob(id: string): Promise<{ job: JobView } | { error: string; status: number }> {
  const local = localJobs.get(id);
  if (local) { if (local.state === 'queued' || local.state === 'running') { local.state = 'cancelled'; local.error = 'Cancelled by request.'; local.controller.abort(); local.updatedAt = Date.now(); } return { job: view(local) }; }
  const c = workerConfig(); if (!c.remote) return { error: 'Job not found.', status: 404 };
  const r = await fetch(`${c.url}/jobs/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${c.token}` }, cache: 'no-store' });
  const j = (await r.json().catch(() => ({}))) as { job?: Omit<JobView, 'mode'>; error?: string };
  return j.job ? { job: { ...j.job, mode: 'remote' } } : { error: j.error ?? `Worker returned HTTP ${r.status}.`, status: r.status };
}

/** True when `runId` is still the newest run for this case + file. Callers must drop results that return false. */
export const isCurrentRun = (caseId: string, sha256: string, runId: string) => (latestRun.get(`${caseId}:${sha256}`) ?? runId) === runId;

export const dwgLocalStatus = () => dwgStatus();

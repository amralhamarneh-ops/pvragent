/**
 * In-memory job manager. Jobs are bound to a caseId and an input sha256 so results are version-aware.
 * States: queued | running | completed | partial | failed | cancelled.
 * A job that is cancelled never transitions to completed (late results are discarded).
 */
import { randomUUID } from 'node:crypto';

const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_JOBS || 2);
const RESULT_TTL_MS = Number(process.env.RESULT_TTL_MS || 30 * 60_000);
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 20);

export class JobManager {
  constructor(handler, { timeoutMs }) { this.handler = handler; this.timeoutMs = timeoutMs; this.jobs = new Map(); this.queue = []; this.running = 0; }

  submit({ caseId, runId, fileName, sha256, bytes, kind }) {
    if (this.queue.length >= MAX_QUEUE) return { error: 'queue_full' };
    const id = randomUUID();
    const job = { id, caseId, runId, fileName, sha256, kind, state: 'queued', progress: { done: 0, total: 0, detail: 'Queued' }, result: null, error: null, createdAt: Date.now(), updatedAt: Date.now(), controller: new AbortController(), bytes };
    this.jobs.set(id, job); this.queue.push(job); this.pump();
    return { job };
  }

  pump() {
    while (this.running < MAX_CONCURRENT && this.queue.length) {
      const job = this.queue.shift();
      if (job.state !== 'queued') continue;
      this.running += 1; job.state = 'running'; job.updatedAt = Date.now();
      const timer = setTimeout(() => job.controller.abort(new Error('timeout')), this.timeoutMs);
      Promise.resolve()
        .then(() => this.handler(job, (p) => { if (job.state === 'running') { job.progress = { ...job.progress, ...p }; job.updatedAt = Date.now(); } }))
        .then((res) => {
          if (job.state !== 'running') return; // cancelled while running: discard the late result
          job.result = res; job.state = res?.ok === false ? 'failed' : res?.doc?.coverage && !res.doc.coverage.complete ? 'partial' : 'completed';
          if (res?.ok === false) job.error = res.error ?? 'Processing failed.';
        })
        .catch((e) => { if (job.state !== 'running') return; job.state = job.controller.signal.aborted && String(job.controller.signal.reason?.message) === 'timeout' ? 'failed' : 'failed'; job.error = String(e?.message) === 'timeout' || job.controller.signal.reason?.message === 'timeout' ? `Processing exceeded the ${Math.round(this.timeoutMs / 1000)} s limit.` : String(e?.message ?? e); })
        .finally(() => { clearTimeout(timer); job.bytes = null; job.updatedAt = Date.now(); this.running -= 1; this.pump(); });
    }
  }

  get(id) { return this.jobs.get(id); }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.state === 'queued' || job.state === 'running') { job.state = 'cancelled'; job.error = 'Cancelled by request.'; job.controller.abort(new Error('cancelled')); job.bytes = null; job.updatedAt = Date.now(); }
    return job;
  }

  sweep() { const now = Date.now(); for (const [id, j] of this.jobs) if (!['queued', 'running'].includes(j.state) && now - j.updatedAt > RESULT_TTL_MS) this.jobs.delete(id); }

  view(job, { withResult = false } = {}) {
    const { id, caseId, runId, fileName, sha256, kind, state, progress, error, createdAt, updatedAt } = job;
    const v = { id, caseId, runId, fileName, sha256, kind, state, progress, error, createdAt, updatedAt };
    if (withResult && ['completed', 'partial', 'failed'].includes(state)) v.result = job.result;
    return v;
  }
}

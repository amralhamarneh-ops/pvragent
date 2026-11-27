/**
 * Durable runner. An independent loop that claims tasks from the Postgres queue and executes them.
 * Properties (each is enforced in the database functions, not just here):
 *  - claim uses FOR UPDATE SKIP LOCKED: two workers can never hold the same task
 *  - a lease + heartbeat: a crashed/restarted worker's task is reclaimed after the lease expires (attempt counter kept)
 *  - fencing token: a stale worker cannot publish; a task already published ignores a second publish
 *  - cancel is polled at every heartbeat and between batches; the worker acknowledges by releasing the task
 *  - a cancelled external converter process is killed through AbortSignal; we only report "cancelled" when it was
 */
import { createHash, randomUUID } from 'node:crypto';
import { store, downloadSigned, storeConfig } from './store.mjs';
import { extractByName, sniff, LIMITS } from './extract.mjs';
import { convertDwg } from './dwg.mjs';
import { readDxfForWorker } from './dxf.mjs';

const WORKER_ID = process.env.WORKER_ID || `worker-${randomUUID().slice(0, 8)}`;
const LEASE_S = Number(process.env.LEASE_SECONDS || 60);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 15_000);
const POLL_MS = Number(process.env.POLL_MS || 2_000);
const CONCURRENCY = Number(process.env.MAX_CONCURRENT_JOBS || 2);
const extOf = (n) => (String(n).match(/\.([a-z0-9]+)$/i) ?? [])[1]?.toLowerCase() ?? '';
const sha = (b) => createHash('sha256').update(b).digest('hex');

export const runnerState = { workerId: WORKER_ID, running: 0, lastClaimAt: null, lastError: null, started: false, processed: 0 };

/** Execute one claimed task. Returns { status, result, error } and never publishes by itself. */
export async function executeTask(task, { signal, emit, shouldStop }) {
  const doc = await store.document(task.taskId, task.leaseToken);
  if (!doc) return { status: 'failed', error: 'The task document is no longer available to this lease.' };
  if (!doc.sourceUrl) return { status: 'failed', error: 'No signed source link is attached to this task. Resume the run to refresh it.' };
  if (doc.sourceUrlExpiresAt && new Date(doc.sourceUrlExpiresAt).getTime() < Date.now()) return { status: 'failed', error: 'The signed source link expired before the task started. Resume the run to refresh it.', retryable: false };
  const bytes = await downloadSigned(doc.sourceUrl, { signal });
  const got = sha(bytes);
  if (task.inputHash && got !== task.inputHash) return { status: 'failed', error: `Input changed: stored file hash ${got.slice(0, 12)}… does not match the run's recorded hash ${String(task.inputHash).slice(0, 12)}….` };

  const e = extOf(task.fileName);
  if (e === 'dxf') {
    await emit('stage', 'Reading DXF geometry');
    const r = await readDxfForWorker(task.fileName, bytes, {
      shouldStop,
      onBatch: async (b) => { await emit('geometry', `${b.layer}: ${b.delivered}/${b.total} entities`, { layer: b.layer, batchIndex: b.batchIndex, entities: b.entities, delivered: b.delivered, total: b.total, extents: b.extents, metresPerUnit: b.metresPerUnit, unit: b.unit }); },
    });
    if (r.state === 'stopped') return { status: 'cancelled', error: r.error };
    if (!r.ok) return { status: 'failed', error: r.error, result: { kind: 'dxf', ok: false, state: r.state } };
    return { status: r.coverage.complete ? 'completed' : 'partial', result: { kind: 'dxf', ok: true, state: r.state, fileName: task.fileName, sha256: got, coverage: r.coverage, inventory: r.inventory, texts: r.texts } };
  }
  if (e === 'dwg') {
    await emit('stage', 'Converting DWG to DXF');
    const c = await convertDwg(bytes, { signal, timeoutMs: LIMITS.jobTimeoutMs });
    if (!c.ok) return { status: 'failed', error: c.error, result: { kind: 'dwg', ok: false, converter: c.converter ?? null, sourceSha256: got, label: 'Not processed: converter unavailable' } };
    const r = await readDxfForWorker(task.fileName, c.dxf, { shouldStop, onBatch: async (b) => { await emit('geometry', `${b.layer}: ${b.delivered}/${b.total} entities`, { layer: b.layer, batchIndex: b.batchIndex, entities: b.entities, delivered: b.delivered, total: b.total, extents: b.extents, metresPerUnit: b.metresPerUnit, unit: b.unit }); } });
    if (r.state === 'stopped') return { status: 'cancelled', error: r.error };
    if (!r.ok) return { status: 'failed', error: r.error, result: { kind: 'dwg', ok: false, converter: c.converter, converterVersion: c.converterVersion } };
    r.coverage.issues.push(...(c.warnings ?? []).map((w) => `Converter: ${w}`), ...(c.validation?.issues ?? []));
    return { status: r.coverage.complete && !(c.warnings ?? []).length ? 'completed' : 'partial', result: { kind: 'dwg', ok: true, converter: c.converter, converterVersion: c.converterVersion, sourceSha256: got, dxfSha256: c.dxfSha256, coverage: r.coverage, inventory: r.inventory, texts: r.texts } };
  }
  const kind = sniff(bytes);
  await emit('stage', `Extracting ${e.toUpperCase()}`);
  const out = await extractByName(task.fileName, bytes, { signal, onProgress: (p) => emit('progress', p.detail ?? `${p.done ?? 0}/${p.total ?? 0}`, p) });
  if (!out) return { status: 'failed', error: `.${e} is not a format this service reads (${kind}).` };
  if (out.ok === false) return { status: 'failed', error: out.error ?? 'Extraction failed.', result: out };
  return { status: out.doc?.coverage && !out.doc.coverage.complete ? 'partial' : 'completed', result: { ...out, sha256: got } };
}

async function runOne(task) {
  const ac = new AbortController();
  let cancelled = false; let leaseLost = false;
  const beat = async (progress) => {
    try {
      const r = await store.heartbeat(task.taskId, task.leaseToken, LEASE_S, progress);
      if (!r?.ok) { leaseLost = true; ac.abort(new Error('lease_lost')); }
      else if (r.cancel) { cancelled = true; ac.abort(new Error('cancelled')); }
    } catch (e) { runnerState.lastError = String(e?.message ?? e); }
  };
  const timer = setInterval(() => { void beat(null); }, HEARTBEAT_MS);
  let seq = 0;
  const emit = async (kind, detail, payload) => {
    if (leaseLost) return;
    seq += 1;
    try { await store.event(task.taskId, task.leaseToken, kind, detail, payload ? { ...payload, n: seq } : { n: seq }); } catch (e) { runnerState.lastError = String(e?.message ?? e); }
    if (seq % 5 === 0) await beat({ detail, events: seq });
  };
  const shouldStop = async () => { if (!cancelled && !leaseLost) await beat(null); return cancelled || leaseLost; };
  try {
    const timeout = setTimeout(() => ac.abort(new Error('timeout')), LIMITS.jobTimeoutMs);
    let out;
    try { out = await executeTask(task, { signal: ac.signal, emit, shouldStop }); } finally { clearTimeout(timeout); }
    if (leaseLost) return; // another worker owns it now; publish nothing
    if (cancelled || out.status === 'cancelled') { await store.release(task.taskId, task.leaseToken, 'Cancelled by request; the task stopped at a safe boundary.', false); return; }
    const hash = out.result ? sha(Buffer.from(JSON.stringify(out.result))) : null;
    const pub = await store.complete(task.taskId, task.leaseToken, out.status, out.result ?? null, hash, out.error ?? null);
    if (pub && pub.published === false) runnerState.lastError = `Publish refused: ${pub.reason}`;
    runnerState.processed += 1;
  } catch (e) {
    if (leaseLost) return;
    const msg = String(e?.message ?? e);
    if (cancelled || msg === 'cancelled') { await store.release(task.taskId, task.leaseToken, 'Cancelled by request.', false).catch(() => {}); return; }
    if (msg === 'timeout') { await store.complete(task.taskId, task.leaseToken, 'failed', null, null, `Processing exceeded the ${Math.round(LIMITS.jobTimeoutMs / 1000)} s limit.`).catch(() => {}); return; }
    // Transient failure: hand back for retry (the database enforces max_attempts).
    await store.release(task.taskId, task.leaseToken, msg.slice(0, 300), true).catch(() => {});
  } finally { clearInterval(timer); }
}

let stopping = false;
export function stopRunner() { stopping = true; }

export async function startRunner() {
  const cfg = storeConfig();
  if (!cfg.ok) { runnerState.lastError = `Durable store not configured: missing ${cfg.missing.join(', ')}.`; console.warn(`Runner NOT started. ${runnerState.lastError}`); return false; }
  runnerState.started = true;
  const inflight = new Set();
  const loop = async () => {
    while (!stopping) {
      try {
        if (inflight.size < CONCURRENCY) {
          const task = await store.claim(WORKER_ID, LEASE_S);
          runnerState.lastClaimAt = new Date().toISOString();
          if (task) {
            runnerState.running = inflight.size + 1;
            const p = runOne(task).finally(() => { inflight.delete(p); runnerState.running = inflight.size; });
            inflight.add(p);
            continue; // look for more work immediately
          }
        }
      } catch (e) { runnerState.lastError = String(e?.message ?? e); }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    await Promise.allSettled([...inflight]);
  };
  void loop();
  console.log(`runner ${WORKER_ID} started (concurrency ${CONCURRENCY}, lease ${LEASE_S}s, heartbeat ${HEARTBEAT_MS}ms)`);
  return true;
}

/**
 * Durable job store client for the worker. Talks to Postgres ONLY through the pvr_worker_* SECURITY DEFINER functions,
 * authenticated with a shared secret (WORKER_DB_SECRET). It holds no user session and no service-role key.
 * Every state change (claim, heartbeat, event, complete, release) is persisted before the worker acts on it.
 * Original files are fetched from a short-lived signed URL that the app server attached to the task.
 */
const URL_ = () => (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const KEY_ = () => process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const SECRET = () => process.env.WORKER_DB_SECRET || '';

export const storeConfig = () => {
  const missing = [];
  if (!URL_()) missing.push('SUPABASE_URL');
  if (!KEY_()) missing.push('SUPABASE_ANON_KEY');
  if (!SECRET()) missing.push('WORKER_DB_SECRET');
  return { ok: missing.length === 0, missing };
};

async function rpc(fn, args, { signal } = {}) {
  const res = await fetch(`${URL_()}/rest/v1/rpc/${fn}`, {
    method: 'POST', cache: 'no-store', signal,
    headers: { apikey: KEY_(), Authorization: `Bearer ${KEY_()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw Object.assign(new Error(`${fn} failed: HTTP ${res.status} ${typeof body === 'object' && body ? body.message ?? '' : String(body).slice(0, 160)}`), { status: res.status });
  return body;
}

export const store = {
  claim: (workerId, leaseSeconds) => rpc('pvr_worker_claim', { p_secret: SECRET(), p_worker_id: workerId, p_lease_seconds: leaseSeconds }),
  heartbeat: (taskId, token, leaseSeconds, progress) => rpc('pvr_worker_heartbeat', { p_secret: SECRET(), p_task_id: taskId, p_lease_token: token, p_lease_seconds: leaseSeconds, p_progress: progress ?? null }),
  event: (taskId, token, kind, detail, payload) => rpc('pvr_worker_event', { p_secret: SECRET(), p_task_id: taskId, p_lease_token: token, p_kind: kind, p_detail: detail ?? '', p_payload: payload ?? null }),
  complete: (taskId, token, status, result, resultHash, error) => rpc('pvr_worker_complete', { p_secret: SECRET(), p_task_id: taskId, p_lease_token: token, p_status: status, p_result: result ?? null, p_result_hash: resultHash ?? null, p_error: error ?? null }),
  release: (taskId, token, reason, requeue) => rpc('pvr_worker_release', { p_secret: SECRET(), p_task_id: taskId, p_lease_token: token, p_reason: reason ?? '', p_requeue: !!requeue }),
  document: (taskId, token) => rpc('pvr_worker_document', { p_secret: SECRET(), p_task_id: taskId, p_lease_token: token }),
};

/** Download the original from the signed URL attached to the task. The worker never holds storage credentials. */
export async function downloadSigned(url, { signal } = {}) {
  const res = await fetch(url, { cache: 'no-store', signal });
  if (!res.ok) throw Object.assign(new Error(`Could not read the stored original (HTTP ${res.status}). The signed link may have expired; resume the run to refresh it.`), { status: res.status });
  return new Uint8Array(await res.arrayBuffer());
}

import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeQueue } from '../src/store.mjs';

test('readiness proves a matching Supabase project and a read-only authorised queue RPC', async (t) => {
  const url = 'https://test-db.example';
  const env = { SUPABASE_URL: url, SUPABASE_ANON_KEY: 'fixture-key', WORKER_DB_SECRET: 'fixture-not-a-real-secret' };
  const prior = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const hash = createHash('sha256').update(url).digest('hex');
  const requests = [];
  let status = 200;
  globalThis.fetch = async (target, init) => {
    requests.push({ target, init });
    return new Response(status === 200 ? 'null' : '{}', { status });
  };
  assert.deepEqual(await probeQueue(hash, false), { ready: false, code: 'runner_not_started' });
  assert.deepEqual(await probeQueue('different', true), { ready: false, code: 'wrong_project' });
  assert.equal(requests.length, 0);
  assert.deepEqual(await probeQueue(hash, true), { ready: true });
  assert.equal(requests[0].target, `${url}/rest/v1/rpc/pvr_worker_document`);
  assert.equal(requests[0].init.redirect, 'error');
  assert.match(JSON.parse(requests[0].init.body).p_task_id, /^readiness-/);
  status = 403;
  assert.deepEqual(await probeQueue(hash, true), { ready: false, code: 'database_rejected' });
});

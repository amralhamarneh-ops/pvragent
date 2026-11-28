import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/processing/jobs/route';

const route = 'http://localhost/api/processing/jobs';
function request(action: string, session = 'test-user-token') {
  return new NextRequest(route, { method: 'POST', headers: { Authorization: `Bearer ${session}` },
    body: JSON.stringify({ action, caseId: 'test-case', runId: 'test-run', jobId: 'test-job' }) });
}
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test-db.example');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-key');
  vi.stubEnv('PROCESSING_WORKER_URL', 'https://test-worker.example');
  vi.stubEnv('PROCESSING_WORKER_TOKEN', 'test-worker-token');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('real queue route readiness', () => {
  it.each(['run', 'resume', 'retry'])('does not write on %s when the worker cannot use the same database', async (action) => {
    const fetch = vi.fn(async (input: string) => {
      if (input.endsWith('/auth/v1/user')) return Response.json({ id: 'test-user' });
      if (input.endsWith('/ready/queue')) return Response.json({ ready: false, code: 'wrong_project' }, { status: 503 });
      throw new Error('unexpected request');
    });
    vi.stubGlobal('fetch', fetch);
    const r = await POST(request(action));
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ blocker: 'worker_not_ready', error: expect.stringContaining('different Supabase projects') });
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/auth/v1/user', '/ready/queue']);
  });
  it('returns a sign-in error before contacting the worker or writing to Supabase for a stale session', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    const r = await POST(request('run', 'stale'));
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ blocker: 'not_signed_in' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

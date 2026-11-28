import { NextRequest, NextResponse } from 'next/server';
import { AccessDeniedError, SupabaseRestStore, failureResponse, verifyUser } from '@/lib/boq/supabaseStore';
import { JobService } from '@/lib/drawings/jobService';
import { queueReadiness } from '@/lib/drawings/queueReadiness';
import { workerConfig, testWorker, dwgLocalStatus } from '@/lib/drawings/processingAdapter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const URL_ = () => process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY_ = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const err = (e: unknown) => {
  const status = (e as { status?: number })?.status;
  if (!(e instanceof AccessDeniedError) && status && status >= 400 && status < 600 && !(e as { diagnostic?: unknown }).diagnostic && !(e as { kind?: string }).kind) return NextResponse.json({ error: e instanceof Error ? e.message : 'Request failed.' }, { status });
  const f = failureResponse(e);
  return NextResponse.json(f.body, { status: f.status });
};

async function svc(req: NextRequest) {
  const user = await verifyUser(req.headers.get('authorization'), URL_(), KEY_());
  const store = new SupabaseRestStore(URL_(), KEY_(), user);
  return new JobService(URL_(), KEY_(), user, store);
}

/**
 * Execution is a durable queue consumed by an independent worker. This route only writes and reads persisted state, so
 * closing the page, losing connectivity or a sleeping computer never affects a job that was accepted.
 *
 * GET                       -> worker connection summary (a real, tested connection; env vars alone are not "connected")
 * GET ?caseId=              -> the case's jobs (newest first)
 * GET ?caseId=&jobId=       -> persisted job + tasks + events after &since=<seq>; &results=1 includes task results
 */
export async function GET(req: NextRequest) {
  try {
    const q = req.nextUrl.searchParams;
    const caseId = q.get('caseId'); const jobId = q.get('jobId');
    if (!caseId) {
      if (q.get('readiness') === '1') {
        await svc(req);
        return NextResponse.json(await queueReadiness(), { headers: { 'Cache-Control': 'no-store' } });
      }
      const c = workerConfig();
      const test = q.get('test') === '1' ? await testWorker() : null;
      const dwg = dwgLocalStatus();
      return NextResponse.json({ mode: c.remote ? 'remote' : 'not_connected', workerUrlConfigured: !!c.url, workerTokenConfigured: !!c.token, inProcessDwg: dwg.configured ? { configured: true, converter: dwg.converter } : { configured: false }, test });
    }
    const s = await svc(req);
    if (!jobId) return NextResponse.json({ jobs: await s.list(caseId) });
    const r = await s.get(caseId, jobId, { sinceSeq: Number(q.get('since') ?? 0), withResults: q.get('results') === '1' });
    return NextResponse.json({ ...r, serverTime: new Date().toISOString() });
  } catch (e) { return err(e); }
}

/**
 * POST { action: 'run',    caseId, runId, docIds? }  -> persist a job, return its id promptly (202)
 *      { action: 'stop',   caseId, jobId }           -> request cancellation; state is "stopping" until acknowledged
 *      { action: 'resume', caseId, jobId }           -> new job reusing compatible completed work
 *      { action: 'retry',  caseId, jobId }           -> re-queue only failed tasks of a finished job
 */
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json().catch(() => ({}))) as { action?: string; caseId?: string; jobId?: string; runId?: string; docIds?: string[] };
    if (!b.caseId || !b.action) return NextResponse.json({ error: 'action and caseId are required.' }, { status: 400 });
    if (!['run', 'stop', 'resume', 'retry'].includes(b.action)) return NextResponse.json({ error: 'Unknown processing action.' }, { status: 400 });
    if (b.action === 'run') {
      if (!b.runId || !/^[\w-]{4,80}$/.test(b.runId)) return NextResponse.json({ error: 'A valid runId is required.' }, { status: 400 });
    } else if (!b.jobId) return NextResponse.json({ error: 'jobId is required.' }, { status: 400 });
    const s = await svc(req);
    if (b.action !== 'stop') {
      const readiness = await queueReadiness();
      if (!readiness.ready) return NextResponse.json({ error: readiness.reason, blocker: 'worker_not_ready' }, { status: 503 });
    }
    if (b.action === 'run' && b.runId) {
      return NextResponse.json(await s.submit(b.caseId, b.runId, Array.isArray(b.docIds) ? b.docIds : undefined), { status: 202 });
    }
    if (!b.jobId) return NextResponse.json({ error: 'jobId is required.' }, { status: 400 });
    if (b.action === 'stop') return NextResponse.json(await s.stop(b.caseId, b.jobId), { status: 202 });
    if (b.action === 'resume') return NextResponse.json(await s.resume(b.caseId, b.jobId), { status: 202 });
    if (b.action === 'retry') return NextResponse.json(await s.retryFailed(b.caseId, b.jobId), { status: 202 });
    return NextResponse.json({ error: `Unknown action "${b.action}".` }, { status: 400 });
  } catch (e) { return err(e); }
}

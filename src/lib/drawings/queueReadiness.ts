import { createHash } from 'node:crypto';
import { workerConfig } from './processingAdapter';

export type QueueReadiness = { ready: boolean; reason: string | null };

/** Polls the worker without submitting work. A liveness success alone is not queue readiness. */
export async function queueReadiness(): Promise<QueueReadiness> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, '');
  if (!url || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()) return { ready: false, reason: 'Supabase is not configured in Rocket Staging. No work was queued.' };
  const c = workerConfig();
  if (!c.remote) return { ready: false, reason: 'The processing worker URL or token is missing. No work was queued.' };
  try {
    const res = await fetch(`${c.url}/ready/queue`, {
      headers: { Authorization: `Bearer ${c.token}`, 'X-PVR-Database': createHash('sha256').update(url).digest('hex') },
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 401) return { ready: false, reason: 'The processing worker rejected its connection token. No work was queued.' };
    if (res.status === 404) return { ready: false, reason: 'The processing worker is out of date. Deploy the matching worker release before queuing jobs.' };
    const b = (await res.json().catch(() => null)) as { ready?: boolean; code?: string } | null;
    if (res.ok && b?.ready === true) return { ready: true, reason: null };
    const reason = b?.code === 'wrong_project' ? 'The app and worker are configured for different Supabase projects.'
      : b?.code === 'runner_not_started' ? 'The worker is online but its background runner is not configured.'
      : b?.code === 'database_rejected' ? 'Supabase rejected the worker. Check the processing migration and the worker database secret.'
      : 'The processing worker did not confirm that it can run jobs.';
    return { ready: false, reason: `${reason} No work was queued.` };
  } catch {
    return { ready: false, reason: 'The processing worker could not be reached. No work was queued.' };
  }
}

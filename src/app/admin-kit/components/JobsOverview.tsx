'use client';

import React, { useEffect, useState } from 'react';
import Badge from '@/components/ui/Badge';
import { loadTools, type ToolCheck } from '@/lib/admin/client';
import { getAccessToken } from '@/lib/supabase/client';

interface JobRow { id: string; case_id?: string; caseId?: string; state: string; configVersion?: string; config_version?: string; updated_at?: string; updatedAt?: string; createdAt?: string; created_at?: string; lastError?: string | null; last_error?: string | null }

export default function JobsOverview() {
  const [worker, setWorker] = useState<ToolCheck | null>(null);
  const [mode, setMode] = useState<{ mode: string; workerUrlConfigured: boolean; workerTokenConfigured: boolean } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    loadTools().then((r) => setWorker(r.tools.find((t) => t.id === 'worker') ?? null)).catch((e) => setErr(e instanceof Error ? e.message : 'Unavailable.'));
    (async () => { const t = await getAccessToken(); const r = await fetch('/api/processing/jobs', { headers: t ? { Authorization: `Bearer ${t}` } : {}, cache: 'no-store' }); if (r.ok) setMode(await r.json()); })().catch(() => undefined);
  }, []);
  void ({} as JobRow);
  const connected = worker?.state === 'passed';
  return (
    <div className="space-y-4">
      <div><h1 className="text-2xl font-bold text-foreground">Background Jobs</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Drawing-processing jobs are stored in a durable database queue and consumed by an independent worker. Per-case progress, stop, resume and retry are on each case&apos;s workspace. This page reports whether the worker that would run them is actually connected.</p></div>
      {err ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{err}</p> : null}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-foreground">Processing worker</h2><Badge tone={connected ? 'success' : worker?.state === 'failed' ? 'danger' : 'warning'}>{connected ? 'Connected (tested)' : worker?.state === 'failed' ? 'Failed' : 'Not connected'}</Badge></div>
        <p className="mt-2 text-sm text-muted-foreground">{worker?.detail ?? 'Checking...'}</p>
        {mode ? <p className="mt-2 text-xs text-muted-foreground">Mode: {mode.mode}. URL configured: {mode.workerUrlConfigured ? 'yes' : 'no'}. Token configured: {mode.workerTokenConfigured ? 'yes' : 'no'}.</p> : null}
        {!connected ? <div className="mt-3 rounded-md bg-warning/15 p-3 text-sm text-foreground"><p className="font-semibold">Remaining deployment steps (externally blocked)</p><ol className="mt-1 list-decimal space-y-0.5 pl-5 text-xs"><li>Build and deploy <code>services/processing-worker</code> (Dockerfile.worker) to a long-running host.</li><li>Set the worker&apos;s environment from <code>env.worker.template.txt</code>, including its database secret and API token.</li><li>Set <code>PROCESSING_WORKER_URL</code> and <code>PROCESSING_WORKER_TOKEN</code> on this app, then re-run the check above.</li></ol></div> : null}
      </div>
    </div>
  );
}

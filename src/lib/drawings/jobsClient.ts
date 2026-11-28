'use client';

import { getAccessToken } from '@/lib/supabase/client';
import type { EventRow, JobRow, TaskRow } from '@/lib/drawings/jobService';
import type { TaskResult } from '@/lib/drawings/jobView';

async function headers(): Promise<Record<string, string>> {
  const t = await getAccessToken();
  return { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}

export interface JobSnapshot { job: JobRow; tasks: (TaskRow & { result?: TaskResult })[]; events: EventRow[]; serverTime: string }
export interface WorkerSummary { ready: boolean; reason: string | null }
type Failure = { ok: false; error: string; status: number };
type Ok<T> = { ok: true; data: T };

async function call<T>(url: string, init?: RequestInit): Promise<Ok<T> | Failure> {
  try {
    const res = await fetch(url, { cache: 'no-store', ...init, headers: { ...(await headers()), ...(init?.headers ?? {}) } });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}`, status: res.status };
    return { ok: true, data: body };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Network error', status: 0 }; }
}

const post = <T,>(b: Record<string, unknown>) => call<T>('/api/processing/jobs', { method: 'POST', body: JSON.stringify(b) });

export const jobsApi = {
  worker: () => call<WorkerSummary>('/api/processing/jobs?readiness=1'),
  list: (caseId: string) => call<{ jobs: JobRow[] }>(`/api/processing/jobs?caseId=${encodeURIComponent(caseId)}`),
  get: (caseId: string, jobId: string, since = 0, results = false) => call<JobSnapshot>(`/api/processing/jobs?caseId=${encodeURIComponent(caseId)}&jobId=${encodeURIComponent(jobId)}&since=${since}${results ? '&results=1' : ''}`),
  run: (caseId: string, runId: string, docIds?: string[]) => post<{ jobId: string; state: string; duplicate: boolean; tasks?: number; skipped: { docId: string; fileName: string; reason: string }[] }>({ action: 'run', caseId, runId, docIds }),
  stop: (caseId: string, jobId: string) => post<{ state: string; changed: boolean }>({ action: 'stop', caseId, jobId }),
  resume: (caseId: string, jobId: string) => post<{ jobId: string; reused: number; queued: number; invalidated: number }>({ action: 'resume', caseId, jobId }),
  retry: (caseId: string, jobId: string) => post<{ requeued: number; state: string }>({ action: 'retry', caseId, jobId }),
};

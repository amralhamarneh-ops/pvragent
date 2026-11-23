'use client';

import { getAccessToken } from '@/lib/supabase/client';
import type { CurrentContext, EvaluationRun, PipelineOutput, ReferenceCase, ReferencePartition, ReferenceStatus, RetrievalResult, SourceRole } from './types';

export interface LibraryResponse { cases: ReferenceCase[]; evaluations: EvaluationRun[]; leakage: { ok: boolean; issues: string[] } }

async function call<T>(init: RequestInit, url = '/api/reference-cases'): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(j.error ?? `Request failed (HTTP ${res.status}).`);
  return j;
}
const post = <T,>(body: unknown) => call<T>({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const loadLibrary = () => call<LibraryResponse>({ method: 'GET' });
export const createCase = (title: string, caseGroup: string, reviewer: string) => post<{ case: ReferenceCase }>({ action: 'create', title, caseGroup, reviewer });
export const saveRecord = (id: string, title: string, record: ReferenceCase['record'], reviewer: string) => post<{ case: ReferenceCase }>({ action: 'updateRecord', id, title, record, reviewer });
export const moveStatus = (id: string, to: ReferenceStatus, reviewer: string, note: string, evidence: string[]) => post<{ case: ReferenceCase }>({ action: 'transition', id, to, reviewer, note, evidence });
export const withdrawCase = (id: string, reviewer: string, reason: string, replacedBy: string | null) => post<{ case: ReferenceCase }>({ action: 'withdraw', id, reviewer, reason, replacedBy });
export const movePartition = (id: string, to: ReferencePartition, reviewer: string) => post<{ cases: ReferenceCase[] }>({ action: 'movePartition', id, to, reviewer });
export const retrieveLive = (query: CurrentContext, includeIneligible: boolean) => post<{ result: RetrievalResult; promptBlock: string }>({ action: 'retrieve', query, includeIneligible });
export const evaluateLive = (outputs: PipelineOutput[], actualSource: string) => post<{ run: EvaluationRun }>({ action: 'evaluate', outputs, actualSource });

export async function uploadSource(id: string, role: SourceRole, file: File): Promise<{ source: ReferenceCase['sources'][number]; reused: boolean; storageError?: string }> {
  const form = new FormData();
  form.append('id', id); form.append('role', role); form.append('file', file);
  return call({ method: 'PUT', body: form });
}

export async function inspectSource(id: string, sourceId: string): Promise<{ url: string; fileName: string }> {
  return call({ method: 'GET' }, `/api/reference-cases/${encodeURIComponent(id)}/source?sourceId=${encodeURIComponent(sourceId)}`);
}

function api(...args: any[]): any {
  // eslint-disable-next-line no-console
  console.warn('Placeholder: api is not implemented yet.', args);
  return null;
}

export default api;
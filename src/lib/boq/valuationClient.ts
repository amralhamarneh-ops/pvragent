'use client';

import { getAccessToken } from '@/lib/supabase/client';
import type { AggregationGroup, ReplacementMethod, SourceFingerprint } from './valuation';
import type { StoredDecision } from './resolutions';
import type { AssessmentItem } from './newItem';

/**
 * Client for the case-scoped valuation state. The server copy is the source of truth for a real case; the browser
 * copy remains as a fallback only when the server cannot be reached, and that fallback is reported to the caller.
 */

export interface ValuationState {
  decisions: Record<string, StoredDecision>;
  items: AssessmentItem[];
  groups: AggregationGroup[];
  replacements: { id: string; method: ReplacementMethod; by: string; at: string }[];
  fingerprint: SourceFingerprint | null;
  stale: boolean;
  staleReasons: string[];
  version: number;
}

export const EMPTY_VALUATION: ValuationState = { decisions: {}, items: [], groups: [], replacements: [], fingerprint: null, stale: false, staleReasons: [], version: 0 };

async function headers(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

const isSession = (caseId: string) => caseId.startsWith('session-');
const path = (caseId: string) => `/api/boq-cases/${encodeURIComponent(caseId)}/valuation`;

export type LoadOutcome = { ok: true; state: ValuationState; persisted: boolean } | { ok: false; error: string };

export async function loadValuation(caseId: string): Promise<LoadOutcome> {
  if (isSession(caseId)) return { ok: true, state: EMPTY_VALUATION, persisted: false };
  try {
    const res = await fetch(path(caseId), { headers: await headers(), cache: 'no-store' });
    const data = (await res.json().catch(() => ({}))) as { valuation?: Record<string, unknown> | null; error?: string };
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    const v = data.valuation;
    if (!v) return { ok: true, state: EMPTY_VALUATION, persisted: true };
    return {
      ok: true, persisted: true,
      state: {
        decisions: (v.decisions as ValuationState['decisions']) ?? {}, items: (v.items as AssessmentItem[]) ?? [], groups: (v.groups as AggregationGroup[]) ?? [],
        replacements: (v.replacements as ValuationState['replacements']) ?? [], fingerprint: (v.fingerprint as SourceFingerprint | null) ?? null,
        stale: !!v.stale, staleReasons: (v.staleReasons as string[]) ?? [], version: typeof v.version === 'number' ? v.version : 0,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not reach the server.' };
  }
}

export type SaveOutcome = { ok: true; version: number } | { ok: false; error: string; conflict: boolean };

export async function saveValuation(caseId: string, state: Omit<ValuationState, 'version'> & { version: number }): Promise<SaveOutcome> {
  if (isSession(caseId)) return { ok: false, error: 'This is a temporary case, so decisions are not saved on the server.', conflict: false };
  try {
    const res = await fetch(path(caseId), {
      method: 'PUT', headers: await headers(),
      body: JSON.stringify({ decisions: state.decisions, items: state.items, groups: state.groups, replacements: state.replacements, fingerprint: state.fingerprint, stale: state.stale, staleReasons: state.staleReasons, expectedVersion: state.version || undefined }),
    });
    const data = (await res.json().catch(() => ({}))) as { valuation?: { version?: number }; error?: string };
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}`, conflict: res.status === 409 };
    return { ok: true, version: data.valuation?.version ?? state.version + 1 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not reach the server.', conflict: false };
  }
}

export async function markValuationStale(caseId: string, reasons: string[]): Promise<void> {
  if (isSession(caseId)) return;
  try { await fetch(path(caseId), { method: 'PATCH', headers: await headers(), body: JSON.stringify({ reasons }) }); } catch { /* the stale flag is also recomputed from the fingerprint on load */ }
}

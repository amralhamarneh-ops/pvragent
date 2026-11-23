'use client';

import { getAccessToken } from '@/lib/supabase/client';
import type { AgentConfigVersion, AgentRunRecord, DeliveryRow, NotificationRuleRow } from './adminStore';
import type { AgentRules } from './rules';
import type { PlannedDelivery, ProviderStatus, WorkflowStart } from './notifications';

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string; issues?: { field: string; message: string }[] };
  if (!res.ok) {
    const detail = j.issues?.length ? ` ${j.issues.map((i) => `${i.field}: ${i.message}`).join(' ')}` : '';
    throw new Error(`${j.error ?? `Request failed (HTTP ${res.status}).`}${detail}`);
  }
  return j;
}
const post = <T,>(url: string, body: unknown) => call<T>(url, { method: 'POST', body: JSON.stringify(body) });

export interface TraceRow { id: string; status: string; files: { file: string; exists: boolean }[]; traced: boolean }
export interface ToolCheck { id: string; level: string; state: string; detail: string; testedAt?: string }
export interface AgentDetailResponse { versions: AgentConfigVersion[]; publishedVersion: number | null; runs: AgentRunRecord[]; ruleCapable: boolean; defaults: AgentRules | null; ceilings: { maxItems: number; maxCharsPerItem: number } | null }

export const loadTrace = () => call<{ trace: TraceRow[] }>('/api/admin/agents?trace=1');
export const loadAgent = (id: string) => call<AgentDetailResponse>(`/api/admin/agents?agent=${encodeURIComponent(id)}`);
export const loadRuns = () => call<{ runs: AgentRunRecord[] }>('/api/admin/agents?runs=1');
export const loadTools = () => call<{ tools: ToolCheck[] }>('/api/admin/agents?tools=1');
export const saveDraft = (agentId: string, rules: AgentRules, note: string, author: string, version?: number) => post<{ version: AgentConfigVersion }>('/api/admin/agents', { action: 'saveDraft', agentId, rules, note, author, version });
export const testVersion = (agentId: string, version: number) => post<{ version: AgentConfigVersion }>('/api/admin/agents', { action: 'test', agentId, version });
export const publishVersion = (agentId: string, version: number, by: string) => post<{ version: AgentConfigVersion }>('/api/admin/agents', { action: 'publish', agentId, version, by });
export const rollbackVersion = (agentId: string, version: number, by: string) => post<{ version: AgentConfigVersion }>('/api/admin/agents', { action: 'rollback', agentId, version, by });

export interface NotificationsResponse { rules: NotificationRuleRow[]; deliveries: DeliveryRow[]; providers: ProviderStatus[]; directory: { count: number; source: string }; events: { id: string; label: string; emittedBy: string | null }[] }
const NOTIFY = '/api/admin/notify';
export const loadNotifications = () => call<NotificationsResponse>(NOTIFY);
export const saveRule = (rule: Record<string, unknown>) => post<{ rule: NotificationRuleRow }>(NOTIFY, { action: 'save', ...rule });
export const enableRule = (id: string, enabled: boolean, by: string) => post<{ rule: NotificationRuleRow; warning: string | null }>(NOTIFY, { action: 'enable', id, enabled, by });
export const previewRule = (id: string) => post<{ planned: PlannedDelivery[]; sentToRealRecipients: number }>(NOTIFY, { action: 'preview', id });
export const testRule = (id: string) => post<{ planned: PlannedDelivery[]; recorded: { id: string; duplicate: boolean; attempts: number }[]; sentToRealRecipients: number }>(NOTIFY, { action: 'test', id, event: { ref: `manual-${Date.now()}` } });
export const emitEvent = (body: Record<string, unknown>) => post<{ matchedRules: number; mode: string; results: { name: string; deliveries: { status: string; role: string; duplicate: boolean; attempts: number; detail: string }[] }[]; sentToRealRecipients: number; note: string }>(NOTIFY, { action: 'emit', ...body });
export const startWorkflowFor = (id: string, eventType: string) => post<{ workflow: WorkflowStart }>(NOTIFY, { action: 'workflow', id, eventType });

function api(...args: any[]): any {
  // eslint-disable-next-line no-console
  console.warn('Placeholder: api is not implemented yet.', args);
  return null;
}

export default api;
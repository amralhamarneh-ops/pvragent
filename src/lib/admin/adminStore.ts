import { AccessDeniedError, StorageUnavailableError, classifyRestFailure, sanitise, toStorageError, type VerifiedUser } from '@/lib/boq/supabaseStore';
import { defaultRules, hashRules, validateRules, type AgentRules } from './rules';

export type ConfigStatus = 'draft' | 'tested' | 'published' | 'superseded';

export interface ConfigTestResult {
  at: string;
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

export interface AgentConfigVersion {
  id: string; agentId: string; version: number; status: ConfigStatus; rules: AgentRules; rulesHash: string;
  changeNote: string; author: string; testResult: ConfigTestResult | null; testedAt: string | null;
  publishedAt: string | null; publishedBy: string | null; rolledBackFrom: number | null; createdAt: string;
}

export interface AgentRunRecord {
  id: string; agentId: string; caseId: string | null; configVersion: number; configSource: string; kind: 'live' | 'test';
  status: 'completed' | 'fallback' | 'failed' | 'blocked'; model: string | null; tool: string | null; error: string | null;
  precedentIds: string[]; summary: Record<string, unknown>; durationMs: number | null; createdAt: string;
}

export interface NotificationRuleRow {
  id: string; name: string; triggerEvent: string; projectScope: string; recipientRoles: string[]; channel: string;
  templateSubject: string; templateBody: string; approvalSteps: ApprovalStep[]; reminderAfterHours: number | null;
  escalateAfterHours: number | null; esignatureAfterStep: number | null; enabled: boolean; enabledBy: string | null; enabledAt: string | null;
  createdAt: string; updatedAt: string;
}
export interface ApprovalStep { order: number; role: string; approver: string }

export interface DeliveryRow {
  id: string; ruleId: string; eventType: string; eventRef: string; caseId: string | null; recipientRole: string; recipientRef: string | null;
  channel: string; mode: 'preview' | 'test' | 'live'; status: 'previewed' | 'test_recorded' | 'sent' | 'blocked' | 'failed' | 'unresolved_recipient';
  detail: string; renderedSubject: string; renderedBody: string; idempotencyKey: string; attempts: number; createdAt: string;
}

type Row = Record<string, any>;

/** Acts AS the verified user (their JWT is forwarded; no service key). Always filters by owner_id as well as RLS. */
export class AdminStore {
  private readonly base: string;
  private readonly anonKey: string;
  private readonly user: VerifiedUser;

  constructor(url: string | undefined, anonKey: string | undefined, user: VerifiedUser) {
    if (!url || !anonKey) throw new StorageUnavailableError('not_configured', 'NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is not set on the server.');
    this.base = `${url.replace(/\/$/, '')}/rest/v1`;
    this.anonKey = anonKey;
    this.user = user;
  }

  private async req<T>(path: string, init: RequestInit & { prefer?: string } = {}): Promise<T> {
    const resource = path.split('?')[0];
    let res: Response;
    try {
      res = await fetch(`${this.base}/${path}`, { ...init, cache: 'no-store', headers: { apikey: this.anonKey, Authorization: `Bearer ${this.user.token}`, 'Content-Type': 'application/json', ...(init.prefer ? { Prefer: init.prefer } : {}), ...(init.headers ?? {}) } });
    } catch (e) {
      throw toStorageError({ code: 'network', operation: `${init.method ?? 'GET'} ${resource}`, resource, httpStatus: null, dbCode: '', message: sanitise(e instanceof Error ? e.message : 'network error'), details: '', hint: '' });
    }
    if (!res.ok) {
      const d = classifyRestFailure(`${init.method ?? 'GET'} ${resource}`, path, res.status, await res.text());
      if (d.code === 'permission_denied') throw new AccessDeniedError(403, 'You do not have access to that record.', d);
      if (d.code === 'table_missing') throw new StorageUnavailableError('tables_missing', 'The Admin Kit tables are not available. Apply supabase/migrations/20261210090000_pvr_admin_kit.sql, then retry.', d);
      if (d.code === 'rejected') throw new Error(`Database error on ${d.resource}: ${d.message}`);
      throw toStorageError(d);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  private owner() { return `owner_id=eq.${encodeURIComponent(this.user.id)}`; }

  private toVersion(r: Row): AgentConfigVersion {
    const parsed = validateRules(r.agent_id, r.rules);
    return { id: r.id, agentId: r.agent_id, version: r.version, status: r.status, rules: parsed.rules, rulesHash: r.rules_hash, changeNote: r.change_note, author: r.author, testResult: r.test_result ?? null, testedAt: r.tested_at, publishedAt: r.published_at, publishedBy: r.published_by, rolledBackFrom: r.rolled_back_from, createdAt: r.created_at };
  }

  async listVersions(agentId: string): Promise<AgentConfigVersion[]> {
    const rows = await this.req<Row[]>(`pvr_agent_configs?${this.owner()}&agent_id=eq.${encodeURIComponent(agentId)}&select=*&order=version.desc`);
    return rows.map((r) => this.toVersion(r));
  }

  async publishedVersion(agentId: string): Promise<AgentConfigVersion | null> {
    const p = await this.req<Row[]>(`pvr_agent_pointer?${this.owner()}&agent_id=eq.${encodeURIComponent(agentId)}&select=published_version`);
    const v = p[0]?.published_version as number | null | undefined;
    if (!v) return null;
    const rows = await this.req<Row[]>(`pvr_agent_configs?${this.owner()}&agent_id=eq.${encodeURIComponent(agentId)}&version=eq.${v}&select=*`);
    return rows[0] ? this.toVersion(rows[0]) : null;
  }

  async getVersion(agentId: string, version: number): Promise<AgentConfigVersion | null> {
    const rows = await this.req<Row[]>(`pvr_agent_configs?${this.owner()}&agent_id=eq.${encodeURIComponent(agentId)}&version=eq.${version}&select=*`);
    return rows[0] ? this.toVersion(rows[0]) : null;
  }

  async createDraft(agentId: string, rules: AgentRules, author: string, note: string): Promise<AgentConfigVersion> {
    const existing = await this.listVersions(agentId);
    const version = existing.reduce((m, v) => Math.max(m, v.version), 0) + 1;
    const body = { id: `cfg-${agentId}-${version}-${crypto.randomUUID().slice(0, 6)}`, owner_id: this.user.id, agent_id: agentId, version, status: 'draft', rules, rules_hash: hashRules(rules), change_note: note.slice(0, 500), author: author.slice(0, 80) || 'Admin' };
    await this.req('pvr_agent_configs', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(body) });
    return (await this.getVersion(agentId, version)) as AgentConfigVersion;
  }

  /** A draft may be edited only while it is a draft. Editing a tested version resets it to draft: the test no longer applies. */
  async updateDraft(agentId: string, version: number, rules: AgentRules, note: string): Promise<AgentConfigVersion> {
    const cur = await this.getVersion(agentId, version);
    if (!cur) throw new AccessDeniedError(404, `Version ${version} was not found.`);
    if (cur.status === 'published' || cur.status === 'superseded') throw new Error('A published or superseded version is immutable. Create a new draft instead.');
    await this.req(`pvr_agent_configs?${this.owner()}&agent_id=eq.${encodeURIComponent(agentId)}&version=eq.${version}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ rules, rules_hash: hashRules(rules), status: 'draft', test_result: null, tested_at: null, change_note: note.slice(0, 500), updated_at: new Date().toISOString() }) });
    return (await this.getVersion(agentId, version)) as AgentConfigVersion;
  }

  async recordTest(agentId: string, version: number, result: ConfigTestResult): Promise<AgentConfigVersion> {
    await this.req(`pvr_agent_configs?${this.owner()}&agent_id=eq.${encodeURIComponent(agentId)}&version=eq.${version}&status=in.(draft,tested)`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: result.ok ? 'tested' : 'draft', test_result: result, tested_at: result.at, updated_at: result.at }) });
    return (await this.getVersion(agentId, version)) as AgentConfigVersion;
  }

  /** Move the published pointer. The previous published version becomes superseded and stays readable. */
  async publish(agentId: string, version: number, by: string, rolledBackFrom: number | null = null): Promise<AgentConfigVersion> {
    const target = await this.getVersion(agentId, version);
    if (!target) throw new AccessDeniedError(404, `Version ${version} was not found.`);
    const now = new Date().toISOString();
    const current = await this.publishedVersion(agentId);
    if (current && current.version !== version) {
      await this.req(`pvr_agent_configs?${this.owner()}&agent_id=eq.${encodeURIComponent(agentId)}&version=eq.${current.version}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'superseded', updated_at: now }) });
    }
    await this.req(`pvr_agent_configs?${this.owner()}&agent_id=eq.${encodeURIComponent(agentId)}&version=eq.${version}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'published', published_at: now, published_by: by.slice(0, 80) || 'Admin', rolled_back_from: rolledBackFrom, updated_at: now }) });
    await this.req('pvr_agent_pointer?on_conflict=owner_id,agent_id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: JSON.stringify({ owner_id: this.user.id, agent_id: agentId, published_version: version, updated_at: now }) });
    return (await this.getVersion(agentId, version)) as AgentConfigVersion;
  }

  async recordRun(r: Omit<AgentRunRecord, 'id' | 'createdAt'>): Promise<void> {
    const body = { id: `run-${crypto.randomUUID().slice(0, 10)}`, owner_id: this.user.id, agent_id: r.agentId, case_id: r.caseId, config_version: r.configVersion, config_source: r.configSource, kind: r.kind, status: r.status, model: r.model, tool: r.tool, error: r.error ? r.error.slice(0, 500) : null, precedent_ids: r.precedentIds, summary: r.summary, duration_ms: r.durationMs };
    await this.req('pvr_agent_runs', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(body) });
  }

  async listRuns(agentId: string | null, limit = 50): Promise<AgentRunRecord[]> {
    const filter = agentId ? `&agent_id=eq.${encodeURIComponent(agentId)}` : '';
    const rows = await this.req<Row[]>(`pvr_agent_runs?${this.owner()}${filter}&select=*&order=created_at.desc&limit=${limit}`);
    return rows.map((r) => ({ id: r.id, agentId: r.agent_id, caseId: r.case_id, configVersion: r.config_version, configSource: r.config_source, kind: r.kind, status: r.status, model: r.model, tool: r.tool, error: r.error, precedentIds: r.precedent_ids ?? [], summary: r.summary ?? {}, durationMs: r.duration_ms, createdAt: r.created_at }));
  }

  // ---- notifications ----
  private toRule(r: Row): NotificationRuleRow {
    return { id: r.id, name: r.name, triggerEvent: r.trigger_event, projectScope: r.project_scope, recipientRoles: r.recipient_roles ?? [], channel: r.channel, templateSubject: r.template_subject, templateBody: r.template_body, approvalSteps: r.approval_steps ?? [], reminderAfterHours: r.reminder_after_hours, escalateAfterHours: r.escalate_after_hours, esignatureAfterStep: r.esignature_after_step, enabled: !!r.enabled, enabledBy: r.enabled_by, enabledAt: r.enabled_at, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  async listRules(): Promise<NotificationRuleRow[]> {
    return (await this.req<Row[]>(`pvr_notification_rules?${this.owner()}&select=*&order=created_at.desc`)).map((r) => this.toRule(r));
  }
  async getRule(id: string): Promise<NotificationRuleRow | null> {
    const rows = await this.req<Row[]>(`pvr_notification_rules?${this.owner()}&id=eq.${encodeURIComponent(id)}&select=*`);
    return rows[0] ? this.toRule(rows[0]) : null;
  }
  async saveRule(r: Omit<NotificationRuleRow, 'createdAt' | 'updatedAt'>): Promise<NotificationRuleRow> {
    const body = { id: r.id, owner_id: this.user.id, name: r.name, trigger_event: r.triggerEvent, project_scope: r.projectScope, recipient_roles: r.recipientRoles, channel: r.channel, template_subject: r.templateSubject, template_body: r.templateBody, approval_steps: r.approvalSteps, reminder_after_hours: r.reminderAfterHours, escalate_after_hours: r.escalateAfterHours, esignature_after_step: r.esignatureAfterStep, enabled: r.enabled, enabled_by: r.enabledBy, enabled_at: r.enabledAt, updated_at: new Date().toISOString() };
    await this.req('pvr_notification_rules?on_conflict=id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: JSON.stringify(body) });
    return (await this.getRule(r.id)) as NotificationRuleRow;
  }
  async listDeliveries(limit = 100): Promise<DeliveryRow[]> {
    const rows = await this.req<Row[]>(`pvr_notification_deliveries?${this.owner()}&select=*&order=created_at.desc&limit=${limit}`);
    return rows.map((r) => ({ id: r.id, ruleId: r.rule_id, eventType: r.event_type, eventRef: r.event_ref, caseId: r.case_id, recipientRole: r.recipient_role, recipientRef: r.recipient_ref, channel: r.channel, mode: r.mode, status: r.status, detail: r.detail, renderedSubject: r.rendered_subject, renderedBody: r.rendered_body, idempotencyKey: r.idempotency_key, attempts: r.attempts, createdAt: r.created_at }));
  }
  /** Insert unless the idempotency key already exists. Returns the stored row and whether it was a duplicate. */
  async recordDelivery(d: Omit<DeliveryRow, 'id' | 'createdAt' | 'attempts'>): Promise<{ row: DeliveryRow; duplicate: boolean }> {
    const existing = await this.req<Row[]>(`pvr_notification_deliveries?${this.owner()}&idempotency_key=eq.${encodeURIComponent(d.idempotencyKey)}&select=*`);
    if (existing.length) {
      const e = existing[0];
      await this.req(`pvr_notification_deliveries?${this.owner()}&idempotency_key=eq.${encodeURIComponent(d.idempotencyKey)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ attempts: (e.attempts ?? 1) + 1 }) });
      const row = (await this.listDeliveries(200)).find((x) => x.idempotencyKey === d.idempotencyKey) as DeliveryRow;
      return { row, duplicate: true };
    }
    const body = { id: `dlv-${crypto.randomUUID().slice(0, 10)}`, owner_id: this.user.id, rule_id: d.ruleId, event_type: d.eventType, event_ref: d.eventRef, case_id: d.caseId, recipient_role: d.recipientRole, recipient_ref: d.recipientRef, channel: d.channel, mode: d.mode, status: d.status, detail: d.detail, rendered_subject: d.renderedSubject, rendered_body: d.renderedBody, idempotency_key: d.idempotencyKey };
    await this.req('pvr_notification_deliveries', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(body) });
    const row = (await this.listDeliveries(200)).find((x) => x.idempotencyKey === d.idempotencyKey) as DeliveryRow;
    return { row, duplicate: false };
  }
}

export { defaultRules };

/**
 * Resolve the config a new run should use. Never throws: if the Admin Kit tables are unavailable the run uses the
 * built-in rules (version 0, source "built_in") and says so. A running job keeps whatever it resolved at start.
 */
export interface ResolvedConfig { version: number; source: 'published' | 'built_in'; rules: AgentRules | null; note: string }

export async function resolveConfig(store: AdminStore | null, agentId: string): Promise<ResolvedConfig> {
  if (!store) return { version: 0, source: 'built_in', rules: null, note: 'Admin Kit storage not reachable; built-in rules used.' };
  try {
    const v = await store.publishedVersion(agentId);
    if (!v) return { version: 0, source: 'built_in', rules: null, note: 'No published version; built-in rules used.' };
    const check = validateRules(agentId, v.rules);
    if (!check.ok) return { version: 0, source: 'built_in', rules: null, note: `Published version ${v.version} failed validation at run time; built-in rules used.` };
    return { version: v.version, source: 'published', rules: v.rules, note: `Published version ${v.version}.` };
  } catch (e) {
    return { version: 0, source: 'built_in', rules: null, note: `Configuration unavailable (${e instanceof Error ? e.message.slice(0, 80) : 'error'}); built-in rules used.` };
  }
}

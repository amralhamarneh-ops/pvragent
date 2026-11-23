/**
 * Notification and workflow logic. Pure functions: nothing here sends anything.
 *
 * Honest by construction:
 *  - Recipients are resolved ONLY from an authorised directory passed in by the caller. This project has no project/team
 *    membership table, so the directory is empty and every role is reported "unresolved". Addresses are never guessed.
 *  - Preview and test modes never call a provider. Live mode is blocked unless the rule is explicitly enabled AND a
 *    provider is connected. No provider is connected in this project.
 *  - A delivery is keyed by (rule, event, recipient role/ref, mode), so a retry cannot create a second notification.
 */

export const LIFECYCLE_EVENTS: { id: string; label: string; emittedBy: string | null }[] = [
  { id: 'pvr.submitted', label: 'PVR submitted', emittedBy: null },
  { id: 'analysis.completed', label: 'Analysis job completed', emittedBy: 'services/processing-worker (job state completed)' },
  { id: 'analysis.failed', label: 'Analysis job failed', emittedBy: 'services/processing-worker (job state failed)' },
  { id: 'assessment.ready_for_review', label: 'Assessment ready for review', emittedBy: null },
  { id: 'approval.requested', label: 'Approval requested', emittedBy: null },
  { id: 'approval.overdue', label: 'Approval overdue', emittedBy: null },
];

export const CHANNELS = ['email', 'chat', 'webhook', 'in_app'] as const;
export type Channel = (typeof CHANNELS)[number];

export const ROLES = ['Commercial Manager', 'Project Manager', 'Planner', 'Quantity Surveyor', 'Contracts Manager', 'Director'] as const;

export interface ProviderStatus { channel: Channel; connected: boolean; detail: string }

/** Reports only what is actually configured. No provider SDK is installed in this project. */
export function providerStatuses(env: Record<string, string | undefined>): ProviderStatus[] {
  return [
    { channel: 'email', connected: false, detail: 'No email provider is installed or configured. Delivery is blocked.' + (env.SENDGRID_API_KEY ? ' A key is present but no sender code exists, so it is not connected.' : '') },
    { channel: 'chat', connected: false, detail: 'No chat provider is installed or configured.' },
    { channel: 'webhook', connected: false, detail: 'No outbound webhook sender is implemented.' },
    { channel: 'in_app', connected: false, detail: 'No in-app notification inbox exists.' },
  ];
}

export interface DirectoryEntry { role: string; ref: string; displayName: string; address: string | null; projectIds: string[] }

/**
 * The authorised project/team directory. This project has no membership table, so there is nothing to resolve from.
 * When one is added, only this function changes.
 */
export function loadDirectory(): { entries: DirectoryEntry[]; source: string } {
  return { entries: [], source: 'No project/team membership records exist in this application.' };
}

export interface Resolution { role: string; resolved: DirectoryEntry[]; reason: string }

export function resolveRecipients(roles: string[], projectId: string | null, dir: DirectoryEntry[]): Resolution[] {
  return roles.map((role) => {
    const matches = dir.filter((d) => d.role === role && d.address && (projectId == null || d.projectIds.includes(projectId)));
    return matches.length
      ? { role, resolved: matches, reason: `${matches.length} authorised recipient(s) found.` }
      : { role, resolved: [], reason: `No authorised ${role} is recorded${projectId ? ` for project ${projectId}` : ''}. No address is guessed.` };
  });
}

export function renderTemplate(tpl: string, vars: Record<string, string>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k: string) => {
    if (k in vars) return vars[k];
    missing.push(k);
    return `[${k} missing]`;
  });
  return { text, missing };
}

export const TEMPLATE_VARIABLES = ['pvr.reference', 'pvr.title', 'project.name', 'event.label', 'job.id', 'link'];

export type Mode = 'preview' | 'test' | 'live';

export interface RuleLike {
  id: string; triggerEvent: string; recipientRoles: string[]; channel: string; templateSubject: string; templateBody: string;
  enabled: boolean; approvalSteps: { order: number; role: string; approver: string }[]; esignatureAfterStep: number | null;
}

export interface PlannedDelivery {
  recipientRole: string; recipientRef: string | null; status: 'previewed' | 'test_recorded' | 'sent' | 'blocked' | 'failed' | 'unresolved_recipient';
  detail: string; subject: string; body: string; idempotencyKey: string;
}

export function idempotencyKey(ruleId: string, eventType: string, eventRef: string, role: string, ref: string | null, mode: Mode): string {
  return [ruleId, eventType, eventRef, role, ref ?? 'unresolved', mode].map((s) => s.replace(/[|\s]+/g, '_')).join('|');
}

/**
 * Plan deliveries for one event. In preview/test mode nothing leaves the system. In live mode a delivery is only
 * attempted if the rule is enabled and the channel's provider is connected; otherwise it is recorded as blocked.
 */
export function planDeliveries(rule: RuleLike, event: { type: string; ref: string; vars: Record<string, string>; projectId: string | null }, mode: Mode, directory: DirectoryEntry[], providers: ProviderStatus[]): PlannedDelivery[] {
  const subj = renderTemplate(rule.templateSubject, event.vars);
  const body = renderTemplate(rule.templateBody, event.vars);
  const provider = providers.find((p) => p.channel === rule.channel);
  const out: PlannedDelivery[] = [];
  for (const res of resolveRecipients(rule.recipientRoles, event.projectId, directory)) {
    const targets: (DirectoryEntry | null)[] = res.resolved.length ? res.resolved : [null];
    for (const t of targets) {
      const key = idempotencyKey(rule.id, event.type, event.ref, res.role, t?.ref ?? null, mode);
      const common = { recipientRole: res.role, recipientRef: t?.ref ?? null, subject: subj.text, body: body.text, idempotencyKey: key };
      if (!t) { out.push({ ...common, status: 'unresolved_recipient', detail: res.reason }); continue; }
      if (mode === 'preview') { out.push({ ...common, status: 'previewed', detail: `Preview only. Would go to ${t.displayName} by ${rule.channel}. Nothing was sent.` }); continue; }
      if (mode === 'test') { out.push({ ...common, status: 'test_recorded', detail: 'Test notification recorded. Nothing was sent to the real recipient.' }); continue; }
      if (!rule.enabled) { out.push({ ...common, status: 'blocked', detail: 'Live delivery is not enabled for this rule.' }); continue; }
      if (!provider?.connected) { out.push({ ...common, status: 'blocked', detail: provider?.detail ?? 'The channel has no connected provider.' }); continue; }
      out.push({ ...common, status: 'blocked', detail: 'Provider is connected but no sender is implemented in this build.' });
    }
  }
  if (rule.recipientRoles.length === 0) out.push({ recipientRole: '(none)', recipientRef: null, status: 'unresolved_recipient', detail: 'The rule names no recipient roles.', subject: subj.text, body: body.text, idempotencyKey: idempotencyKey(rule.id, event.type, event.ref, 'none', null, mode) });
  return out;
}

export interface RuleIssue { field: string; message: string }

export function validateNotificationRule(r: Partial<RuleLike> & { name?: string }): RuleIssue[] {
  const issues: RuleIssue[] = [];
  if (!r.name?.trim()) issues.push({ field: 'name', message: 'A name is required.' });
  if (!LIFECYCLE_EVENTS.some((e) => e.id === r.triggerEvent)) issues.push({ field: 'triggerEvent', message: 'Choose a defined lifecycle event.' });
  if (!r.recipientRoles?.length) issues.push({ field: 'recipientRoles', message: 'Choose at least one recipient role.' });
  if (!CHANNELS.includes(r.channel as Channel)) issues.push({ field: 'channel', message: 'Choose a delivery channel.' });
  if (!r.templateSubject?.trim() || !r.templateBody?.trim()) issues.push({ field: 'template', message: 'Subject and body are required.' });
  const steps = r.approvalSteps ?? [];
  steps.forEach((s, i) => { if (!s.role?.trim() || !s.approver?.trim()) issues.push({ field: `approvalSteps.${i}`, message: `Approval step ${i + 1} needs a role and a named authorised approver.` }); });
  if (r.esignatureAfterStep != null) {
    if (steps.length === 0) issues.push({ field: 'esignatureAfterStep', message: 'An e-signature step needs at least one approval step before it.' });
    else if (r.esignatureAfterStep < steps.length) issues.push({ field: 'esignatureAfterStep', message: 'E-signature must come after the final required approval.' });
  }
  return issues;
}

/**
 * Workflow start for a lifecycle event. It creates an APPROVAL REQUEST in "pending" state and never approves,
 * certifies or signs anything: those remain decisions by named, authorised people.
 */
export interface WorkflowStart { started: boolean; state: 'approval_pending' | 'not_configured'; vo: 'not_approved'; steps: { order: number; role: string; approver: string; state: 'pending' }[]; note: string }

export function startWorkflow(rule: RuleLike, eventType: string): WorkflowStart {
  const steps = [...rule.approvalSteps].sort((a, b) => a.order - b.order).map((s) => ({ ...s, state: 'pending' as const }));
  if (eventType !== rule.triggerEvent) return { started: false, state: 'not_configured', vo: 'not_approved', steps: [], note: `This rule is triggered by ${rule.triggerEvent}, not ${eventType}.` };
  if (!steps.length) return { started: false, state: 'not_configured', vo: 'not_approved', steps: [], note: 'No approval steps are configured, so no workflow was started.' };
  return { started: true, state: 'approval_pending', vo: 'not_approved', steps, note: `Approval routing started with ${steps.length} pending step(s). The VO is not approved or certified; each step needs its named approver${rule.esignatureAfterStep != null ? `, and the e-signature step comes only after step ${rule.esignatureAfterStep}` : ''}.` };
}

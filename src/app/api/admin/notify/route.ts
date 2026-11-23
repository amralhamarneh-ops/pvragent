import { NextRequest, NextResponse } from 'next/server';
import { failureResponse, verifyUser } from '@/lib/boq/supabaseStore';
import { AdminStore, type ApprovalStep, type NotificationRuleRow } from '@/lib/admin/adminStore';
import { LIFECYCLE_EVENTS, loadDirectory, planDeliveries, providerStatuses, startWorkflow, validateNotificationRule, type Mode } from '@/lib/admin/notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const URL_ = () => process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY_ = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const fail = (e: unknown) => { const f = failureResponse(e); return NextResponse.json(f.body, { status: f.status }); };
const bad = (error: string, status = 400, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status });
async function storeFor(req: NextRequest) { const u = await verifyUser(req.headers.get('authorization'), URL_(), KEY_()); return new AdminStore(URL_(), KEY_(), u); }

/** GET -> rules, deliveries, provider status, directory source, lifecycle events. */
export async function GET(req: NextRequest) {
  try {
    const s = await storeFor(req);
    const [rules, deliveries] = await Promise.all([s.listRules(), s.listDeliveries(100)]);
    const dir = loadDirectory();
    return NextResponse.json({ rules, deliveries, providers: providers(), directory: { count: dir.entries.length, source: dir.source }, events: LIFECYCLE_EVENTS });
  } catch (e) { return fail(e); }
}

function clean(b: Record<string, unknown>, id: string, prev: NotificationRuleRow | null): Omit<NotificationRuleRow, 'createdAt' | 'updatedAt'> {
  const steps: ApprovalStep[] = (Array.isArray(b.approvalSteps) ? (b.approvalSteps as { role?: unknown; approver?: unknown }[]) : []).map((s, i) => ({ order: i + 1, role: String(s.role ?? '').slice(0, 80), approver: String(s.approver ?? '').slice(0, 120) }));
  const hours = (v: unknown) => (v === null || v === '' || v === undefined ? null : Math.max(1, Math.min(24 * 60, Math.round(Number(v)))));
  return {
    id, name: String(b.name ?? '').slice(0, 120), triggerEvent: String(b.triggerEvent ?? ''), projectScope: String(b.projectScope ?? 'all').slice(0, 120),
    recipientRoles: (Array.isArray(b.recipientRoles) ? b.recipientRoles : []).map(String).slice(0, 12), channel: String(b.channel ?? 'email'),
    templateSubject: String(b.templateSubject ?? '').slice(0, 300), templateBody: String(b.templateBody ?? '').slice(0, 4000), approvalSteps: steps,
    reminderAfterHours: hours(b.reminderAfterHours), escalateAfterHours: hours(b.escalateAfterHours),
    esignatureAfterStep: b.esignatureAfterStep === null || b.esignatureAfterStep === '' || b.esignatureAfterStep === undefined ? null : Number(b.esignatureAfterStep),
    // Enablement is only ever changed by the explicit "enable" action, never by saving the form.
    enabled: prev?.enabled ?? false, enabledBy: prev?.enabledBy ?? null, enabledAt: prev?.enabledAt ?? null,
  };
}

type Planned = ReturnType<typeof planDeliveries>[number];
const toDelivery = (ruleId: string, channel: string, eventType: string, eventRef: string, caseId: string | null, mode: Mode, p: Planned) => ({
  ruleId, eventType, eventRef, caseId, recipientRole: p.recipientRole, recipientRef: p.recipientRef, channel, mode, status: p.status,
  detail: p.detail, renderedSubject: p.subject, renderedBody: p.body, idempotencyKey: p.idempotencyKey,
});

/**
 * POST { action }:
 *   save     { id?, ...rule }             validate and store. Never changes `enabled`.
 *   enable   { id, enabled, by }          the only way live delivery is switched on or off
 *   preview  { id, event }                render only; nothing is recorded as sent
 *   test     { id, event }                records test deliveries; nothing reaches a real recipient
 *   emit     { eventType, eventRef, ... } emit a lifecycle event to all matching rules, in test mode by default
 *   workflow { id, eventType }            start approval routing; never approves
 */
export async function POST(req: NextRequest) {
  try {
    const s = await storeFor(req);
    const b = (await req.json()) as Record<string, unknown>;
    const action = String(b.action ?? '');

    if (action === 'save') {
      const prev = b.id ? await s.getRule(String(b.id)) : null;
      const id = prev?.id ?? `nr-${crypto.randomUUID().slice(0, 8)}`;
      const row = clean(b, id, prev);
      const issues = validateNotificationRule(row);
      if (issues.length) return bad('The rule did not pass validation.', 422, { issues });
      return NextResponse.json({ rule: await s.saveRule(row) });
    }

    if (action === 'enable') {
      const r = await s.getRule(String(b.id));
      if (!r) return bad('Rule not found.', 404);
      const enabled = b.enabled === true;
      if (enabled) {
        const tested = (await s.listDeliveries(200)).some((d) => d.ruleId === r.id && d.mode === 'test');
        if (!tested) return bad('Run a test notification for this rule before enabling live delivery.', 409);
      }
      const saved = await s.saveRule({ ...r, enabled, enabledBy: enabled ? String(b.by ?? 'Admin').slice(0, 80) : null, enabledAt: enabled ? new Date().toISOString() : null });
      const connected = providers().find((p) => p.channel === saved.channel)?.connected;
      return NextResponse.json({ rule: saved, warning: enabled && !connected ? `Enabled, but the ${saved.channel} channel has no connected provider, so live deliveries will be recorded as blocked.` : null });
    }

    if (action === 'preview' || action === 'test') {
      const r = await s.getRule(String(b.id));
      if (!r) return bad('Rule not found.', 404);
      const mode: Mode = action === 'preview' ? 'preview' : 'test';
      const ev = (b.event ?? {}) as { ref?: string; projectId?: string; vars?: Record<string, string> };
      const event = { type: r.triggerEvent, ref: String(ev.ref ?? 'sample-event'), vars: { 'pvr.reference': 'PVR-SAMPLE', 'pvr.title': 'Sample PVR', 'project.name': 'Sample project', 'event.label': LIFECYCLE_EVENTS.find((e) => e.id === r.triggerEvent)?.label ?? r.triggerEvent, 'job.id': 'job-sample', link: '/project-cases', ...(ev.vars ?? {}) }, projectId: ev.projectId ?? null };
      const planned = planDeliveries(r, event, mode, loadDirectory().entries, providers());
      const stored = mode === 'test' ? await Promise.all(planned.map((p) => s.recordDelivery(toDelivery(r.id, r.channel, event.type, event.ref, null, mode, p)))) : [];
      return NextResponse.json({ mode, planned, recorded: stored.map((x) => ({ id: x.row.id, duplicate: x.duplicate, attempts: x.row.attempts })), sentToRealRecipients: 0 });
    }

    if (action === 'emit') {
      const type = String(b.eventType ?? ''); const ref = String(b.eventRef ?? '');
      if (!LIFECYCLE_EVENTS.some((e) => e.id === type)) return bad('Unknown lifecycle event.');
      if (!ref) return bad('eventRef is required so retries can be recognised.');
      const mode: Mode = b.live === true ? 'live' : 'test';
      const vars = { 'pvr.reference': String(b.pvrReference ?? ref), 'pvr.title': String(b.pvrTitle ?? ''), 'project.name': String(b.projectName ?? ''), 'event.label': LIFECYCLE_EVENTS.find((e) => e.id === type)?.label ?? type, 'job.id': String(b.jobId ?? ''), link: String(b.link ?? '') };
      const rules = (await s.listRules()).filter((r) => r.triggerEvent === type);
      const results = [];
      for (const r of rules) {
        const planned = planDeliveries(r, { type, ref, vars, projectId: b.projectId ? String(b.projectId) : null }, mode, loadDirectory().entries, providers());
        const rec = await Promise.all(planned.map((p) => s.recordDelivery(toDelivery(r.id, r.channel, type, ref, b.caseId ? String(b.caseId) : null, mode, p))));
        results.push({ ruleId: r.id, name: r.name, deliveries: rec.map((x) => ({ status: x.row.status, role: x.row.recipientRole, duplicate: x.duplicate, attempts: x.row.attempts, detail: x.row.detail })) });
      }
      return NextResponse.json({ eventType: type, mode, matchedRules: rules.length, results, sentToRealRecipients: 0, note: rules.length ? '' : 'No notification rule is configured for this event.' });
    }

    if (action === 'workflow') {
      const r = await s.getRule(String(b.id));
      if (!r) return bad('Rule not found.', 404);
      return NextResponse.json({ workflow: startWorkflow(r, String(b.eventType ?? r.triggerEvent)) });
    }

    return bad('Unknown action.');
  } catch (e) { return fail(e); }
}

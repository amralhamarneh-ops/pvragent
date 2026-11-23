'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Badge from '@/components/ui/Badge';
import * as api from '@/lib/admin/client';
import { CHANNELS, ROLES, TEMPLATE_VARIABLES, type PlannedDelivery, type WorkflowStart } from '@/lib/admin/notifications';
import type { NotificationRuleRow } from '@/lib/admin/adminStore';

interface Form { id?: string; name: string; triggerEvent: string; projectScope: string; recipientRoles: string[]; channel: string; templateSubject: string; templateBody: string; approvalSteps: { role: string; approver: string }[]; reminderAfterHours: string; escalateAfterHours: string; esignatureAfterStep: string }
const blank = (): Form => ({ name: '', triggerEvent: 'analysis.completed', projectScope: 'all', recipientRoles: [], channel: 'email', templateSubject: '{{event.label}}: {{pvr.reference}}', templateBody: '{{pvr.title}} on {{project.name}}: {{event.label}}. Open: {{link}}', approvalSteps: [], reminderAfterHours: '', escalateAfterHours: '', esignatureAfterStep: '' });
const fromRule = (r: NotificationRuleRow): Form => ({ id: r.id, name: r.name, triggerEvent: r.triggerEvent, projectScope: r.projectScope, recipientRoles: r.recipientRoles, channel: r.channel, templateSubject: r.templateSubject, templateBody: r.templateBody, approvalSteps: r.approvalSteps.map((s) => ({ role: s.role, approver: s.approver })), reminderAfterHours: r.reminderAfterHours?.toString() ?? '', escalateAfterHours: r.escalateAfterHours?.toString() ?? '', esignatureAfterStep: r.esignatureAfterStep?.toString() ?? '' });
const dTone = (s: string) => (s === 'sent' ? 'success' : s === 'failed' ? 'danger' : s === 'blocked' || s === 'unresolved_recipient' ? 'warning' : 'info') as 'success' | 'danger' | 'warning' | 'info';

export default function NotificationsAdmin() {
  const [data, setData] = useState<api.NotificationsResponse | null>(null);
  const [form, setForm] = useState<Form>(blank());
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [planned, setPlanned] = useState<{ title: string; items: PlannedDelivery[] } | null>(null);
  const [wf, setWf] = useState<WorkflowStart | null>(null);
  const [by, setBy] = useState('Admin');
  const [emitResult, setEmitResult] = useState('');

  const reload = useCallback(async () => { try { setData(await api.loadNotifications()); setErr(''); } catch (e) { setErr(e instanceof Error ? e.message : 'Unavailable.'); } }, []);
  useEffect(() => { void reload(); }, [reload]);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(''); setMsg(''); try { await fn(); await reload(); } catch (e) { setErr(e instanceof Error ? e.message : 'Failed.'); } finally { setBusy(false); } };
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="space-y-5">
      <div><h1 className="text-2xl font-bold text-foreground">Notifications &amp; Workflows</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Define who is told what, and when, and the approval route a PVR follows. Preview and test never reach real recipients. Live delivery needs the rule to be explicitly enabled and a connected provider. Submitting a PVR can start approval routing; it never approves or certifies a VO.</p></div>
      {err ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{err}</p> : null}
      {msg ? <p role="status" className="rounded-md bg-success/10 px-4 py-2 text-sm text-foreground">{msg}</p> : null}

      {data ? (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-border bg-card p-4"><h2 className="text-sm font-semibold text-foreground">Delivery providers</h2>
            <ul className="mt-2 space-y-1 text-sm">{data.providers.map((p) => <li key={p.channel} className="flex items-start gap-2"><Badge tone={p.connected ? 'success' : 'warning'}>{p.channel}: {p.connected ? 'connected' : 'not configured'}</Badge><span className="text-xs text-muted-foreground">{p.detail}</span></li>)}</ul></div>
          <div className="rounded-lg border border-border bg-card p-4"><h2 className="text-sm font-semibold text-foreground">Recipient directory</h2>
            <p className="mt-2 text-sm text-muted-foreground">{data.directory.count} authorised recipient(s). {data.directory.source}</p>
            <p className="mt-2 text-xs text-muted-foreground">Recipients are resolved only from authorised project/team records. Addresses are never guessed, so unresolved roles are recorded as unresolved.</p></div>
        </div>
      ) : null}

      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold text-foreground">{form.id ? 'Edit rule' : 'New rule'}</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="text-xs font-semibold text-muted-foreground">Name<input value={form.name} onChange={(e) => set('name', e.target.value)} className="mt-1 w-full rounded-md border border-border bg-background p-2 text-sm font-normal" /></label>
          <label className="text-xs font-semibold text-muted-foreground">Trigger event<select value={form.triggerEvent} onChange={(e) => set('triggerEvent', e.target.value)} className="mt-1 w-full rounded-md border border-border bg-background p-2 text-sm font-normal">{(data?.events ?? []).map((e) => <option key={e.id} value={e.id}>{e.label}{e.emittedBy ? '' : ' (no emitter built yet)'}</option>)}</select></label>
          <label className="text-xs font-semibold text-muted-foreground">Project scope<input value={form.projectScope} onChange={(e) => set('projectScope', e.target.value)} className="mt-1 w-full rounded-md border border-border bg-background p-2 text-sm font-normal" placeholder="all, or a project id" /></label>
          <label className="text-xs font-semibold text-muted-foreground">Delivery channel<select value={form.channel} onChange={(e) => set('channel', e.target.value)} className="mt-1 w-full rounded-md border border-border bg-background p-2 text-sm font-normal">{CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
        </div>
        <fieldset className="mt-3"><legend className="text-xs font-semibold text-muted-foreground">Recipient roles</legend>
          <div className="mt-1 flex flex-wrap gap-3">{ROLES.map((r) => <label key={r} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={form.recipientRoles.includes(r)} onChange={(e) => set('recipientRoles', e.target.checked ? [...form.recipientRoles, r] : form.recipientRoles.filter((x) => x !== r))} />{r}</label>)}</div></fieldset>
        <label className="mt-3 block text-xs font-semibold text-muted-foreground">Message subject<input value={form.templateSubject} onChange={(e) => set('templateSubject', e.target.value)} className="mt-1 w-full rounded-md border border-border bg-background p-2 text-sm font-normal" /></label>
        <label className="mt-3 block text-xs font-semibold text-muted-foreground">Message body<textarea rows={3} value={form.templateBody} onChange={(e) => set('templateBody', e.target.value)} className="mt-1 w-full rounded-md border border-border bg-background p-2 text-sm font-normal" /></label>
        <p className="mt-1 text-xs text-muted-foreground">Variables: {TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(' ')}</p>

        <div className="mt-3"><div className="flex items-center justify-between"><h3 className="text-xs font-semibold text-muted-foreground">Approval steps (in order)</h3><button type="button" onClick={() => set('approvalSteps', [...form.approvalSteps, { role: '', approver: '' }])} className="rounded border border-border px-2 py-1 text-xs">Add step</button></div>
          {form.approvalSteps.map((s, i) => (<div key={i} className="mt-2 grid gap-2 sm:grid-cols-[2rem_1fr_1fr_auto]"><span className="pt-2 text-sm font-semibold">{i + 1}</span>
            <input aria-label={`Step ${i + 1} role`} placeholder="Role, e.g. Commercial Manager" value={s.role} onChange={(e) => set('approvalSteps', form.approvalSteps.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))} className="rounded-md border border-border bg-background p-2 text-sm" />
            <input aria-label={`Step ${i + 1} authorised approver`} placeholder="Named authorised approver" value={s.approver} onChange={(e) => set('approvalSteps', form.approvalSteps.map((x, j) => (j === i ? { ...x, approver: e.target.value } : x)))} className="rounded-md border border-border bg-background p-2 text-sm" />
            <button type="button" onClick={() => set('approvalSteps', form.approvalSteps.filter((_, j) => j !== i))} className="rounded border border-border px-2 text-xs">Remove</button></div>))}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="text-xs font-semibold text-muted-foreground">Reminder after (hours)<input type="number" min={1} value={form.reminderAfterHours} onChange={(e) => set('reminderAfterHours', e.target.value)} className="mt-1 w-full rounded-md border border-border bg-background p-2 text-sm font-normal" /></label>
          <label className="text-xs font-semibold text-muted-foreground">Escalate after (hours)<input type="number" min={1} value={form.escalateAfterHours} onChange={(e) => set('escalateAfterHours', e.target.value)} className="mt-1 w-full rounded-md border border-border bg-background p-2 text-sm font-normal" /></label>
          <label className="text-xs font-semibold text-muted-foreground">E-signature after step<input type="number" min={1} value={form.esignatureAfterStep} onChange={(e) => set('esignatureAfterStep', e.target.value)} className="mt-1 w-full rounded-md border border-border bg-background p-2 text-sm font-normal" /></label>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Reminder and escalation timings are stored but no scheduler runs them yet. The e-signature step is a recorded requirement only; no e-signature provider is integrated.</p>
        <div className="mt-3 flex gap-2">
          <button type="button" disabled={busy} onClick={() => run(async () => { const r = await api.saveRule({ ...form, reminderAfterHours: form.reminderAfterHours || null, escalateAfterHours: form.escalateAfterHours || null, esignatureAfterStep: form.esignatureAfterStep || null }); setForm(fromRule(r.rule)); setMsg('Rule saved. Saving never enables live delivery.'); })} className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Save rule</button>
          {form.id ? <button type="button" onClick={() => setForm(blank())} className="rounded-md border border-border px-3 py-2 text-sm">New rule</button> : null}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card"><table className="w-full text-left text-sm">
        <thead className="bg-muted text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">Rule</th><th className="px-3 py-2">Trigger</th><th className="px-3 py-2">Roles / channel</th><th className="px-3 py-2">Live delivery</th><th className="px-3 py-2">Actions</th></tr></thead>
        <tbody>
          {data && data.rules.length === 0 ? <tr><td colSpan={5} className="px-3 py-4 text-muted-foreground">No rules yet.</td></tr> : null}
          {data?.rules.map((r) => (<tr key={r.id} className="border-t border-border align-top">
            <td className="px-3 py-2 font-semibold">{r.name}</td><td className="px-3 py-2 text-xs">{r.triggerEvent}</td><td className="px-3 py-2 text-xs">{r.recipientRoles.join(', ')} · {r.channel}</td>
            <td className="px-3 py-2">{r.enabled ? <Badge tone="warning">Enabled by {r.enabledBy}</Badge> : <Badge tone="neutral">Not enabled</Badge>}</td>
            <td className="px-3 py-2"><div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => setForm(fromRule(r))} className="rounded border border-border px-2 py-1 text-xs">Edit</button>
              <button type="button" disabled={busy} onClick={() => run(async () => { const p = await api.previewRule(r.id); setPlanned({ title: `Preview: ${r.name}`, items: p.planned }); })} className="rounded border border-border px-2 py-1 text-xs">Preview</button>
              <button type="button" disabled={busy} onClick={() => run(async () => { const p = await api.testRule(r.id); setPlanned({ title: `Test recorded: ${r.name} (sent to real recipients: ${p.sentToRealRecipients})`, items: p.planned }); })} className="rounded border border-border px-2 py-1 text-xs">Send test</button>
              <button type="button" disabled={busy} onClick={() => run(async () => { const w = await api.startWorkflowFor(r.id, r.triggerEvent); setWf(w.workflow); })} className="rounded border border-border px-2 py-1 text-xs">Start workflow (test)</button>
              <button type="button" disabled={busy} onClick={() => run(async () => { const e = await api.enableRule(r.id, !r.enabled, by); setMsg(e.warning ?? (e.rule.enabled ? 'Live delivery enabled.' : 'Live delivery disabled.')); })} className="rounded bg-warning px-2 py-1 text-xs font-semibold text-foreground">{r.enabled ? 'Disable live' : 'Enable live'}</button>
            </div></td></tr>))}
        </tbody></table></div>
      <label className="block text-xs font-semibold text-muted-foreground">Name recorded when enabling live delivery<input value={by} onChange={(e) => setBy(e.target.value)} className="mt-1 w-64 rounded-md border border-border bg-background p-2 text-sm font-normal" /></label>

      {planned ? (<div className="rounded-lg border border-border bg-card p-4"><h2 className="text-sm font-semibold text-foreground">{planned.title}</h2>
        <ul className="mt-2 space-y-2 text-sm">{planned.items.map((p) => <li key={p.idempotencyKey} className="rounded border border-border p-2"><div className="flex items-center gap-2"><Badge tone={dTone(p.status)}>{p.status}</Badge><span className="font-semibold">{p.recipientRole}</span></div><p className="mt-1 text-xs text-muted-foreground">{p.detail}</p><p className="mt-1 text-xs"><strong>{p.subject}</strong> — {p.body}</p></li>)}</ul></div>) : null}

      {wf ? (<div className="rounded-lg border border-border bg-card p-4"><h2 className="text-sm font-semibold text-foreground">Workflow result</h2><p className="mt-1 text-sm">State: <Badge tone={wf.started ? 'info' : 'warning'}>{wf.state}</Badge> VO: <Badge tone="neutral">{wf.vo}</Badge></p><p className="mt-1 text-xs text-muted-foreground">{wf.note}</p>
        <ol className="mt-2 list-decimal pl-5 text-sm">{wf.steps.map((s) => <li key={s.order}>{s.role} — {s.approver} <Badge tone="warning">{s.state}</Badge></li>)}</ol></div>) : null}

      <div className="rounded-lg border border-border bg-card p-4"><h2 className="text-sm font-semibold text-foreground">Emit a lifecycle event (test mode)</h2>
        <p className="mt-1 text-xs text-muted-foreground">Sends the event to every matching rule in test mode. Repeating the same event reference is recognised as a retry and does not create a second notification.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => run(async () => { const r = await api.emitEvent({ eventType: 'analysis.completed', eventRef: 'demo-job-1', jobId: 'demo-job-1', pvrReference: 'PVR-DEMO' }); setEmitResult(JSON.stringify({ matchedRules: r.matchedRules, mode: r.mode, sentToRealRecipients: r.sentToRealRecipients, results: r.results, note: r.note }, null, 1)); })} className="rounded-md border border-border px-3 py-2 text-sm">Emit &quot;Analysis job completed&quot; for demo-job-1</button>
        </div>
        {emitResult ? <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{emitResult}</pre> : null}</div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card"><h2 className="px-3 pt-3 text-sm font-semibold text-foreground">Delivery log</h2><table className="w-full text-left text-sm">
        <thead className="bg-muted text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Event</th><th className="px-3 py-2">Role</th><th className="px-3 py-2">Mode</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Attempts</th><th className="px-3 py-2">Detail</th></tr></thead>
        <tbody>{data && data.deliveries.length === 0 ? <tr><td colSpan={7} className="px-3 py-4 text-muted-foreground">No deliveries recorded.</td></tr> : null}
          {data?.deliveries.map((d) => (<tr key={d.id} className="border-t border-border align-top"><td className="px-3 py-2 text-xs">{d.createdAt.slice(0, 19).replace('T', ' ')}</td><td className="px-3 py-2 text-xs">{d.eventType} · {d.eventRef}</td><td className="px-3 py-2 text-xs">{d.recipientRole}</td><td className="px-3 py-2 text-xs">{d.mode}</td><td className="px-3 py-2"><Badge tone={dTone(d.status)}>{d.status}</Badge></td><td className="px-3 py-2 text-xs">{d.attempts}</td><td className="px-3 py-2 text-xs text-muted-foreground">{d.detail}</td></tr>))}</tbody></table></div>
    </div>
  );
}

'use client';

import React, { useState } from 'react';
import { ExternalLink, Upload, X } from 'lucide-react';
import Badge from '@/components/ui/Badge';
import * as api from '@/lib/reference/client';
import { SOURCE_ROLES, STATUS_LABEL, type LearningRecord, type ReferenceCase, type SourceRole } from '@/lib/reference/types';

interface Props {
  c: ReferenceCase; live: boolean; busy: boolean; uploadRole: SourceRole; setUploadRole: (r: SourceRole) => void; uploadMsg: string;
  onClose: () => void; onPick: () => void; onSave: (r: LearningRecord, title: string) => void;
}

const money = (v: number | null, cur: string) => (v === null ? 'not recorded' : `${cur} ${v.toLocaleString('en-US')}`);
const days = (v: number | null) => (v === null ? 'not recorded' : `${v} day(s)`);

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt><dd className="mt-0.5 text-sm text-foreground">{children}</dd></div>;
}

export default function CaseDetail({ c, live, busy, uploadRole, setUploadRole, uploadMsg, onClose, onPick, onSave }: Props) {
  const r = c.record;
  const locked = c.status === 'approved' || c.status === 'retired';
  const [draft, setDraft] = useState<LearningRecord>(r);
  const [title, setTitle] = useState(c.title);
  const [err, setErr] = useState('');
  const set = <K extends keyof LearningRecord>(k: K, v: LearningRecord[K]) => setDraft({ ...draft, [k]: v });

  const inspect = async (sourceId: string) => {
    setErr('');
    try { const l = await api.inspectSource(c.id, sourceId); window.open(l.url, '_blank', 'noopener,noreferrer'); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not open the source.'); }
  };

  return (
    <section aria-label="Case detail" className="rounded-lg border border-border bg-card">
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-lg font-bold text-foreground">{c.title}</h2>
          <div className="mt-1 flex flex-wrap gap-2"><Badge tone="info">{STATUS_LABEL[c.status]}</Badge><Badge tone="neutral">v{c.version}</Badge><Badge tone="neutral">{c.partition === 'evaluation' ? 'Evaluation set' : 'Learning set'}</Badge><Badge tone="neutral">Used in model fine-tuning: No</Badge></div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close detail" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"><X size={18} /></button>
      </div>

      <div className="grid gap-6 p-5 lg:grid-cols-2">
        <div className="space-y-5">
          <div>
            <h3 className="mb-2 text-sm font-bold">Sources and provenance</h3>
            {c.sources.length === 0 ? <p className="text-sm text-muted-foreground">No files attached yet.</p> : (
              <ul className="space-y-2">
                {c.sources.map((s) => (
                  <li key={s.id} className="rounded-md border border-border p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold">{s.fileName}</span>
                      <span className="flex gap-1.5"><Badge tone={s.stored ? 'success' : 'warning'}>{s.stored ? 'Original preserved' : 'Original not stored'}</Badge><Badge tone={s.readStatus === 'read' ? 'success' : s.readStatus === 'partial' ? 'warning' : 'neutral'}>{s.readStatus === 'read' ? 'Read' : s.readStatus === 'partial' ? 'Partly read' : 'Not read'}</Badge></span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{SOURCE_ROLES.find((x) => x.role === s.role)?.label} | SHA-256 {s.sha256.slice(0, 12)}... | {(s.sizeBytes / 1024).toFixed(0)} KB</p>
                    <p className="text-xs text-muted-foreground">{s.readDetail}</p>
                    {s.stored ? <button type="button" onClick={() => void inspect(s.id)} className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline"><ExternalLink size={12} />Inspect original</button> : null}
                  </li>
                ))}
              </ul>
            )}
            {c.missingEvidence.length ? <div className="mt-3 rounded-md bg-warning/15 px-3 py-2 text-sm"><p className="font-semibold">Missing evidence</p><ul className="list-disc pl-5">{c.missingEvidence.map((m) => <li key={m}>{m}</li>)}</ul></div> : <p className="mt-3 text-sm text-success">All required evidence roles have a source.</p>}
            {!locked ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <select value={uploadRole} onChange={(e) => setUploadRole(e.target.value as SourceRole)} aria-label="Source role" className="rounded-md border border-border px-2 py-1.5 text-sm">{SOURCE_ROLES.map((x) => <option key={x.role} value={x.role}>{x.label}</option>)}</select>
                <button type="button" onClick={onPick} disabled={busy} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90"><Upload size={14} />Attach file</button>
              </div>
            ) : <p className="mt-3 text-xs text-muted-foreground">This case is {STATUS_LABEL[c.status].toLowerCase()}. Create a new version to change its sources.</p>}
            {uploadMsg ? <p role="status" className="mt-2 text-xs text-muted-foreground">{uploadMsg}</p> : null}
            {err ? <p role="alert" className="mt-2 text-xs text-destructive">{err}</p> : null}
          </div>

          <div>
            <h3 className="mb-2 text-sm font-bold">Review history</h3>
            <ol className="space-y-1.5 text-sm">
              {c.reviewHistory.map((h, i) => (
                <li key={`${h.at}-${i}`} className="rounded-md bg-muted px-3 py-2"><span className="font-semibold capitalize">{h.action.replace('_', ' ')}</span> v{h.version} by {h.reviewer || 'unnamed'} on {h.at.slice(0, 10)}{h.note ? ` - ${h.note}` : ''}{h.evidence.length ? <span className="block text-xs text-muted-foreground">Evidence: {h.evidence.join('; ')}</span> : null}</li>
              ))}
            </ol>
            {c.replacedBy ? <p className="mt-2 text-sm">Replaced by <strong>{c.replacedBy}</strong>.</p> : null}
          </div>
        </div>

        <div className="space-y-4">
          <h3 className="text-sm font-bold">Structured learning record</h3>
          <dl className="grid grid-cols-2 gap-3">
            <Field label="Change type">{r.changeType || 'not recorded'}</Field>
            <Field label="Work type">{r.workType || 'not recorded'}</Field>
            <Field label="Location">{r.location || 'not recorded'}</Field>
            <Field label="Specifications">{r.specifications.join(', ') || 'not recorded'}</Field>
            <Field label="Project context">{r.projectContext || 'not recorded'}</Field>
            <Field label="Productivity">{r.productivity.assumption || 'not recorded'}{r.productivity.resources ? ` | ${r.productivity.resources}` : ''}{r.productivity.calendar ? ` | ${r.productivity.calendar}` : ''}</Field>
          </dl>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Quantities (original / revised, with basis)</p>
            {r.quantities.length ? <ul className="mt-1 space-y-1 text-sm">{r.quantities.map((q, i) => <li key={`${q.item}-${i}`}>{q.item}: {q.original ?? '?'} to {q.revised ?? '?'} {q.unit} <span className="text-xs text-muted-foreground">({q.basis})</span></li>)}</ul> : <p className="text-sm text-muted-foreground">none recorded</p>}
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">BOQ mapping and rate basis</p>
            {r.boqMappings.length ? <ul className="mt-1 space-y-1 text-sm">{r.boqMappings.map((m, i) => <li key={`${m.boqRef}-${i}`}>{m.item} to BOQ {m.boqRef} ({m.unit}), {m.rateBasis}</li>)}</ul> : <p className="text-sm text-muted-foreground">none recorded</p>}
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Impacted activities and rationale</p>
            {r.activityMappings.length ? <ul className="mt-1 space-y-1 text-sm">{r.activityMappings.map((m, i) => <li key={`${m.activityId}-${i}`}>{m.activityId} {m.name}: {m.rationale}</li>)}</ul> : <p className="text-sm text-muted-foreground">none recorded</p>}
          </div>

          <div className="rounded-md border border-border p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Programme: simulated vs observed (kept separate)</p>
            <dl className="mt-2 grid grid-cols-2 gap-3">
              <Field label="Simulated delay">{days(r.schedule.simulatedDelayDays)}</Field>
              <Field label="Observed actual delay">{days(r.schedule.observedActualDelayDays)}</Field>
              <Field label="Simulation settings">{r.schedule.simulationSettings || 'not recorded'}</Field>
              <Field label="Milestone / completion">{r.schedule.milestoneImpact || 'not recorded'}{r.schedule.completionImpact ? ` | ${r.schedule.completionImpact}` : ''}</Field>
            </dl>
          </div>
          <div className="rounded-md border border-border p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Outcome figures (four separate fields)</p>
            <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Claimed">{money(r.outcome.claimed, r.outcome.currency)}</Field>
              <Field label="Assessed">{money(r.outcome.assessed, r.outcome.currency)}</Field>
              <Field label="Approved">{money(r.outcome.approved, r.outcome.currency)}</Field>
              <Field label="Actual">{money(r.outcome.actual, r.outcome.currency)}</Field>
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">Technical calculation verified by reviewer: <strong>{r.outcome.technicallyVerified ? 'Yes' : 'No'}</strong>. {r.outcome.settlementNote || 'An approved settlement does not by itself prove the calculation was right.'}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reviewer corrections</p>
            {r.corrections.length ? <ul className="mt-1 space-y-1 text-sm">{r.corrections.map((x, i) => <li key={`${x.field}-${i}`}>{x.field}: was {x.was}, should be {x.shouldBe}. Why: {x.why}</li>)}</ul> : <p className="text-sm text-muted-foreground">none recorded</p>}
            <p className="mt-1 text-xs text-muted-foreground">Corrections stay on this case. They are not applied as global rules.</p>
          </div>
          {r.reasoning ? <Field label="Reasoning">{r.reasoning}</Field> : null}

          {!locked ? (
            <details className="rounded-md border border-border p-3">
              <summary className="cursor-pointer text-sm font-semibold">Edit key fields</summary>
              <div className="mt-3 grid gap-2 text-sm">
                <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1 w-full rounded-md border border-border px-2 py-1.5" /></label>
                <label>Change type<input value={draft.changeType} onChange={(e) => set('changeType', e.target.value)} className="mt-1 w-full rounded-md border border-border px-2 py-1.5" /></label>
                <label>Work type<input value={draft.workType} onChange={(e) => set('workType', e.target.value)} className="mt-1 w-full rounded-md border border-border px-2 py-1.5" /></label>
                <label>Location<input value={draft.location} onChange={(e) => set('location', e.target.value)} className="mt-1 w-full rounded-md border border-border px-2 py-1.5" /></label>
                <label>Specifications (comma separated)<input value={draft.specifications.join(', ')} onChange={(e) => set('specifications', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} className="mt-1 w-full rounded-md border border-border px-2 py-1.5" /></label>
                <label>Project context (type only, no personal details)<input value={draft.projectContext} onChange={(e) => set('projectContext', e.target.value)} className="mt-1 w-full rounded-md border border-border px-2 py-1.5" /></label>
                <label>Reasoning<textarea value={draft.reasoning} onChange={(e) => set('reasoning', e.target.value)} rows={3} className="mt-1 w-full rounded-md border border-border px-2 py-1.5" /></label>
                <button type="button" disabled={busy || !live} onClick={() => onSave(draft, title)} className="justify-self-start rounded-md bg-primary px-3 py-1.5 font-semibold text-primary-foreground disabled:opacity-50">Save record</button>
                {!live ? <p className="text-xs text-muted-foreground">Saving needs the saved library.</p> : null}
              </div>
            </details>
          ) : null}
        </div>
      </div>
    </section>
  );
}

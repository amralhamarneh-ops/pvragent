'use client';

import React, { useMemo, useRef, useState } from 'react';
import { FileText, Plus, Search, ShieldCheck, Upload } from 'lucide-react';
import Badge from '@/components/ui/Badge';
import Modal from '@/components/ui/Modal';
import EmptyState from '@/components/ui/EmptyState';
import * as api from '@/lib/reference/client';
import { canTransition, isRetrievable, missingEvidence, partitionMoveBlock, transition, withdraw } from '@/lib/reference/lifecycle';
import { SOURCE_ROLES, STATUS_LABEL, type ReferenceCase, type ReferenceStatus, type SourceRole } from '@/lib/reference/types';
import CaseDetail from './CaseDetail';

interface Props { cases: ReferenceCase[]; setCases: (c: ReferenceCase[]) => void; live: boolean; reload: () => Promise<void> }

const tone = (s: ReferenceStatus) => (s === 'approved' ? 'success' : s === 'under_review' ? 'warning' : s === 'retired' ? 'danger' : 'neutral') as 'success' | 'warning' | 'danger' | 'neutral';
type Action = { kind: 'approve' | 'retire' | 'submit' | 'return'; id: string } | null;

export default function CaseLibrary({ cases, setCases, live, reload }: Props) {
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | ReferenceStatus>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [action, setAction] = useState<Action>(null);
  const [reviewer, setReviewer] = useState('');
  const [note, setNote] = useState('');
  const [evidence, setEvidence] = useState('');
  const [replacedBy, setReplacedBy] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newGroup, setNewGroup] = useState('');
  const [creating, setCreating] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadRole, setUploadRole] = useState<SourceRole>('pvr_narrative');
  const [uploadMsg, setUploadMsg] = useState('');

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return cases.filter((c) => (statusFilter === 'all' || c.status === statusFilter) && (!t || [c.title, c.record.workType, c.record.changeType, c.record.specifications.join(' '), c.caseGroup].join(' ').toLowerCase().includes(t)));
  }, [cases, q, statusFilter]);

  const open = cases.find((c) => c.id === openId) ?? null;
  const target = action ? cases.find((c) => c.id === action.id) ?? null : null;

  const replaceLocal = (c: ReferenceCase) => setCases(cases.map((x) => (x.id === c.id ? c : x)));
  const now = () => new Date().toISOString();

  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(''); try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : 'Failed.'); } finally { setBusy(false); } };

  const confirm = () => run(async () => {
    if (!action || !target) return;
    const to: ReferenceStatus = action.kind === 'approve' ? 'approved' : action.kind === 'retire' ? 'retired' : action.kind === 'submit' ? 'under_review' : 'draft';
    const ev = evidence.split('\n').map((s) => s.trim()).filter(Boolean);
    if (live) {
      const r = action.kind === 'retire' ? await api.withdrawCase(target.id, reviewer, note, replacedBy.trim() || null) : await api.moveStatus(target.id, to, reviewer, note, ev);
      replaceLocal(r.case);
    } else {
      const r = action.kind === 'retire' ? withdraw(target, reviewer, note, now(), replacedBy.trim() || null) : transition(target, { to, reviewer, note, evidence: ev, at: now() });
      if (!r.ok || !r.next) throw new Error(r.error);
      replaceLocal(r.next);
    }
    setAction(null); setNote(''); setEvidence(''); setReplacedBy('');
  });

  const create = () => run(async () => {
    if (!newTitle.trim()) throw new Error('Enter a title.');
    if (!live) throw new Error('Creating cases needs the saved library. It is not reachable, so this demonstration is read-only.');
    const r = await api.createCase(newTitle, newGroup, reviewer || 'Admin');
    setCases([r.case, ...cases]); setOpenId(r.case.id); setNewTitle(''); setNewGroup(''); setCreating(false);
  });

  const upload = (files: FileList | null) => run(async () => {
    if (!open || !files?.length) return;
    if (!live) throw new Error('Uploading needs the saved library. It is not reachable, so this demonstration is read-only.');
    const msgs: string[] = []; let latest = open;
    for (const f of Array.from(files)) {
      const r = await api.uploadSource(open.id, uploadRole, f);
      msgs.push(`${f.name}: ${r.reused ? 'identical file already attached, reused' : r.source.stored ? 'original preserved' : 'registered, original NOT stored'}${r.storageError ? ` (${r.storageError})` : ''}`);
      if (!latest.sources.some((s) => s.id === r.source.id)) latest = { ...latest, sources: [...latest.sources, r.source] };
    }
    latest = { ...latest, missingEvidence: missingEvidence(latest.sources) };
    replaceLocal(latest); setUploadMsg(msgs.join(' | ')); await reload();
  });

  const movePartition = (c: ReferenceCase) => run(async () => {
    const to = c.partition === 'learning' ? 'evaluation' : 'learning';
    const block = partitionMoveBlock(cases, c.id, to); if (block) throw new Error(block);
    if (!live) { setCases(cases.map((x) => (x.caseGroup === c.caseGroup ? { ...x, partition: to } : x))); return; }
    const r = await api.movePartition(c.id, to, reviewer || 'Admin'); setCases(r.cases);
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-60 flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by work type, change type, specification or title" aria-label="Search reference cases"
            className="w-full rounded-md border border-border bg-card py-2 pl-9 pr-3 text-sm" />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | ReferenceStatus)} aria-label="Filter by status" className="rounded-md border border-border bg-card px-3 py-2 text-sm">
          <option value="all">All states</option>
          {(Object.keys(STATUS_LABEL) as ReferenceStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <button type="button" onClick={() => setCreating(true)} className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"><Plus size={16} />Upload historical case</button>
      </div>

      {err ? <p role="alert" className="rounded-md bg-destructive/10 px-4 py-2 text-sm text-destructive">{err}</p> : null}

      {shown.length === 0 ? (
        <EmptyState icon={<FileText size={22} />} title="No reference cases match" description="Upload a historical case package, or change the search and state filter." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted text-xs uppercase tracking-wide text-muted-foreground">
              <tr><th className="px-4 py-3">Case</th><th className="px-4 py-3">State</th><th className="px-4 py-3">Available as reference</th><th className="px-4 py-3">Used in model fine-tuning</th><th className="px-4 py-3">Set</th><th className="px-4 py-3">Evidence</th><th className="px-4 py-3 text-right">Actions</th></tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id} className="border-t border-border align-top">
                  <td className="px-4 py-3"><button type="button" onClick={() => setOpenId(c.id)} className="text-left font-semibold text-foreground hover:underline">{c.title}</button><p className="text-xs text-muted-foreground">{c.record.workType || 'work type not set'} | v{c.version}</p></td>
                  <td className="px-4 py-3"><Badge tone={tone(c.status)}>{STATUS_LABEL[c.status]}</Badge></td>
                  <td className="px-4 py-3">{isRetrievable(c) ? <Badge tone="success">Yes</Badge> : <Badge tone="neutral">No</Badge>}</td>
                  <td className="px-4 py-3"><Badge tone="neutral">No (never automatic)</Badge></td>
                  <td className="px-4 py-3"><Badge tone={c.partition === 'evaluation' ? 'info' : 'neutral'}>{c.partition === 'evaluation' ? 'Evaluation' : 'Learning'}</Badge></td>
                  <td className="px-4 py-3 text-xs">{c.sources.length} file(s){c.missingEvidence.length ? <span className="block text-destructive">{c.missingEvidence.length} missing</span> : <span className="block text-success">Complete</span>}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <button type="button" onClick={() => setOpenId(c.id)} className="rounded-md border border-border px-2.5 py-1 text-xs font-semibold hover:bg-muted">Inspect</button>
                      {canTransition(c.status, 'under_review') ? <button type="button" onClick={() => setAction({ kind: 'submit', id: c.id })} className="rounded-md border border-border px-2.5 py-1 text-xs font-semibold hover:bg-muted">Submit for review</button> : null}
                      {c.status === 'under_review' ? <button type="button" onClick={() => setAction({ kind: 'approve', id: c.id })} className="rounded-md bg-success px-2.5 py-1 text-xs font-semibold text-white hover:opacity-90">Approve</button> : null}
                      {c.status === 'under_review' ? <button type="button" onClick={() => setAction({ kind: 'return', id: c.id })} className="rounded-md border border-border px-2.5 py-1 text-xs font-semibold hover:bg-muted">Return to draft</button> : null}
                      {c.status === 'approved' ? <button type="button" onClick={() => setAction({ kind: 'retire', id: c.id })} className="rounded-md border border-destructive/50 px-2.5 py-1 text-xs font-semibold text-destructive hover:bg-destructive/10">Retire</button> : null}
                      {c.status !== 'retired' ? <button type="button" onClick={() => movePartition(c)} disabled={busy} className="rounded-md border border-border px-2.5 py-1 text-xs font-semibold hover:bg-muted">{c.partition === 'learning' ? 'Reserve for evaluation' : 'Return to learning'}</button> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open ? (
        <CaseDetail key={open.id} c={open} live={live} busy={busy} uploadRole={uploadRole} setUploadRole={setUploadRole} uploadMsg={uploadMsg}
          onClose={() => { setOpenId(null); setUploadMsg(''); }} onPick={() => fileRef.current?.click()}
          onSave={(rec, title) => run(async () => { if (!live) throw new Error('Editing needs the saved library.'); const r = await api.saveRecord(open.id, title, rec, reviewer || 'Admin'); replaceLocal(r.case); })} />
      ) : null}
      <input ref={fileRef} type="file" multiple className="hidden" aria-label="Choose case files" onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} />

      <Modal open={creating} title="Upload historical case" onClose={() => setCreating(false)}
        footer={<><button type="button" onClick={() => setCreating(false)} className="rounded-md border border-border px-4 py-2 text-sm font-semibold">Cancel</button><button type="button" onClick={create} disabled={busy} className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">Create draft</button></>}>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">Creates a Draft case. You then attach the package files (narrative, drawings, BOQs, schedules, cost calculations and the reviewed outcome). Incomplete packages are allowed; missing evidence is listed.</p>
          <label className="block"><span className="font-semibold">Case title</span><input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} className="mt-1 w-full rounded-md border border-border px-3 py-2" /></label>
          <label className="block"><span className="font-semibold">Case group (versions of the same case share it)</span><input value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="Optional" className="mt-1 w-full rounded-md border border-border px-3 py-2" /></label>
          <label className="block"><span className="font-semibold">Your reviewer name or role</span><input value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="Role is enough; avoid personal details" className="mt-1 w-full rounded-md border border-border px-3 py-2" /></label>
          <p className="text-xs text-muted-foreground">Roles: {SOURCE_ROLES.map((r) => r.label).join(', ')}.</p>
        </div>
      </Modal>

      <Modal open={!!action && !!target} title={action?.kind === 'approve' ? 'Approve as reference' : action?.kind === 'retire' ? 'Retire reference' : action?.kind === 'submit' ? 'Submit for review' : 'Return to draft'} onClose={() => setAction(null)}
        footer={<><button type="button" onClick={() => setAction(null)} className="rounded-md border border-border px-4 py-2 text-sm font-semibold">Cancel</button><button type="button" onClick={confirm} disabled={busy} className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">Confirm</button></>}>
        <div className="space-y-3 text-sm">
          {target ? <p className="font-semibold">{target.title} (v{target.version})</p> : null}
          {action?.kind === 'approve' ? <p className="flex items-start gap-2 text-muted-foreground"><ShieldCheck size={16} className="mt-0.5 shrink-0" />Approving makes this case retrievable as supporting precedent only. It does not change any rule, rate or quantity, and does not fine-tune a model.</p> : null}
          <label className="block"><span className="font-semibold">Reviewer</span><input value={reviewer} onChange={(e) => setReviewer(e.target.value)} className="mt-1 w-full rounded-md border border-border px-3 py-2" /></label>
          <label className="block"><span className="font-semibold">Reason / note</span><textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className="mt-1 w-full rounded-md border border-border px-3 py-2" /></label>
          {action?.kind === 'approve' ? <label className="block"><span className="font-semibold">Supporting evidence (one reference per line)</span><textarea value={evidence} onChange={(e) => setEvidence(e.target.value)} rows={3} className="mt-1 w-full rounded-md border border-border px-3 py-2" /></label> : null}
          {action?.kind === 'retire' ? <label className="block"><span className="font-semibold">Replaced by case id (optional)</span><input value={replacedBy} onChange={(e) => setReplacedBy(e.target.value)} className="mt-1 w-full rounded-md border border-border px-3 py-2" /></label> : null}
          {err ? <p role="alert" className="text-destructive">{err}</p> : null}
        </div>
      </Modal>
      {/* keeps the icon import used for the upload affordance in the detail panel */}
      <span className="hidden"><Upload size={1} /></span>
    </div>
  );
}

'use client';

import React, { useState } from 'react';
import { Gavel, Check, X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import ChapterShell from '@/app/case-story/components/ChapterShell';
import Modal from '@/components/ui/Modal';

const options = [
  { id: 'option-accept', title: 'Accept as assessed', cost: 'AED 3.26M', time: '+41 days', risk: 'Programme buffer exceeded by 11 days', recommended: false },
  { id: 'option-accelerate', title: 'Accept and add resources to hold the date', cost: 'AED 4.00M', time: '+0 days', risk: 'Second paving crew needed; weather exposure in May', recommended: true },
  { id: 'option-negotiate', title: 'Negotiate: omit lighting from this phase', cost: 'AED 2.31M', time: '+27 days', risk: 'Lighting becomes a later variation', recommended: false },
];

export default function ChapterDecision() {
  const [selected, setSelected] = useState('option-accelerate');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [mode, setMode] = useState<'approve' | 'reject'>('approve');
  const [busy, setBusy] = useState(false);

  const submit = () => {
    setBusy(true);
    // Backend integration: POST /cases/PVR-0418/approvals with named user, selected option and document version.
    setTimeout(() => {
      setBusy(false);
      setConfirmOpen(false);
      toast?.success(mode === 'approve' ? 'Approval recorded for Sara Al Rumaithi' : 'Rejection recorded and requester notified');
    }, 900);
  };

  return (
    <ChapterShell chapterId="chapter-decision" agents={[{ name: 'Orchestrator', confidence: 85 }, { name: 'Summary', confidence: 90 }]}>
      <p className="mb-3 text-xs text-muted-foreground">Optioneering is advisory. Cost and Schedule agents agreed on these trade-offs after one challenge round.</p>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {options?.map((o) => (
          <button
            key={o?.id}
            type="button"
            onClick={() => setSelected(o?.id)}
            className={`rounded-lg border p-4 text-left transition-all duration-150 active:scale-[0.99] ${
              selected === o?.id ? 'border-warning bg-warning/10 ring-2 ring-warning/40' : 'border-border bg-card hover:border-accent'
            }`}
          >
            {o?.recommended ? <span className="mb-2 inline-block rounded-md bg-warning px-2 py-0.5 text-xs font-bold text-warning-foreground">Agent recommendation</span> : null}
            <p className="text-sm font-semibold text-foreground">{o?.title}</p>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div>
                <dt className="text-muted-foreground">Cost</dt>
                <dd className="font-data text-sm font-semibold text-foreground">{o?.cost}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Time</dt>
                <dd className="font-data text-sm font-semibold text-foreground">{o?.time}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">{o?.risk}</p>
          </button>
        ))}
      </div>

      <div className="mt-5 flex flex-col gap-3 rounded-lg border border-warning/50 bg-warning/10 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <Gavel size={20} className="mt-0.5 shrink-0 text-foreground" />
          <div>
            <p className="text-sm font-semibold text-foreground">Human review and approval</p>
            <p className="text-sm text-muted-foreground">Delegation of authority: Commercial Manager up to AED 5M. Nothing is issued without a named person.</p>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => {
              setMode('reject');
              setConfirmOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition-all duration-150 hover:bg-muted active:scale-95"
          >
            <X size={15} /> Reject
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('approve');
              setConfirmOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-warning px-4 py-2 text-sm font-bold text-warning-foreground transition-all duration-150 hover:opacity-90 active:scale-95"
          >
            <Check size={15} /> Approve option
          </button>
        </div>
      </div>

      <Modal
        open={confirmOpen}
        title={mode === 'approve' ? 'Approve this assessment?' : 'Reject this assessment?'}
        onClose={() => setConfirmOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setConfirmOpen(false)} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted">
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy}
              className={`inline-flex min-w-[140px] items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-all active:scale-95 disabled:opacity-60 ${
                mode === 'approve' ? 'bg-warning text-warning-foreground' : 'bg-destructive text-destructive-foreground'
              }`}
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : null}
              {mode === 'approve' ? 'Confirm approval' : 'Confirm rejection'}
            </button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          {mode === 'approve' ?'This records you as the approver for PVR-0418 and moves the case to PVR output. A VO is only issued after an authorised signatory certifies it.' :'The requester and project team are notified, and the decision is written to the audit trail with your name.'}
        </p>
      </Modal>
    </ChapterShell>
  );
}
'use client';

import React, { useState } from 'react';
import { Undo2 } from 'lucide-react';

export type DemoDecisionKind = 'manual_rate' | 'excluded_cost' | 'excluded_schedule' | 'excluded_scenario' | 'deferred' | 'unresolved';

export interface DemoDecision { kind: DemoDecisionKind; reason: string; at: string; rate?: string; unit?: string; currency?: string }

const LABEL: Record<DemoDecisionKind, string> = {
  manual_rate: 'Manual rate · Proposed', excluded_cost: 'Cost excluded', excluded_schedule: 'Schedule excluded', excluded_scenario: 'Excluded from scenario', deferred: 'Deferred', unresolved: 'Unresolved',
};

export function decisionLabel(k: DemoDecisionKind): string { return LABEL[k]; }

interface Props {
  /** Stable id of the line (component / mapping id). */
  lineId: string;
  label: string;
  decision: DemoDecision | undefined;
  unit: string;
  currency: string;
  onDecide: (lineId: string, d: DemoDecision | undefined) => void;
  /** Which actions this screen offers. */
  show: { rate?: boolean; excludeCost?: boolean; excludeSchedule?: boolean; excludeScenario?: boolean; defer?: boolean; retry?: () => void; newItem?: () => void; newActivity?: () => void };
}

/** One resolution row for the demo screens, so CostPanel and ActivityStage offer the same actions and states. */
export default function DemoLineActions({ lineId, label, decision, unit, currency, onDecide, show }: Props) {
  const [editing, setEditing] = useState<null | 'rate' | 'exclude'>(null);
  const [rate, setRate] = useState(decision?.rate ?? '');
  const [rUnit, setRUnit] = useState(decision?.unit ?? unit);
  const [reason, setReason] = useState('');
  const now = () => new Date().toISOString();

  const btn = 'rounded-md border border-input bg-card px-2 py-1 text-xs font-medium hover:bg-muted';
  return (
    <div className="mt-1" role="group" aria-label={`Resolve ${label}`}>
      {decision ? (
        <p className="text-xs text-foreground"><span className="rounded bg-muted px-1.5 py-0.5 font-medium">{LABEL[decision.kind]}</span>{decision.kind === 'manual_rate' ? ` ${decision.currency} ${decision.rate}/${decision.unit}` : ''} · {decision.reason} <button type="button" onClick={() => onDecide(lineId, undefined)} className="ml-1 inline-flex items-center gap-1 text-accent hover:underline"><Undo2 size={11} aria-hidden />Restore</button></p>
      ) : null}
      <div className="mt-1 flex flex-wrap gap-1.5">
        {show.retry ? <button type="button" className={btn} onClick={show.retry}>Retry automatic mapping</button> : null}
        {show.rate ? <button type="button" className={btn} onClick={() => setEditing(editing === 'rate' ? null : 'rate')}>Add / edit manual rate</button> : null}
        {show.newItem ? <button type="button" className={btn} onClick={show.newItem}>Create new assessment item</button> : null}
        {show.newActivity ? <button type="button" className={btn} onClick={show.newActivity}>Propose a new activity</button> : null}
        {show.defer ? <button type="button" className={btn} onClick={() => onDecide(lineId, { kind: 'deferred', reason: 'Deferred by you; assessment continues.', at: now() })}>Defer and continue</button> : null}
        {show.excludeCost || show.excludeSchedule || show.excludeScenario ? <button type="button" className={btn} onClick={() => setEditing(editing === 'exclude' ? null : 'exclude')}>Exclude…</button> : null}
      </div>

      {editing === 'rate' ? (
        <form className="mt-2 flex flex-wrap items-end gap-2 rounded-md border border-border bg-background p-2" onSubmit={(e) => { e.preventDefault(); if (rate.trim() === '' || reason.trim() === '' || !/^\d+(\.\d+)?$/.test(rate.trim())) return; onDecide(lineId, { kind: 'manual_rate', reason: reason.trim(), at: now(), rate: rate.trim(), unit: rUnit.trim(), currency }); setEditing(null); setReason(''); }}>
          <label className="text-xs text-muted-foreground">Rate ({currency})<input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} className="mt-0.5 block w-24 rounded-md border border-input bg-card px-2 py-1 text-right text-foreground" /></label>
          <label className="text-xs text-muted-foreground">Per<input value={rUnit} onChange={(e) => setRUnit(e.target.value)} className="mt-0.5 block w-16 rounded-md border border-input bg-card px-2 py-1 text-foreground" /></label>
          <label className="min-w-[10rem] flex-1 text-xs text-muted-foreground">Reason (required)<input value={reason} onChange={(e) => setReason(e.target.value)} className="mt-0.5 block w-full rounded-md border border-input bg-card px-2 py-1 text-foreground" /></label>
          <button type="submit" className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground">Save as proposed</button>
          <p className="w-full text-xs text-muted-foreground">Demo data only. A blank rate stays unpriced; enter 0 only for an explicit zero.</p>
        </form>
      ) : null}

      {editing === 'exclude' ? (
        <form className="mt-2 flex flex-wrap items-end gap-2 rounded-md border border-border bg-background p-2" onSubmit={(e) => e.preventDefault()}>
          <label className="min-w-[10rem] flex-1 text-xs text-muted-foreground">Reason (required)<input value={reason} onChange={(e) => setReason(e.target.value)} className="mt-0.5 block w-full rounded-md border border-input bg-card px-2 py-1 text-foreground" /></label>
          {show.excludeCost ? <button type="button" disabled={!reason.trim()} className={`${btn} disabled:opacity-50`} onClick={() => { onDecide(lineId, { kind: 'excluded_cost', reason: reason.trim(), at: now() }); setEditing(null); setReason(''); }}>Exclude from cost only</button> : null}
          {show.excludeSchedule ? <button type="button" disabled={!reason.trim()} className={`${btn} disabled:opacity-50`} onClick={() => { onDecide(lineId, { kind: 'excluded_schedule', reason: reason.trim(), at: now() }); setEditing(null); setReason(''); }}>Exclude from schedule only</button> : null}
          {show.excludeScenario ? <button type="button" disabled={!reason.trim()} className={`${btn} disabled:opacity-50`} onClick={() => { onDecide(lineId, { kind: 'excluded_scenario', reason: reason.trim(), at: now() }); setEditing(null); setReason(''); }}>Exclude from scenario</button> : null}
        </form>
      ) : null}
    </div>
  );
}

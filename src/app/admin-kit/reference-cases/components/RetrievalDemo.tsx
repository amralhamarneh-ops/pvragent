'use client';

import React, { useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import Badge from '@/components/ui/Badge';
import * as api from '@/lib/reference/client';
import { DEMO_QUERY_SUITABLE, DEMO_QUERY_UNSUITABLE } from '@/lib/reference/demo';
import { precedentPromptBlock, retrieveReferences } from '@/lib/reference/retrieve';
import type { CurrentContext, PrecedentDecision, ReferenceCase, RetrievalResult } from '@/lib/reference/types';

interface Props { cases: ReferenceCase[]; live: boolean }

const resultTone = (r: string) => (r === 'match' ? 'success' : r === 'partial' ? 'warning' : r === 'mismatch' ? 'danger' : 'neutral') as 'success' | 'warning' | 'danger' | 'neutral';

function Decision({ d, n }: { d: PrecedentDecision; n?: number }) {
  const used = d.decision === 'used';
  return (
    <li className={`rounded-lg border p-4 ${used ? 'border-success/40 bg-success/5' : 'border-destructive/30 bg-destructive/5'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold">{used ? <CheckCircle2 size={16} className="text-success" /> : <XCircle size={16} className="text-destructive" />}{used && n ? `[R${n}] ` : ''}{d.title} <span className="text-xs font-normal text-muted-foreground">v{d.version}</span></p>
        <Badge tone={used ? 'success' : 'danger'}>{used ? 'Used' : 'Rejected'} | similarity {(d.score * 100).toFixed(0)}%</Badge>
      </div>
      <p className="mt-2 text-sm"><strong>{used ? 'Influence:' : 'Why rejected:'}</strong> {used ? d.influence : d.reason}</p>
      {d.checks.length ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">{d.checks.map((k) => <li key={k.name} title={k.detail}><Badge tone={resultTone(k.result)}>{k.name}: {k.result}</Badge></li>)}</ul>
      ) : null}
      {used ? (
        <div className="mt-2 text-xs text-muted-foreground"><p className="font-semibold">Citations</p><ul className="list-disc pl-5">{d.citations.map((c) => <li key={c.sourceId}>{c.fileName} ({c.locator})</li>)}</ul></div>
      ) : null}
    </li>
  );
}

export default function RetrievalDemo({ cases, live }: Props) {
  const [q, setQ] = useState<CurrentContext>({ ...DEMO_QUERY_SUITABLE, authoritative: { quantities: 'Current drawing S-101 revB take-off', rates: 'Current contract BOQ', scheduleLogic: 'Current programme logic', calendars: 'Current project calendars', productivity: 'Current productivity', contract: 'Current contract conditions' } });
  const [res, setRes] = useState<RetrievalResult | null>(null);
  const [block, setBlock] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (query: CurrentContext) => {
    setBusy(true); setErr('');
    try {
      if (live) { const r = await api.retrieveLive(query, true); setRes(r.result); setBlock(r.promptBlock); }
      else { const r = retrieveReferences(cases, query, { includeIneligible: true }); setRes(r); setBlock(precedentPromptBlock(r)); }
    } catch (e) { setErr(e instanceof Error ? e.message : 'Retrieval failed.'); } finally { setBusy(false); }
  };
  const field = (k: keyof CurrentContext, label: string) => (
    <label className="block text-sm"><span className="font-semibold">{label}</span><input value={String(q[k] ?? '')} onChange={(e) => setQ({ ...q, [k]: e.target.value })} className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2" /></label>
  );

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-base font-bold">New assessment: what the agent is asked to interpret</h2>
        <p className="mt-1 text-sm text-muted-foreground">Retrieval uses approved learning-set cases only. Draft, under-review, retired and evaluation cases are never used for a new assessment.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {field('changeType', 'Change type')}{field('workType', 'Work type')}{field('specification', 'Specification')}{field('unit', 'Unit')}{field('projectContext', 'Project context')}{field('scheduleConditions', 'Schedule conditions')}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => void run(q)} className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90">Retrieve precedents</button>
          <button type="button" disabled={busy} onClick={() => { setQ({ ...DEMO_QUERY_SUITABLE }); void run({ ...DEMO_QUERY_SUITABLE }); }} className="rounded-md border border-border px-4 py-2 text-sm font-semibold hover:bg-muted">Demo: suitable precedent is cited</button>
          <button type="button" disabled={busy} onClick={() => { setQ({ ...DEMO_QUERY_UNSUITABLE }); void run({ ...DEMO_QUERY_UNSUITABLE }); }} className="rounded-md border border-border px-4 py-2 text-sm font-semibold hover:bg-muted">Demo: no suitable precedent</button>
        </div>
        {!live ? <p className="mt-2 text-xs text-muted-foreground">Running locally on labelled demonstration cases.</p> : null}
        {err ? <p role="alert" className="mt-2 text-sm text-destructive">{err}</p> : null}
      </div>

      {res ? (
        <div className="space-y-4">
          <p role="status" className={`rounded-md px-4 py-3 text-sm font-semibold ${res.noSuitableReference ? 'bg-warning/15' : 'bg-success/10 text-success'}`}>{res.statement}</p>
          {res.used.length ? <div><h3 className="mb-2 text-sm font-bold">Reference cases used</h3><ul className="space-y-3">{res.used.map((d, i) => <Decision key={d.referenceId} d={d} n={i + 1} />)}</ul></div> : null}
          {res.rejected.length ? <div><h3 className="mb-2 text-sm font-bold">Precedents considered and rejected</h3><ul className="space-y-3">{res.rejected.map((d) => <Decision key={d.referenceId} d={d} />)}</ul></div> : null}
          <div className="rounded-lg border border-border bg-card p-4">
            <h3 className="text-sm font-bold">Not replaced by any precedent</h3>
            <p className="mt-1 text-sm text-muted-foreground">The current project keeps authority over these inputs. A precedent may suggest a method or aid interpretation only.</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">{res.notReplaced.map((n) => <li key={n}><Badge tone="info">{n}</Badge></li>)}</ul>
          </div>
          <details className="rounded-lg border border-border bg-card p-4">
            <summary className="cursor-pointer text-sm font-semibold">Evidence block passed to the agent (citations, no quantities or rates)</summary>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">{block}</pre>
          </details>
        </div>
      ) : null}
    </div>
  );
}

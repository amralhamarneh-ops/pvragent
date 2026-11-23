'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import Badge from '@/components/ui/Badge';
import { agentById, KIND_LABELS, STATUS_LABELS } from '@/lib/admin/registry';
import { RULE_AGENTS } from '@/lib/admin/rules';
import { loadAgent, loadTrace, type AgentDetailResponse, type TraceRow } from '@/lib/admin/client';
import RulesEditor from './RulesEditor';

const List = ({ title, items, empty = 'None' }: { title: string; items: string[]; empty?: string }) => (
  <div><h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>{items.length ? <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-foreground">{items.map((i) => <li key={i}>{i}</li>)}</ul> : <p className="mt-1 text-sm text-muted-foreground">{empty}</p>}</div>
);

export default function AgentDetail({ agentId }: { agentId: string }) {
  const a = agentById(agentId);
  const [trace, setTrace] = useState<TraceRow | null>(null);
  const [runs, setRuns] = useState<AgentDetailResponse | null>(null);
  const [runErr, setRunErr] = useState('');
  const [tab, setTab] = useState<'overview' | 'rules' | 'runs'>('overview');
  useEffect(() => {
    loadTrace().then((r) => setTrace(r.trace.find((t) => t.id === agentId) ?? null)).catch(() => undefined);
    loadAgent(agentId).then(setRuns).catch((e) => setRunErr(e instanceof Error ? e.message : 'Runs unavailable.'));
  }, [agentId]);

  if (!a) return <div><p className="text-sm">Unknown agent.</p><Link href="/admin-kit" className="text-accent hover:underline">Back to agents</Link></div>;
  const ruleCapable = RULE_AGENTS.includes(a.id);
  const lastError = runs?.runs.find((r) => r.error);

  return (
    <div className="space-y-4">
      <Link href="/admin-kit" className="text-sm text-accent hover:underline">← All agents</Link>
      <header>
        <h1 className="text-2xl font-bold text-foreground">{a.name}</h1>
        <div className="mt-2 flex flex-wrap gap-2"><Badge tone="neutral">{KIND_LABELS[a.kind]}</Badge><Badge tone={a.status === 'implemented' ? 'success' : a.status === 'partial' ? 'warning' : 'danger'}>{STATUS_LABELS[a.status]}</Badge>{ruleCapable ? <Badge tone="info">Reads published rules</Badge> : <Badge tone="neutral">No editable rules</Badge>}</div>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{a.purpose}</p>
      </header>
      <nav className="flex gap-1 border-b border-border">
        {(['overview', ...(ruleCapable ? ['rules'] : []), 'runs'] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t as typeof tab)} className={`border-b-2 px-4 py-2 text-sm font-semibold ${tab === t ? 'border-accent text-foreground' : 'border-transparent text-muted-foreground'}`}>{t === 'overview' ? 'Overview' : t === 'rules' ? 'Rules & versions' : 'Runs & errors'}</button>
        ))}
      </nav>

      {tab === 'overview' ? (
        <div className="grid gap-5 md:grid-cols-2">
          <List title="Inputs" items={a.inputs} /><List title="Outputs" items={a.outputs} />
          <List title="Upstream" items={a.upstream.map((u) => agentById(u)?.name ?? u)} /><List title="Downstream" items={a.downstream.map((u) => agentById(u)?.name ?? u)} />
          <List title="Automatic decisions allowed" items={a.automaticDecisions} /><List title="Requires human input" items={a.humanInput} />
          <List title="Protected controls (code)" items={a.protectedControls} />
          <List title="Not built / limitations" items={a.gaps} empty="No known gaps recorded." />
          <div><h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Model configuration</h4>
            {a.modelCalls.length ? a.modelCalls.map((m) => <p key={m.route + (m.phase ?? '')} className="mt-1 text-sm">{m.route}{m.phase ? ` (${m.phase})` : ''}: model from <code>{m.modelEnv}</code>, up to {m.maxCompletionTokens} completion tokens. {m.note}.</p>) : <p className="mt-1 text-sm text-muted-foreground">No model call. This is not an AI step.</p>}</div>
          <div><h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tools &amp; connections</h4>
            <ul className="mt-1 list-disc pl-5 text-sm">{a.tools.map((t) => <li key={t.id}>{t.label}{t.external ? ' (external)' : ''}</li>)}</ul>
            <p className="mt-1 text-xs text-muted-foreground">Live status: see <Link href="/admin-kit/tools" className="text-accent hover:underline">Tools &amp; Connections</Link>.</p></div>
          <div><h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reference library access</h4><p className="mt-1 text-sm">{a.referenceAccess === 'approved_precedents' ? 'Approved precedents only, as non-authoritative cited context.' : 'None. This agent does not read the reference library.'}</p></div>
          <div><h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Limits, retry, cancellation</h4><p className="mt-1 text-sm">{a.limits.maxItems ? `${a.limits.maxItems}. ` : ''}Retry: {a.limits.retry}. Cancellation: {a.limits.cancellation}.</p></div>
          <div className="md:col-span-2"><h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Execution code</h4>
            {a.code.length === 0 ? <p className="mt-1 text-sm text-destructive">No execution code exists for this capability.</p> : <ul className="mt-1 space-y-0.5 text-sm">{a.code.map((f) => { const ok = trace?.files.find((x) => x.file === f)?.exists; return <li key={f}><code className="text-xs">{f}</code> {trace ? (ok ? <span className="text-success">verified on server</span> : <span className="text-destructive">not found</span>) : null}</li>; })}</ul>}</div>
        </div>
      ) : null}

      {tab === 'rules' && ruleCapable ? <RulesEditor agentId={a.id} protectedControls={a.protectedControls} /> : null}

      {tab === 'runs' ? (
        <div className="space-y-3">
          {runErr ? <p className="rounded-md bg-warning/15 px-4 py-2 text-sm">Run history unavailable: {runErr}</p> : null}
          {lastError ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">Latest error ({lastError.createdAt.slice(0, 16).replace('T', ' ')}): {lastError.error}</p> : null}
          <div className="overflow-x-auto rounded-lg border border-border bg-card"><table className="w-full text-left text-sm">
            <thead className="bg-muted text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Config</th><th className="px-3 py-2">Model / tool</th><th className="px-3 py-2">Detail</th></tr></thead>
            <tbody>
              {!runs || runs.runs.length === 0 ? <tr><td colSpan={5} className="px-3 py-4 text-muted-foreground">{ruleCapable ? 'No runs recorded for this agent yet.' : 'Runs are recorded only for agents that make a model call. This agent writes no run records, so nothing is shown.'}</td></tr> : null}
              {runs?.runs.map((r) => (<tr key={r.id} className="border-t border-border align-top"><td className="px-3 py-2 text-xs">{r.createdAt.slice(0, 19).replace('T', ' ')}</td><td className="px-3 py-2"><Badge tone={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'}>{r.status}</Badge></td><td className="px-3 py-2 text-xs">{r.configSource === 'published' ? `Published v${r.configVersion}` : 'Built-in rules'}</td><td className="px-3 py-2 text-xs">{r.model ?? 'none'} / {r.tool}</td><td className="px-3 py-2 text-xs text-muted-foreground">{r.error ?? JSON.stringify(r.summary).slice(0, 160)}{r.precedentIds.length ? ` Precedents offered: ${r.precedentIds.join(', ')}.` : ''}</td></tr>))}
            </tbody></table></div>
        </div>
      ) : null}
    </div>
  );
}

'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import Badge from '@/components/ui/Badge';
import { AGENTS, KIND_LABELS, STATUS_LABELS, type ImplStatus } from '@/lib/admin/registry';
import { loadTrace, type TraceRow } from '@/lib/admin/client';

const tone = (s: ImplStatus) => (s === 'implemented' ? 'success' : s === 'partial' ? 'warning' : s === 'planned' ? 'info' : 'danger') as 'success' | 'warning' | 'info' | 'danger';

export default function AgentsInventory() {
  const [trace, setTrace] = useState<TraceRow[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { loadTrace().then((r) => setTrace(r.trace)).catch((e) => setErr(e instanceof Error ? e.message : 'Trace failed.')); }, []);

  const counts = (['implemented', 'partial', 'planned', 'missing'] as ImplStatus[]).map((s) => ({ s, n: AGENTS.filter((a) => a.status === s).length }));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Agents &amp; Responsibilities</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Built from the code in this project. Each implemented entry lists the files that run it, and the server confirms those files exist. Where one agent covers several responsibilities, that is shown rather than split. Capabilities with no code are marked Missing.</p>
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {counts.map((c) => (<div key={c.s} className="rounded-lg border border-border bg-card px-4 py-2"><dt className="text-xs text-muted-foreground">{STATUS_LABELS[c.s]}</dt><dd className="text-xl font-bold text-foreground">{c.n}</dd></div>))}
      </dl>
      {err ? <p role="status" className="rounded-md bg-warning/15 px-4 py-2 text-sm">Code trace could not run: {err}</p> : null}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted text-xs uppercase tracking-wide text-muted-foreground">
            <tr><th className="px-4 py-2">Agent</th><th className="px-4 py-2">Type</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Code trace</th><th className="px-4 py-2">Model call</th><th className="px-4 py-2">Rules execute</th></tr>
          </thead>
          <tbody>
            {AGENTS.map((a) => {
              const t = trace?.find((x) => x.id === a.id);
              return (
                <tr key={a.id} className="border-t border-border align-top">
                  <td className="px-4 py-3"><Link href={`/admin-kit/agents/${a.id}`} className="font-semibold text-accent hover:underline">{a.name}</Link><p className="mt-0.5 max-w-md text-xs text-muted-foreground">{a.responsibility}</p></td>
                  <td className="px-4 py-3"><Badge tone="neutral">{KIND_LABELS[a.kind]}</Badge></td>
                  <td className="px-4 py-3"><Badge tone={tone(a.status)}>{STATUS_LABELS[a.status]}</Badge></td>
                  <td className="px-4 py-3 text-xs">
                    {a.code.length === 0 ? <span className="text-muted-foreground">No execution code</span> : !t ? <span className="text-muted-foreground">Checking...</span> : t.traced ? <span className="text-success">{t.files.length} file(s) verified</span> : <span className="text-destructive">Missing: {t.files.filter((f) => !f.exists).map((f) => f.file).join(', ')}</span>}
                  </td>
                  <td className="px-4 py-3 text-xs">{a.modelCalls.length ? a.modelCalls.map((m) => `${m.route}${m.phase ? ` (${m.phase})` : ''}`).join('; ') : 'None'}</td>
                  <td className="px-4 py-3 text-xs">{a.rulesExecute ? <span className="text-success">Yes, published rules apply</span> : <span className="text-muted-foreground">No editable rules</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

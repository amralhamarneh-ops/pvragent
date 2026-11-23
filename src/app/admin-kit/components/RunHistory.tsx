'use client';

import React, { useEffect, useState } from 'react';
import Badge from '@/components/ui/Badge';
import { AGENTS } from '@/lib/admin/registry';
import { loadRuns } from '@/lib/admin/client';
import type { AgentRunRecord } from '@/lib/admin/adminStore';

export default function RunHistory() {
  const [runs, setRuns] = useState<AgentRunRecord[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { loadRuns().then((r) => setRuns(r.runs)).catch((e) => setErr(e instanceof Error ? e.message : 'Unavailable.')); }, []);
  const name = (id: string) => AGENTS.find((a) => a.id === id)?.name ?? id;
  return (
    <div className="space-y-4">
      <div><h1 className="text-2xl font-bold text-foreground">Evaluation &amp; Run History</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Real agent executions that wrote a run record, each showing the configuration version it was pinned to. Reference-case evaluation (held-out cases compared with supplied pipeline output) is run from <a className="text-accent hover:underline" href="/admin-kit/reference-cases">Reference Cases &amp; Learning</a>. No accuracy figure is shown here because none has been executed from this page.</p></div>
      {err ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{err}</p> : null}
      <div className="overflow-x-auto rounded-lg border border-border bg-card"><table className="w-full text-left text-sm">
        <thead className="bg-muted text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Agent</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Pinned config</th><th className="px-3 py-2">Model</th><th className="px-3 py-2">Precedents offered</th><th className="px-3 py-2">Detail</th></tr></thead>
        <tbody>
          {runs && runs.length === 0 ? <tr><td colSpan={7} className="px-3 py-4 text-muted-foreground">No agent runs recorded yet. Records are created when the scope, BOQ-matching or explanation agent runs.</td></tr> : null}
          {!runs && !err ? <tr><td colSpan={7} className="px-3 py-4 text-muted-foreground">Loading...</td></tr> : null}
          {runs?.map((r) => (<tr key={r.id} className="border-t border-border align-top">
            <td className="px-3 py-2 text-xs">{r.createdAt.slice(0, 19).replace('T', ' ')}</td><td className="px-3 py-2">{name(r.agentId)}</td>
            <td className="px-3 py-2"><Badge tone={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'}>{r.status}</Badge></td>
            <td className="px-3 py-2 text-xs">{r.configSource === 'published' ? `Published v${r.configVersion}` : 'Built-in rules'}</td>
            <td className="px-3 py-2 text-xs">{r.model ?? 'none'}</td><td className="px-3 py-2 text-xs">{r.precedentIds.join(', ') || '—'}</td>
            <td className="px-3 py-2 text-xs text-muted-foreground">{r.error ?? JSON.stringify(r.summary).slice(0, 140)}</td></tr>))}
        </tbody></table></div>
    </div>
  );
}

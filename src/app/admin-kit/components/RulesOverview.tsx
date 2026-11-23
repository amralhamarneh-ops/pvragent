'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import Badge from '@/components/ui/Badge';
import { AGENTS } from '@/lib/admin/registry';
import { RULE_AGENTS } from '@/lib/admin/rules';
import { loadAgent, type AgentDetailResponse } from '@/lib/admin/client';

export default function RulesOverview() {
  const [data, setData] = useState<Record<string, AgentDetailResponse | string>>({});
  useEffect(() => {
    RULE_AGENTS.forEach((id) => { loadAgent(id).then((d) => setData((p) => ({ ...p, [id]: d }))).catch((e) => setData((p) => ({ ...p, [id]: e instanceof Error ? e.message : 'Unavailable' }))); });
  }, []);
  return (
    <div className="space-y-4">
      <div><h1 className="text-2xl font-bold text-foreground">Rules &amp; Versions</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Only agents that make a model call read editable rules: {RULE_AGENTS.map((id) => AGENTS.find((a) => a.id === id)?.name).join(', ')}. Deterministic engines (cost arithmetic, CPM, drawing measurement) have no editable rules by design. Publishing changes new runs only; a run in progress and past run records keep their original version.</p></div>
      <div className="overflow-x-auto rounded-lg border border-border bg-card"><table className="w-full text-left text-sm">
        <thead className="bg-muted text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-4 py-2">Agent</th><th className="px-4 py-2">Published</th><th className="px-4 py-2">Versions</th><th className="px-4 py-2">Latest state</th><th className="px-4 py-2" /></tr></thead>
        <tbody>
          {RULE_AGENTS.map((id) => {
            const a = AGENTS.find((x) => x.id === id); const d = data[id];
            return (
              <tr key={id} className="border-t border-border">
                <td className="px-4 py-3 font-semibold">{a?.name}</td>
                {typeof d === 'string' ? <td colSpan={3} className="px-4 py-3 text-xs text-destructive">{d}</td> : d ? (<>
                  <td className="px-4 py-3">{d.publishedVersion ? <Badge tone="success">v{d.publishedVersion}</Badge> : <Badge tone="neutral">Built-in rules</Badge>}</td>
                  <td className="px-4 py-3">{d.versions.length}</td>
                  <td className="px-4 py-3 text-xs">{d.versions[0] ? `v${d.versions[0].version} ${d.versions[0].status}` : 'No versions'}</td>
                </>) : <td colSpan={3} className="px-4 py-3 text-xs text-muted-foreground">Loading...</td>}
                <td className="px-4 py-3 text-right"><Link href={`/admin-kit/agents/${id}`} className="text-accent hover:underline">Open</Link></td>
              </tr>
            );
          })}
        </tbody></table></div>
    </div>
  );
}

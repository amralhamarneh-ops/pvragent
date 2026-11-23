'use client';

import React, { useEffect, useState } from 'react';
import Badge from '@/components/ui/Badge';
import { AGENTS } from '@/lib/admin/registry';
import { loadTools, loadRuns, type ToolCheck } from '@/lib/admin/client';
import type { AgentRunRecord } from '@/lib/admin/adminStore';
import ProcessingToolsPanel from '@/app/new-pvr/components/ProcessingToolsPanel';

const stateTone = (s: string) => (s === 'passed' ? 'success' : s === 'failed' ? 'danger' : s === 'configured_untested' ? 'warning' : 'neutral') as 'success' | 'danger' | 'warning' | 'neutral';
const stateLabel = (s: string) => (s === 'configured_untested' ? 'Configured, not verified' : s === 'not_configured' ? 'Not configured' : s === 'passed' ? 'Passed' : s === 'failed' ? 'Failed' : s);

export default function ToolsConnections() {
  const [tools, setTools] = useState<ToolCheck[] | null>(null);
  const [runs, setRuns] = useState<AgentRunRecord[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => {
    loadTools().then((r) => setTools(r.tools)).catch((e) => setErr(e instanceof Error ? e.message : 'Tool check failed.'));
    loadRuns().then((r) => setRuns(r.runs)).catch(() => undefined);
  }, []);

  const agentsFor = (toolId: string) => AGENTS.filter((a) => a.tools.some((t) => t.id === toolId));
  const failedFor = (toolId: string) => runs.filter((r) => r.status === 'failed' && (r.tool === toolId || (toolId === 'openai' && r.tool === 'openai')));

  return (
    <div className="space-y-4">
      <div><h1 className="text-2xl font-bold text-foreground">Tools &amp; Connections</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Each connection is shown with the agents that use it. A set key is not a working connection: only a check that actually ran is shown as passed. A tool failure appears against the agent whose run hit it.</p></div>
      {err ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{err}</p> : null}
      <div className="grid gap-3 md:grid-cols-3">
        {(tools ?? []).map((t) => (
          <div key={t.id} className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between"><h2 className="text-sm font-semibold capitalize text-foreground">{t.id === 'openai' ? 'OpenAI model' : t.id === 'database' ? 'Supabase database' : 'Processing worker'}</h2><Badge tone={stateTone(t.state)}>{stateLabel(t.state)}</Badge></div>
            <p className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">{t.level} check</p>
            <p className="mt-2 text-sm text-muted-foreground">{t.detail}</p>
            <p className="mt-2 text-xs text-foreground">Used by: {agentsFor(t.id).map((a) => a.name).join(', ') || 'no agent'}</p>
            {failedFor(t.id).length ? <p className="mt-2 text-xs text-destructive">Recent failures: {Array.from(new Set(failedFor(t.id).map((r) => AGENTS.find((a) => a.id === r.agentId)?.name ?? r.agentId))).join(', ')} — {failedFor(t.id)[0].error}</p> : null}
          </div>
        ))}
        {!tools && !err ? <p className="text-sm text-muted-foreground">Running dependency checks...</p> : null}
      </div>
      <ProcessingToolsPanel />
    </div>
  );
}

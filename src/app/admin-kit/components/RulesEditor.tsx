'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Badge from '@/components/ui/Badge';
import * as api from '@/lib/admin/client';
import { CEILINGS, MAX_INSTRUCTION_CHARS, defaultRules, type AgentRules } from '@/lib/admin/rules';
import type { AgentConfigVersion } from '@/lib/admin/adminStore';

const tone = (s: string) => (s === 'published' ? 'success' : s === 'tested' ? 'info' : s === 'superseded' ? 'neutral' : 'warning') as 'success' | 'info' | 'neutral' | 'warning';

export default function RulesEditor({ agentId, protectedControls }: { agentId: string; protectedControls: string[] }) {
  const [data, setData] = useState<api.AgentDetailResponse | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [rules, setRules] = useState<AgentRules>(defaultRules(agentId));
  const [editing, setEditing] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [by, setBy] = useState('Admin');
  const ceil = CEILINGS[agentId];

  const reload = useCallback(async () => {
    try { setData(await api.loadAgent(agentId)); setErr(''); } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load configuration.'); }
  }, [agentId]);
  useEffect(() => { void reload(); }, [reload]);

  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(''); try { await fn(); await reload(); } catch (e) { setErr(e instanceof Error ? e.message : 'Failed.'); } finally { setBusy(false); } };

  const edit = (v: AgentConfigVersion) => { setRules(v.rules); setEditing(v.status === 'draft' || v.status === 'tested' ? v.version : null); setNote(`Based on version ${v.version}. `); };

  return (
    <section className="space-y-4" aria-label="Rules and versions">
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-foreground">Protected controls (not editable)</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">{protectedControls.map((p) => <li key={p}>{p}</li>)}</ul>
        <p className="mt-2 text-xs text-muted-foreground">The protected system prompt, validators, ownership checks and arithmetic stay in code. Guidance you write below is placed between two protected blocks and cannot override them.</p>
      </div>

      {err ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{err}</p> : null}
      {!data ? <p className="text-sm text-muted-foreground">Loading versions...</p> : null}

      {data ? (
        <>
          <p className="text-sm text-foreground">Published version: <strong>{data.publishedVersion ?? 'none (built-in rules in use)'}</strong>. New runs use it; a run already in progress keeps the version it started with.</p>
          <div className="rounded-lg border border-border bg-card p-4">
            <h3 className="text-sm font-semibold text-foreground">{editing ? `Editing draft version ${editing}` : 'New draft'}</h3>
            <label className="mt-3 block text-xs font-semibold text-muted-foreground" htmlFor="guidance">Additional guidance ({rules.additionalInstructions.length}/{MAX_INSTRUCTION_CHARS})</label>
            <textarea id="guidance" value={rules.additionalInstructions} onChange={(e) => setRules({ ...rules, additionalInstructions: e.target.value })} rows={4} className="mt-1 w-full rounded-md border border-border bg-background p-2 text-sm" placeholder="For example: Prefer the wording used in the BOQ preamble when naming a work type." />
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-semibold text-muted-foreground">Max items per call (1 to {ceil?.maxItems})
                <input type="number" min={1} max={ceil?.maxItems} value={rules.maxItems} onChange={(e) => setRules({ ...rules, maxItems: Number(e.target.value) })} className="mt-1 w-full rounded-md border border-border bg-background p-2 text-sm font-normal" /></label>
              <label className="text-xs font-semibold text-muted-foreground">Max characters per item (100 to {ceil?.maxCharsPerItem})
                <input type="number" min={100} max={ceil?.maxCharsPerItem} value={rules.maxCharsPerItem} onChange={(e) => setRules({ ...rules, maxCharsPerItem: Number(e.target.value) })} className="mt-1 w-full rounded-md border border-border bg-background p-2 text-sm font-normal" /></label>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-semibold text-muted-foreground">Change note<input value={note} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-background p-2 text-sm font-normal" /></label>
              <label className="text-xs font-semibold text-muted-foreground">Author / approver name<input value={by} onChange={(e) => setBy(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-background p-2 text-sm font-normal" /></label>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" disabled={busy} onClick={() => run(async () => { const r = await api.saveDraft(agentId, rules, note, by, editing ?? undefined); setEditing(r.version.version); })} className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{editing ? 'Save draft' : 'Create draft'}</button>
              {editing ? <button type="button" onClick={() => { setEditing(null); setRules(defaultRules(agentId)); setNote(''); }} className="rounded-md border border-border px-3 py-2 text-sm">Start a new draft</button> : null}
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-3 py-2">Version</th><th className="px-3 py-2">State</th><th className="px-3 py-2">Change</th><th className="px-3 py-2">Test</th><th className="px-3 py-2">Actions</th></tr></thead>
              <tbody>
                {data.versions.length === 0 ? <tr><td colSpan={5} className="px-3 py-4 text-muted-foreground">No versions yet. Runs use the built-in rules.</td></tr> : null}
                {data.versions.map((v) => (
                  <tr key={v.id} className="border-t border-border align-top">
                    <td className="px-3 py-2 font-semibold">v{v.version}{v.rolledBackFrom ? <span className="ml-1 text-xs font-normal text-muted-foreground">(rollback from v{v.rolledBackFrom})</span> : null}</td>
                    <td className="px-3 py-2"><Badge tone={tone(v.status)}>{v.status}</Badge></td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{v.changeNote || 'No note'} · {v.author} · {new Date(v.createdAt).toISOString().slice(0, 16).replace('T', ' ')}{v.publishedAt ? ` · published ${v.publishedAt.slice(0, 16).replace('T', ' ')} by ${v.publishedBy}` : ''}</td>
                    <td className="px-3 py-2 text-xs">
                      {v.testResult ? (<details><summary className={v.testResult.ok ? 'text-success' : 'text-destructive'}>{v.testResult.ok ? 'Passed' : 'Failed'} ({v.testResult.checks.filter((c) => c.ok).length}/{v.testResult.checks.length})</summary><ul className="mt-1 space-y-1">{v.testResult.checks.map((c) => <li key={c.name}>{c.ok ? '✓' : '✗'} {c.name}: <span className="text-muted-foreground">{c.detail}</span></li>)}</ul></details>) : <span className="text-muted-foreground">Not tested</span>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1.5">
                        <button type="button" onClick={() => edit(v)} className="rounded border border-border px-2 py-1 text-xs">{v.status === 'draft' || v.status === 'tested' ? 'Edit' : 'Copy to draft'}</button>
                        {(v.status === 'draft' || v.status === 'tested') ? <button type="button" disabled={busy} onClick={() => run(async () => { await api.testVersion(agentId, v.version); })} className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50">Run test</button> : null}
                        {v.status === 'tested' ? <button type="button" disabled={busy} onClick={() => run(async () => { await api.publishVersion(agentId, v.version, by); })} className="rounded bg-success px-2 py-1 text-xs font-semibold text-white disabled:opacity-50">Publish</button> : null}
                        {v.status === 'superseded' ? <button type="button" disabled={busy} onClick={() => run(async () => { await api.rollbackVersion(agentId, v.version, by); })} className="rounded bg-warning px-2 py-1 text-xs font-semibold text-foreground disabled:opacity-50">Roll back to this</button> : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

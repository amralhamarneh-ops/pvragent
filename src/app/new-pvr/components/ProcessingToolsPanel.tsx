'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, CircleDashed, CircleSlash, AlertTriangle, Loader2, Play, Ban } from 'lucide-react';
import Icon from '@/components/ui/AppIcon';


type Tier = 'startup' | 'functional' | 'accuracy';
type State = 'not_configured' | 'not_run' | 'passed' | 'failed' | 'unavailable';
interface Check { id: string; tool: string; tier: Tier; state: State; label: string; detail: string; operation?: string; metric?: string; testedAt?: string; durationMs?: number }

const META: Record<State, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  not_configured: { label: 'Not configured', cls: 'bg-muted text-muted-foreground', Icon: CircleSlash },
  unavailable: { label: 'Unavailable', cls: 'bg-warning/20 text-foreground', Icon: Ban },
  not_run: { label: 'Not run', cls: 'bg-muted text-muted-foreground', Icon: CircleDashed },
  passed: { label: 'Passed', cls: 'bg-success/15 text-success', Icon: CheckCircle2 },
  failed: { label: 'Failed', cls: 'bg-destructive/10 text-destructive', Icon: AlertTriangle },
};
const TIER: Record<Tier, { title: string; note: string }> = {
  startup: { title: 'Dependency / startup', note: 'The component loads or starts. Proves nothing about correct output.' },
  functional: { title: 'Functional file test', note: 'A real file is processed and a specific output is checked.' },
  accuracy: { title: 'Accuracy / benchmark', note: 'Output is compared with a known reference and a score is reported.' },
};
const TIERS: Tier[] = ['startup', 'functional', 'accuracy'];

/** Each tool's startup, functional and accuracy results are shown separately. A startup pass is never shown as a working tool. */
export default function ProcessingToolsPanel() {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState<string>('');
  const [err, setErr] = useState('');

  const load = useCallback(async (run: string) => {
    setBusy(run || 'init'); setErr('');
    try {
      const r = await fetch(`/api/processing/status${run ? `?run=${run}` : ''}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`Status check returned HTTP ${r.status}.`);
      const j = (await r.json()) as { checks: Check[] };
      // Keep earlier results for tiers that were not re-run.
      setChecks((prev) => (!prev || !run ? j.checks : j.checks.map((c) => (c.state === 'not_run' && c.tier !== run && run !== 'all' ? prev.find((p) => p.id === c.id && p.state !== 'not_run') ?? c : c))));
    } catch (e) { setErr(e instanceof Error ? e.message : 'Status check failed.'); }
    finally { setBusy(''); }
  }, []);
  useEffect(() => { void load(''); }, [load]);

  const tools = useMemo(() => { const m = new Map<string, Check[]>(); for (const c of checks ?? []) m.set(c.tool, [...(m.get(c.tool) ?? []), c]); return [...m.entries()]; }, [checks]);

  return (
    <section className="mt-3 rounded-md border border-border bg-card p-3" aria-label="Processing tools">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">Processing tools</h3>
        <div className="flex flex-wrap gap-1.5">
          {TIERS.map((t) => (
            <button key={t} type="button" onClick={() => void load(t)} disabled={!!busy} className="inline-flex items-center gap-1 rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60">
              {busy === t ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <Play size={12} aria-hidden />}Run {TIER[t].title.toLowerCase()}
            </button>
          ))}
        </div>
      </div>
      <ul className="mt-1 grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">{TIERS.map((t) => <li key={t}><span className="font-medium text-foreground">{TIER[t].title}:</span> {TIER[t].note}</li>)}</ul>
      {err && <p role="alert" className="mt-2 text-xs text-destructive">{err}</p>}
      <div className="mt-2 space-y-3">
        {tools.map(([tool, list]) => (
          <div key={tool} className="rounded border border-border">
            <p className="border-b border-border bg-muted/40 px-2 py-1 text-sm font-semibold text-foreground">{tool}</p>
            <ul className="divide-y divide-border">
              {TIERS.flatMap((t) => list.filter((c) => c.tier === t)).map((c) => {
                const m = META[c.state]; const Icon = m.Icon;
                return (
                  <li key={c.id} className="px-2 py-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm text-foreground"><span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">{TIER[c.tier].title}</span>{c.label}</span>
                      <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${m.cls}`}><Icon size={12} aria-hidden />{m.label}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{c.detail}</p>
                    {c.metric ? <p className="font-data text-xs text-foreground">Measured: {c.metric}</p> : null}
                    {c.testedAt ? <p className="font-data text-xs text-muted-foreground">Tested {new Date(c.testedAt).toLocaleString('en-GB')}{c.durationMs !== undefined ? ` · ${c.durationMs} ms` : ''}{c.operation ? ` · ${c.operation}` : ''}</p> : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {!checks && !err && <p className="text-xs text-muted-foreground">Checking configuration…</p>}
      </div>
    </section>
  );
}

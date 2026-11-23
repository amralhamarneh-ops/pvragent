'use client';

import React, { useState } from 'react';
import Badge from '@/components/ui/Badge';
import * as api from '@/lib/reference/client';
import { checkLeakage } from '@/lib/reference/lifecycle';
import { runEvaluation } from '@/lib/reference/evaluate';
import { EVAL_STAGES, type EvaluationRun, type PipelineOutput, type ReferenceCase } from '@/lib/reference/types';

interface Props { cases: ReferenceCase[]; evals: EvaluationRun[]; setEvals: (e: EvaluationRun[]) => void; live: boolean }

export default function EvaluationPanel({ cases, evals, setEvals, live }: Props) {
  const [json, setJson] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const evalCases = cases.filter((c) => c.partition === 'evaluation' && c.status !== 'retired');
  const leak = checkLeakage(cases);
  const latest = evals[0] ?? null;

  const parse = (): PipelineOutput[] => {
    if (!json.trim()) return [];
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) throw new Error('Pipeline output must be a JSON array, one entry per case.');
    return v as PipelineOutput[];
  };

  const run = async () => {
    setBusy(true); setErr('');
    try {
      const outputs = parse();
      const source = outputs.length ? 'Pipeline output pasted by the administrator' : 'No pipeline output supplied';
      const result = live ? (await api.evaluateLive(outputs, source)).run : runEvaluation(cases, outputs, source, new Date().toISOString(), `eval-${Date.now().toString(36)}`);
      setEvals([result, ...evals]);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Evaluation failed.'); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-base font-bold">Evaluation set</h2>
        <p className="mt-1 text-sm text-muted-foreground">Evaluation cases are held out. They are never retrieved for new assessments, and versions of one case stay together in a single set.</p>
        <p className="mt-2 text-sm">{evalCases.length} case(s) reserved: {evalCases.map((c) => c.title).join('; ') || 'none'}.</p>
        <p className={`mt-2 text-sm font-semibold ${leak.ok ? 'text-success' : 'text-destructive'}`}>{leak.ok ? 'No leakage detected between learning and evaluation sets.' : leak.issues.join(' ')}</p>
      </div>

      <div className="rounded-lg border border-border bg-card p-5">
        <h3 className="text-sm font-bold">Run evaluation</h3>
        <p className="mt-1 text-sm text-muted-foreground">Paste the output of the full processing pipeline for each evaluation case (JSON array of pipeline outputs). The comparison is against each case&apos;s reviewed expected record. Without pipeline output, nothing is scored.</p>
        <textarea value={json} onChange={(e) => setJson(e.target.value)} rows={6} aria-label="Pipeline output JSON" placeholder='[{"caseId":"...","documentsRead":[],"changesDetected":[],"quantities":[],"boqMappings":[],"activityIds":[],"simulatedDelayDays":null,"exceptionsFlagged":[]}]' className="mt-3 w-full rounded-md border border-border bg-background p-3 font-mono text-xs" />
        <button type="button" onClick={() => void run()} disabled={busy || evalCases.length === 0} className="mt-3 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">Run evaluation</button>
        {err ? <p role="alert" className="mt-2 text-sm text-destructive">{err}</p> : null}
      </div>

      {latest ? (
        <div className="space-y-4 rounded-lg border border-border bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-bold">Latest executed comparison</h3><span className="text-xs text-muted-foreground">{latest.runAt.slice(0, 19).replace('T', ' ')} | source: {latest.actualSource}</span></div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="py-2 pr-4">Stage</th><th className="py-2 pr-4">Compared</th><th className="py-2 pr-4">Matched</th><th className="py-2">Result</th></tr></thead>
              <tbody>
                {EVAL_STAGES.map((s) => { const r = latest.stages.find((x) => x.stage === s.key); return (
                  <tr key={s.key} className="border-t border-border"><td className="py-2 pr-4 font-semibold">{s.label}</td><td className="py-2 pr-4">{r?.compared ?? 0}</td><td className="py-2 pr-4">{r?.matched ?? 0}</td><td className="py-2">{r && r.rate !== null ? `${(r.rate * 100).toFixed(0)}% (${r.matched} of ${r.compared})` : <span className="text-muted-foreground">Not scored. {r?.note}</span>}</td></tr>
                ); })}
              </tbody>
            </table>
          </div>
          {latest.skipped.length ? <div className="rounded-md bg-warning/15 px-3 py-2 text-sm"><p className="font-semibold">Skipped</p><ul className="list-disc pl-5">{latest.skipped.map((s) => <li key={s.caseId}>{s.caseId}: {s.reason}</li>)}</ul></div> : null}
          <div>
            <h4 className="text-sm font-bold">Discrepancies retained for review ({latest.discrepancies.length})</h4>
            {latest.discrepancies.length ? (
              <ul className="mt-2 space-y-1 text-sm">{latest.discrepancies.map((d, i) => <li key={`${d.caseId}-${d.stage}-${i}`} className="rounded-md bg-muted px-3 py-2"><Badge tone="danger">{EVAL_STAGES.find((s) => s.key === d.stage)?.label}</Badge> {d.caseId} / {d.field}: expected <strong>{d.expected}</strong>, got <strong>{d.actual}</strong></li>)}</ul>
            ) : <p className="mt-1 text-sm text-muted-foreground">None in this run.</p>}
          </div>
          <p className="text-xs text-muted-foreground">These figures describe only this executed comparison. They are not a claim of general accuracy or of improvement over any earlier run.</p>
        </div>
      ) : <p className="text-sm text-muted-foreground">No evaluation has been run yet, so there are no accuracy figures to show.</p>}
    </div>
  );
}

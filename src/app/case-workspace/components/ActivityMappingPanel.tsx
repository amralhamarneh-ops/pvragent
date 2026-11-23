'use client';

import React, { useMemo, useState } from 'react';
import { AlertTriangle, CircleHelp, Loader2, Undo2 } from 'lucide-react';
import { mapAll, type LineMapping, type MappingChoices, type MappingUserChoice } from '@/lib/mapping/realActivityMapping';
import type { SharedLine } from '@/lib/mapping/sharedLines';
import type { ScheduleModel } from '@/lib/mapping/types';

export type ScheduleExclusion = { kind: 'schedule_only' | 'scenario'; reason: string; at: string };

interface Props {
  model: ScheduleModel | null;
  scheduleFileName: string;
  lines: SharedLine[];
  choices: MappingChoices;
  onChoices: (c: MappingChoices) => void;
  /** Line ids excluded from schedule assessment only, or from the whole scenario. */
  scheduleExclusions: Record<string, ScheduleExclusion>;
  onScheduleExclusion: (lineId: string, next: ScheduleExclusion | undefined) => void;
  /** Cost-side controls, reused from the cost review so one resolution model serves both screens. */
  onManualRate: (lineId: string) => void;
  onCreateItem: (lineId: string) => void;
  onExcludeCost: (lineId: string) => void;
  /** Postpone cost valuation only. Schedule scope is retained. */
  onDeferCost?: (lineId: string) => void;
  partialAccepted: boolean;
  onContinuePartial: () => void;
  running: boolean;
  onRetry: () => void;
  scheduleStale: boolean;
}

const STATE_LABEL: Record<LineMapping['state'], string> = {
  proposed: 'Proposed', accepted: 'Accepted', needs_question: 'Needs your input', new_activity: 'New activity proposed',
  not_applicable: 'Not applicable', deferred: 'Deferred', excluded: 'Excluded',
};
const STATE_TONE: Record<LineMapping['state'], string> = {
  proposed: 'bg-secondary text-secondary-foreground', accepted: 'bg-success/10 text-success', needs_question: 'bg-warning/20 text-foreground', new_activity: 'bg-warning/20 text-foreground',
  not_applicable: 'bg-muted text-muted-foreground', deferred: 'bg-muted text-foreground', excluded: 'bg-muted text-foreground',
};

export default function ActivityMappingPanel(p: Props) {
  const [broaden, setBroaden] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [exOpen, setExOpen] = useState(false);

  const active = useMemo(() => p.lines.filter((l) => !p.scheduleExclusions[l.lineId]), [p.lines, p.scheduleExclusions]);
  const result = useMemo(() => (p.model ? mapAll(active.map((l) => l.work), p.model, p.choices, { broaden }) : null), [p.model, active, p.choices, broaden]);
  const excluded = p.lines.filter((l) => p.scheduleExclusions[l.lineId]);

  const setChoice = (lineId: string, c: MappingUserChoice | undefined) => {
    const next = { ...p.choices };
    if (c) next[lineId] = c; else delete next[lineId];
    p.onChoices(next);
  };

  if (!p.model) {
    return (
      <section className="rounded-lg border border-border bg-card p-5 shadow-sm" aria-labelledby="am-title">
        <h2 id="am-title" className="text-lg font-semibold text-foreground">D. Activity mapping</h2>
        <p className="mt-2 text-foreground">No programme (.xer) has been read for this case yet.</p>
        <p className="text-sm text-muted-foreground">Upload a Primavera XER on the Documents screen. Cost work above is not blocked: you can confirm a priced or partial assessment without it. Nothing here uses sample activities.</p>
      </section>
    );
  }

  const m = result as NonNullable<typeof result>;
  const unresolved = m.mappings.filter((x) => x.state === 'needs_question').length;
  const modelWarnings = p.model.warnings ?? [];

  return (
    <section className="rounded-lg border border-border bg-card p-5 shadow-sm" aria-labelledby="am-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="am-title" className="text-lg font-semibold text-foreground">D. Activity mapping</h2>
        <p className="text-sm text-muted-foreground">{p.scheduleFileName} · {p.model.activityCount} activities · {p.model.relationships.filter((r) => r.resolved !== false).length} relationships{p.model.dataDate ? ` · data date ${p.model.dataDate}` : ''}</p>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">The agent reads each costed line as a work operation, searches the whole programme (names, WBS, codes, location, progress), checks construction sequence and activity type, then proposes. It asks only where evidence is missing.</p>

      {p.scheduleStale ? <p role="alert" className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">A scenario-wide scope change invalidated earlier schedule results. Mappings below are recomputed; recalculate the programme impact.</p> : null}
      {modelWarnings.length > 0 ? <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground">{modelWarnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
      {(p.model.productivityFields ?? []).length === 0
        ? <p className="mt-2 text-xs text-muted-foreground">This programme carries no usable productivity field, so durations for new work are not derived from it. They need a productivity basis you provide.</p>
        : <p className="mt-2 text-xs text-muted-foreground">Possible productivity fields found: {(p.model.productivityFields ?? []).map((f) => `${f.field} (${f.basis})`).join('; ')}. A unit must be confirmed before use.</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm" aria-label="Mapping coverage">
        <span className="rounded-full bg-secondary px-3 py-1 font-medium text-secondary-foreground">{m.counts.proposed + m.counts.accepted} mapped</span>
        <span className="rounded-full bg-warning/20 px-3 py-1 font-medium text-foreground">{m.counts.newActivity} new activity</span>
        <span className="rounded-full bg-warning/20 px-3 py-1 font-medium text-foreground">{unresolved} need input</span>
        <span className="rounded-full bg-muted px-3 py-1 font-medium text-foreground">{m.counts.deferred} deferred</span>
        <span className="rounded-full bg-muted px-3 py-1 font-medium text-foreground">{m.counts.notApplicable} not applicable</span>
        <span className="rounded-full bg-muted px-3 py-1 font-medium text-foreground">{excluded.length} excluded</span>
        <button type="button" onClick={() => { setBroaden((v) => !v); p.onRetry(); }} className="ml-auto inline-flex items-center gap-1 rounded-md border border-input bg-card px-3 py-1 font-medium hover:bg-muted">{p.running ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}{broaden ? 'Retry with default search' : 'Retry automatic mapping (broader search)'}</button>
      </div>

      {m.duplicateGuard.length > 0 ? <p className="mt-2 text-xs text-muted-foreground">Duplicate guard: {m.duplicateGuard.join('; ')}.</p> : null}
      {m.sharedActivities.length > 0 ? <p className="mt-2 text-xs text-muted-foreground">Shared activities (quantity is allocated, never repeated): {m.sharedActivities.map((s) => `${s.code} ← ${s.lines.length} lines`).join('; ')}.</p> : null}

      {p.lines.length === 0 ? <p className="mt-3 text-muted-foreground">No costed scope yet. Run the analysis above first.</p> : (
        <ul className="mt-3 space-y-3">
          {m.mappings.map((x) => {
            const line = p.lines.find((l) => l.lineId === x.lineId) as SharedLine;
            const isOpen = !!open[x.lineId];
            return (
              <li key={x.lineId} className="rounded-md border border-border bg-background p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-foreground">{x.name}</p>
                    <p className="text-xs text-muted-foreground">{line.source}{line.work.quantity ? ` · ${line.work.quantity} ${line.work.unit}` : ' · no quantity'}{line.priced ? '' : ' · unpriced'}</p>
                  </div>
                  <span className={`whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${STATE_TONE[x.state]}`}>{STATE_LABEL[x.state]}</span>
                </div>

                {x.allocations.length > 0 ? (
                  <ul className="mt-2 space-y-1 text-sm">
                    {x.allocations.map((a) => (
                      <li key={a.activityTaskId} className="flex flex-wrap items-center justify-between gap-2 rounded bg-card px-2 py-1">
                        <span><span className="font-data font-semibold text-foreground">{a.activityCode}</span> <span className="text-foreground">{a.activityName}</span></span>
                        <span className="tabular text-muted-foreground">{Math.round(Number(a.share) * 1000) / 10}%{a.quantity !== null ? ` · ${a.quantity} ${line.work.unit}` : ''}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {x.newActivity ? (
                  <div className="mt-2 rounded-md border border-warning/40 bg-warning/5 p-2 text-sm">
                    <p className="font-semibold text-foreground">Proposed new activity: {x.newActivity.name}</p>
                    <p className="text-muted-foreground">After {x.newActivity.predecessors.map((q) => `${q.code} (${q.type})`).join(', ') || 'no predecessor found'}{x.newActivity.successors.length ? `; before ${x.newActivity.successors.map((s) => s.code).join(', ')}` : ''}. Duration needs a productivity basis; none is invented.</p>
                  </div>
                ) : null}

                <p className="mt-2 text-sm text-foreground">{x.explanation}</p>
                {x.downstream.length > 0 ? <p className="mt-1 text-xs text-muted-foreground">Affected downstream, without receiving quantity: {x.downstream.map((d) => `${d.code} ${d.name}`).join('; ')}.</p> : null}

                {x.question ? (
                  <div className="mt-2 rounded-md border border-warning/40 bg-warning/10 p-3">
                    <p className="flex items-center gap-2 font-semibold text-foreground"><CircleHelp size={15} aria-hidden />{x.question.title}</p>
                    <p className="text-sm text-muted-foreground">{x.question.missing}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {x.question.options.map((o) => (
                        <button key={o.id} type="button" onClick={() => { if (o.activityTaskId) setChoice(x.lineId, { activityTaskIds: [o.activityTaskId] }); else if (o.id === 'new') setChoice(x.lineId, { wantsNewActivity: true }); else setChoice(x.lineId, { state: 'deferred', reason: 'Deferred by you; assessment continues.' }); }} className="rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted">{o.label}</button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {x.candidates.length > 0 ? (
                  <div className="mt-2">
                    <button type="button" aria-expanded={isOpen} onClick={() => setOpen((o) => ({ ...o, [x.lineId]: !o[x.lineId] }))} className="text-xs text-accent hover:underline">{isOpen ? 'Hide' : 'Show'} candidate activities ({x.candidates.length})</button>
                    {isOpen ? (
                      <ul className="mt-1 divide-y divide-border rounded-md border border-border text-sm">
                        {x.candidates.map((c) => (
                          <li key={c.activity.taskId} className="flex flex-wrap items-start justify-between gap-2 px-2 py-1.5">
                            <span className="min-w-0"><span className="font-data font-semibold text-foreground">{c.activity.code}</span> <span className="text-foreground">{c.activity.name}</span>
                              <span className="block text-xs text-muted-foreground">{c.activity.wbsPath || 'no WBS'} · {c.activity.kind.replace('_', ' ')} · {c.activity.status.replace('_', ' ')}{c.activity.status === 'in_progress' ? ` ${c.activity.progressPct}%` : ''} · score {c.score}</span>
                              {c.violations.length ? <span className="block text-xs text-destructive">Cannot take this work: {c.violations[0]}</span> : null}
                              {c.cautions.length && !c.violations.length ? <span className="block text-xs text-muted-foreground">{c.cautions[0]}</span> : null}</span>
                            <button type="button" disabled={!c.eligible} onClick={() => setChoice(x.lineId, { activityTaskIds: [...(p.choices[x.lineId]?.activityTaskIds ?? []).filter((id) => id !== c.activity.taskId), c.activity.taskId] })} className="shrink-0 rounded-md border border-input bg-card px-2 py-1 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50">{c.eligible ? 'Select' : 'Not valid'}</button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}

                <div className="mt-2 flex flex-wrap gap-2 text-xs" role="group" aria-label={`Resolve ${x.name}`}>
                  <button type="button" onClick={() => setChoice(x.lineId, undefined)} className="rounded-md border border-input bg-card px-2 py-1 font-medium hover:bg-muted">Retry automatic mapping</button>
                  <button type="button" onClick={() => setChoice(x.lineId, { wantsNewActivity: true })} className="rounded-md border border-input bg-card px-2 py-1 font-medium hover:bg-muted">Propose a new activity</button>
                  <button type="button" onClick={() => p.onManualRate(x.lineId)} className="rounded-md border border-input bg-card px-2 py-1 font-medium hover:bg-muted">Add / edit manual rate</button>
                  <button type="button" onClick={() => p.onCreateItem(x.lineId)} className="rounded-md border border-input bg-card px-2 py-1 font-medium hover:bg-muted">Create new assessment item</button>
                  <button type="button" onClick={() => setChoice(x.lineId, { state: 'deferred', reason: 'Deferred by you; assessment continues.' })} className="rounded-md border border-input bg-card px-2 py-1 font-medium hover:bg-muted">Defer and continue</button>
                  <button type="button" onClick={() => setChoice(x.lineId, { state: 'not_applicable', reason: 'Marked not applicable to the programme.' })} className="rounded-md border border-input bg-card px-2 py-1 font-medium hover:bg-muted">Not applicable</button>
                  <button type="button" onClick={() => p.onExcludeCost(x.lineId)} className="rounded-md border border-input bg-card px-2 py-1 font-medium hover:bg-muted">Exclude from cost only</button>
                  {p.onDeferCost ? <button type="button" onClick={() => p.onDeferCost!(x.lineId)} className="rounded-md border border-input bg-card px-2 py-1 font-medium hover:bg-muted">Defer cost valuation</button> : null}
                  <button type="button" onClick={() => p.onScheduleExclusion(x.lineId, { kind: 'schedule_only', reason: 'Excluded from schedule assessment by you.', at: new Date().toISOString() })} className="rounded-md border border-input bg-card px-2 py-1 font-medium hover:bg-muted">Exclude from schedule only</button>
                  <button type="button" onClick={() => p.onScheduleExclusion(x.lineId, { kind: 'scenario', reason: 'Excluded from this scenario by you.', at: new Date().toISOString() })} className="rounded-md border border-input bg-card px-2 py-1 font-medium hover:bg-muted">Exclude from scenario</button>
                  {p.choices[x.lineId]?.state ? <button type="button" onClick={() => setChoice(x.lineId, undefined)} className="inline-flex items-center gap-1 rounded-md border border-input bg-card px-2 py-1 font-medium hover:bg-muted"><Undo2 size={12} aria-hidden />Restore</button> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {excluded.length > 0 ? (
        <div className="mt-3 rounded-md border border-border">
          <button type="button" aria-expanded={exOpen} onClick={() => setExOpen((v) => !v)} className="w-full px-3 py-2 text-left text-sm font-semibold text-foreground">Excluded from schedule ({excluded.length})</button>
          {exOpen ? (
            <ul className="divide-y divide-border border-t border-border text-sm">
              {excluded.map((l) => { const e = p.scheduleExclusions[l.lineId]; return (
                <li key={l.lineId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span><span className="font-medium text-foreground">{l.name}</span> <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">{e.kind === 'scenario' ? 'Excluded from scenario' : 'Schedule excluded'}</span><span className="block text-xs text-muted-foreground">{e.reason} · {e.at.slice(0, 16).replace('T', ' ')}. Baseline activities and logic used by other scope are untouched.</span></span>
                  <button type="button" onClick={() => p.onScheduleExclusion(l.lineId, undefined)} className="inline-flex items-center gap-1 rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted"><Undo2 size={13} aria-hidden />Restore</button>
                </li>
              ); })}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 rounded-md border border-border bg-background px-3 py-2 text-sm" aria-label="Coverage">
        <p className="flex items-start gap-2 text-foreground">{unresolved > 0 || m.counts.deferred > 0 ? <AlertTriangle size={15} className="mt-0.5 text-warning" aria-hidden /> : null}
          {unresolved + m.counts.deferred > 0 ? `${unresolved + m.counts.deferred} line(s) have no confirmed activity. Their time impact is unknown - it is not zero.` : 'Every executing line has an activity or a new-activity proposal.'}</p>
        <button type="button" onClick={p.onContinuePartial} disabled={p.partialAccepted} className="mt-2 rounded-md border border-input bg-card px-3 py-1.5 font-medium hover:bg-muted disabled:opacity-60">{p.partialAccepted ? 'Continuing with partial assessment' : 'Continue with partial assessment'}</button>
      </div>
    </section>
  );
}

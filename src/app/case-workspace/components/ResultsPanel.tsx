'use client';

import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { D, formatMoney } from '@/lib/assessment/decimal';
import { addDays, dayDiff, drivingPath, toUtc } from '@/lib/assessment/cpmEngine';
import type { AssessmentStore } from '@/lib/assessment/useAssessment';

const inp = 'w-full rounded-md border border-input bg-card px-3 py-2';

function Gantt({ a }: { a: AssessmentStore }) {
  const { baseNetwork, unimpactedResult, impactedResult, comparison } = a;
  const rows = useMemo(() => {
    if (!baseNetwork || !unimpactedResult?.ok || !impactedResult?.ok) return [];
    return impactedResult.order.map((id) => ({ id, name: (a.impactedNetwork?.activities.find((x) => x.id === id)?.name ?? id), before: unimpactedResult.activities[id], after: impactedResult.activities[id] }));
  }, [baseNetwork, unimpactedResult, impactedResult, a.impactedNetwork]);
  if (!rows.length) return null;
  const all = rows.flatMap((r) => [r.before?.earlyStart, r.before?.earlyFinish, r.after.earlyStart, r.after.earlyFinish].filter(Boolean) as string[]);
  const min = all.reduce((m, d) => (toUtc(d) < toUtc(m) ? d : m), all[0]);
  const max = all.reduce((m, d) => (toUtc(d) > toUtc(m) ? d : m), all[0]);
  const span = Math.max(1, dayDiff(min, max) + 1);
  const pct = (d: string) => (dayDiff(min, d) / span) * 100;
  const bar = (s: string, f: string) => ({ left: `${pct(s)}%`, width: `${Math.max(0.6, ((dayDiff(s, f) + 1) / span) * 100)}%` });
  const dd = a.state.dataDate;
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[760px]" role="img" aria-label="Before and after Gantt overlay">
        <div className="relative mb-1 ml-60 h-5 text-sm text-muted-foreground"><span className="absolute left-0">{min}</span><span className="absolute right-0">{max}</span></div>
        {rows.map((r) => (
          <div key={r.id} className="flex items-center border-t border-border py-1.5">
            <div className="w-60 shrink-0 pr-3"><p className="truncate font-medium text-foreground"><span className="font-data">{r.id}</span> {r.name}</p></div>
            <div className="relative h-8 flex-1">
              <div className="absolute inset-y-0 w-px bg-warning" style={{ left: `${pct(dd)}%` }} title={`Data date ${dd}`} />
              {r.before ? <div className="absolute top-0.5 h-3 rounded-sm border border-primary bg-primary/20" style={bar(r.before.earlyStart, r.before.earlyFinish)} title={`Before ${r.before.earlyStart} to ${r.before.earlyFinish}`} /> : null}
              <div className={`absolute bottom-0.5 h-3 rounded-sm ${r.after.critical ? 'bg-destructive' : 'bg-accent'}`} style={bar(r.after.earlyStart, r.after.earlyFinish)} title={`After ${r.after.earlyStart} to ${r.after.earlyFinish}`} />
            </div>
          </div>
        ))}
        <p className="mt-2 text-sm text-muted-foreground">Outlined bar = unimpacted recalculation. Solid bar = impacted scenario (red when critical). Thin line = data date. {comparison ? '' : ''}</p>
      </div>
    </div>
  );
}

export default function ResultsPanel({ a }: { a: AssessmentStore }) {
  const { comparison, cost, state, patch, impactedResult, unimpactedResult, baseNetwork } = a;
  const [open, setOpen] = useState<string | null>(null);
  const [pathFor, setPathFor] = useState('C4090');
  const stale = a.stale;
  const names = (id: string) => a.impactedNetwork?.activities.find((x) => x.id === id)?.name ?? baseNetwork?.activities.find((x) => x.id === id)?.name ?? id;
  const path = impactedResult?.ok ? drivingPath(impactedResult, pathFor) : [];
  const eotInvalid = !a.state.scheduleConfirmed || a.validation?.verdict === 'not_reproduced' || (a.validation?.verdict === 'differences_within_tolerance' && !state.plannerAccepted);

  return (
    <div className="space-y-6">
      <section aria-label="Run identity" className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-foreground">Assessment version {state.assessmentVersion}</h3>
            <p className="text-muted-foreground">Cost and time results below read the same Mapping v{a.state.frozen?.inputs.mappingVersion ?? 1} inputs and one scheduling engine.</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={a.freeze} className="rounded-md bg-primary px-4 py-2.5 font-semibold text-primary-foreground hover:opacity-90">Freeze this run</button>
            <button type="button" onClick={a.newVersion} className="rounded-md border border-input bg-card px-4 py-2.5 font-medium hover:bg-muted">Start new assessment version</button>
          </div>
        </div>
        {state.frozen ? (
          <dl className={`mt-3 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4 ${stale ? 'opacity-70' : ''}`}>
            <div><dt className="text-muted-foreground">Run</dt><dd className="font-data">{state.frozen.runId}</dd></div>
            <div><dt className="text-muted-foreground">Engine</dt><dd>{state.frozen.engineVersion}</dd></div>
            <div><dt className="text-muted-foreground">Inputs</dt><dd className="font-data">mapping v{state.frozen.inputs.mappingVersion}, {state.frozen.inputs.scheduleVersion}, DD {state.frozen.inputs.dataDate}</dd></div>
            <div><dt className="text-muted-foreground">Input hash</dt><dd className="font-data">{state.frozen.inputHash}</dd></div>
            <div className="sm:col-span-2 lg:col-span-4"><dt className="text-muted-foreground">Assumptions</dt><dd>{state.frozen.assumptions.join(' ')}</dd></div>
          </dl>
        ) : <p className="mt-3 text-muted-foreground">Not frozen. Freeze to record inputs, assumptions, settings and engine version.</p>}
        {stale ? <p role="alert" className="mt-3 rounded-md border-2 border-warning bg-warning/5 p-3 font-medium text-foreground">Inputs changed after this run was frozen. The frozen results are historical. Freeze again or start a new version.</p> : null}
      </section>

      <section aria-label="Cost result" className="rounded-lg border border-border bg-card p-5">
        <h3 className="font-semibold text-foreground">Cost</h3>
        <p className="mt-1 text-2xl font-semibold text-foreground">{formatMoney(D(cost.netAssessed), cost.currency)} <span className="text-base font-normal text-muted-foreground">{cost.isComplete ? 'assessed net' : `priced subtotal, plus ${cost.unpricedLines.length} unpriced item(s)`}</span></p>
        <details className="mt-3"><summary className="cursor-pointer font-medium text-accent">Trace each line to its source</summary>
          <ul className="mt-2 space-y-2">{cost.lines.map((l) => <li key={l.id} className="rounded-md bg-muted p-3"><p className="font-medium text-foreground"><span className="font-data">{l.boqRef}</span> {l.description}</p><p className="text-muted-foreground">Mapping item {l.componentId} → change {a.components.find((c) => c.id === l.componentId)?.changeIds.join(', ') || 'none'} → quantity {l.quantity} {l.unit} → rate {l.rateId ?? 'none'} ({l.rateSource ?? 'unpriced'})</p></li>)}</ul>
        </details>
      </section>

      {!baseNetwork ? (
        <div className="rounded-lg border-2 border-warning bg-warning/5 p-5"><p className="font-semibold text-foreground">Programme impact unavailable: no schedule loaded.</p><p className="text-muted-foreground">Forecast completion impact is not shown as zero. Cost results above remain usable.</p></div>
      ) : !comparison ? (
        <div className="rounded-lg border-2 border-warning bg-warning/5 p-5">
          <p className="font-semibold text-foreground">Programme impact is unavailable.</p>
          <ul className="list-disc pl-5 text-muted-foreground">
            {a.state.engineId !== 'embedded' ? <li>The selected engine ({a.engines[a.state.engineId].info().name}) has no results here. {a.engines[a.state.engineId].info().statusNote}</li> : null}
            {!a.fragnetOk ? <li>The fragnet has errors. Fix them in the Programme tab.</li> : null}
            {a.state.strategy === 'increase_remaining' && !a.duration.ok ? <li>Duration inputs are incomplete: {a.duration.errors[0]}</li> : null}
            {['resequence', 'change_resources', 'time_only_disruption'].includes(a.state.strategy) ? <li>The selected strategy has no modelled logic yet.</li> : null}
          </ul>
        </div>
      ) : (
        <>
          <section aria-label="Forecast completion" className="rounded-lg border border-border bg-card p-5">
            <h3 className="font-semibold text-foreground">Forecast completion impact</h3>
            <div className="mt-3 grid gap-4 sm:grid-cols-4">
              <div><p className="text-muted-foreground">Completion before</p><p className="font-data text-xl">{comparison.completionBefore}</p></div>
              <div><p className="text-muted-foreground">Completion after</p><p className="font-data text-xl">{comparison.completionAfter}</p></div>
              <div><p className="text-muted-foreground">Working-day movement</p><p className="font-data text-xl">{comparison.workingDaysMoved} d</p></div>
              <div><p className="text-muted-foreground">Calendar-date movement</p><p className="font-data text-xl">{comparison.calendarDaysMoved} d</p></div>
            </div>
            <p className="mt-3 text-muted-foreground">{comparison.basisNote} Pre-existing variance against the contractual baseline is shown separately and is not part of this impact.</p>
            {eotInvalid ? <p className="mt-2 rounded-md bg-warning/10 p-3 text-foreground">Confirm the schedule and data date, and resolve the unchanged-copy comparison, before relying on this movement.</p> : null}
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <label>Claimed EOT (days)<input value={state.claimedEot} onChange={(e) => patch({ claimedEot: e.target.value })} className={inp} inputMode="numeric" /></label>
              <label>Assessed EOT (days)<input value={state.assessedEot} onChange={(e) => patch({ assessedEot: e.target.value })} className={inp} inputMode="numeric" /></label>
              <label>Approved EOT (days)<input value={state.approvedEot} disabled placeholder="Set only by an approval" className={`${inp} bg-muted`} /></label>
            </div>
            <p className="mt-2 text-muted-foreground">Forecast movement is not an EOT. Approved EOT is set only by the approval workflow, never by this calculation. Approving a PVR does not change the baseline or the contractual completion date.</p>
          </section>

          <section aria-label="Milestones" className="rounded-lg border border-border bg-card p-5">
            <h3 className="font-semibold text-foreground">Milestone comparison</h3>
            <table className="mt-3 w-full text-left text-sm"><thead className="border-b border-border"><tr><th className="py-2">Milestone</th><th>Before</th><th>After</th><th>Working days</th><th>Calendar days</th></tr></thead>
              <tbody>{comparison.milestones.map((m) => <tr key={m.id} className="border-b border-border"><td className="py-2">{m.name}</td><td className="font-data">{m.before}</td><td className="font-data">{m.after}</td><td className="font-data">{m.workingDays}</td><td className="font-data">{m.calendarDays}</td></tr>)}</tbody></table>
          </section>

          <section aria-label="Gantt" className="rounded-lg border border-border bg-card p-5"><h3 className="mb-3 font-semibold text-foreground">Before and after Gantt</h3><Gantt a={a} /></section>

          <section aria-label="Activity impacts" className="rounded-lg border border-border bg-card p-5">
            <h3 className="font-semibold text-foreground">Directly changed and consequentially affected activities</h3>
            <p className="text-muted-foreground">{comparison.direct.length} direct, {comparison.consequential.length} consequential, {comparison.newlyCritical.length} newly critical, {comparison.nearCritical.length} newly near-critical (float 10 days or less).</p>
            <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-border"><tr><th className="py-2">Activity</th><th>Type of effect</th><th>Finish before → after</th><th>Float before → after</th><th>Float used</th></tr></thead>
              <tbody>{comparison.deltas.filter((d) => d.directlyChanged || d.calendarDaysMoved !== 0 || d.floatConsumed !== 0).map((d) => (
                <React.Fragment key={d.id}>
                  <tr className="border-b border-border">
                    <td className="py-2"><button type="button" onClick={() => setOpen(open === d.id ? null : d.id)} className="flex items-center gap-1 text-left font-medium text-accent">{open === d.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span className="font-data">{d.id}</span> {d.name}</button></td>
                    <td>{d.directlyChanged ? 'Direct' : 'Consequential'}{d.becameCritical ? ', newly critical' : d.becameNearCritical ? ', near-critical' : ''}</td>
                    <td className="font-data">{d.finishBefore || 'new'} → {d.finishAfter}</td><td className="font-data">{d.floatBefore} → {d.floatAfter}</td><td className="font-data">{d.floatConsumed}</td>
                  </tr>
                  {open === d.id ? <tr><td colSpan={5} className="bg-muted px-3 py-2 text-muted-foreground">Trace: {d.isNew ? 'new fragnet activity' : 'existing activity'} · source: {a.state.strategy === 'increase_remaining' ? `duration derived from ${a.state.productivity.quantity} ${a.state.productivity.unit} (${a.state.productivity.source})` : 'fragnet FRAG-PVR-0418 → BoQ mapping BM-01/BM-02 → change quantity +2,000 m'} · driving predecessor {impactedResult?.activities[d.id]?.drivingPredecessor ?? 'none'}</td></tr> : null}
                </React.Fragment>
              ))}</tbody>
            </table></div>
          </section>

          <section aria-label="Dependency path" className="rounded-lg border border-border bg-card p-5">
            <h3 className="font-semibold text-foreground">Driving dependency path</h3>
            <label className="mt-2 block max-w-sm">Trace back from<select value={pathFor} onChange={(e) => setPathFor(e.target.value)} className={inp}>{(a.impactedNetwork?.activities ?? []).map((x) => <option key={x.id} value={x.id}>{x.id} {x.name}</option>)}</select></label>
            <ol className="mt-3 flex flex-wrap items-center gap-2">{path.map((id, i) => <li key={id} className="flex items-center gap-2"><span className={`rounded-md border px-3 py-1.5 ${impactedResult?.activities[id]?.critical ? 'border-destructive bg-destructive/10' : 'border-border bg-muted'}`}><span className="font-data">{id}</span> {names(id)}</span>{i < path.length - 1 ? <span aria-hidden>→</span> : null}</li>)}</ol>
          </section>
        </>
      )}

      <section aria-label="Scenarios" className="rounded-lg border border-border bg-card p-5">
        <h3 className="font-semibold text-foreground">Scenario comparison</h3>
        <table className="mt-3 w-full text-left text-sm">
          <thead className="border-b border-border"><tr><th className="py-2">Scenario</th><th>Kind</th><th>Completion</th><th>Net cost</th></tr></thead>
          <tbody>
            <tr className="border-b border-border"><td className="py-2">Unchanged reference</td><td>Reference</td><td className="font-data">{unimpactedResult?.ok ? unimpactedResult.projectFinish : 'Unavailable'}</td><td className="font-data">0</td></tr>
            <tr className="border-b border-border"><td className="py-2">Change scenario (PVR-0418)</td><td>Change</td><td className="font-data">{impactedResult?.ok ? impactedResult.projectFinish : 'Unavailable'}</td><td className="font-data">{formatMoney(D(cost.netAssessed), cost.currency)}{cost.isComplete ? '' : ' (subtotal)'}</td></tr>
            <tr><td className="py-2 text-muted-foreground">Mitigation scenarios</td><td>Optional</td><td colSpan={2} className="text-muted-foreground">None defined. Cumulative changes must be modelled together in one network, never as summed standalone delays.</td></tr>
          </tbody>
        </table>
      </section>

      <section aria-label="Buffer and contingency" className="rounded-lg border border-border bg-card p-5">
        <h3 className="font-semibold text-foreground">Contingency and schedule buffer</h3>
        <p className="mt-1 text-muted-foreground">No approved contingency or buffer definition is attached to this case, so no headroom is shown. Activity float is not a management buffer and is not netted against one. Approving a PVR never consumes contingency or revises a baseline automatically.</p>
      </section>

      <section aria-label="Limitations" className="rounded-lg border border-border bg-card p-5">
        <h3 className="font-semibold text-foreground">Calculation limitations and unresolved assumptions</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-foreground">
          {(impactedResult?.issues ?? unimpactedResult?.issues ?? []).filter((i) => i.severity !== 'error').slice(0, 10).map((i, k) => <li key={k}>{i.message}</li>)}
          {cost.unpricedLines.length ? <li>{cost.unpricedLines.length} BoQ item(s) have no usable rate.</li> : null}
          <li>Programme and rates shown are clearly labelled synthetic sample data, not live project values.</li>
        </ul>
      </section>
      <p className="hidden">{addDays('2026-01-01', 0)}</p>
    </div>
  );
}

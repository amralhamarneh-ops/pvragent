'use client';

import React, { useState } from 'react';
import { AlertTriangle, Download, Info } from 'lucide-react';
import { PRODUCTIVITY_LABEL, RESOURCE_KIND_LABEL, type ProductivityBasis, type ResourceFieldKind } from '@/lib/assessment/productivity';
import { STRATEGY_LABEL, type WorkStrategy } from '@/lib/assessment/workModel';
import { buildHandoff, reconcileImport, type HandoffPackage, type ReconcileReport } from '@/lib/assessment/schedulingEngine';
import { calculateCpm } from '@/lib/assessment/cpmEngine';
import type { AssessmentStore } from '@/lib/assessment/useAssessment';

const inp = 'w-full rounded-md border border-input bg-card px-3 py-2';

function download(name: string, text: string, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function ProgrammePanel({ a }: { a: AssessmentStore }) {
  const { state, patch, duration, validation, fragnetIssues, baseNetwork, engines } = a;
  const [csv, setCsv] = useState('');
  const [levelled, setLevelled] = useState<'unknown' | 'yes' | 'no'>('unknown');
  const [reconcile, setReconcile] = useState<ReconcileReport | null>(null);
  const [pkg, setPkg] = useState<HandoffPackage | null>(null);
  const p = state.productivity;
  const setP = (x: Partial<typeof p>) => patch({ productivity: { ...p, ...x } });
  const f = state.fragnet;
  const engine = engines[state.engineId];
  const info = engine.info();

  if (!baseNetwork) {
    return (
      <div className="rounded-lg border-2 border-warning bg-warning/5 p-5">
        <p className="font-semibold text-foreground">Programme impact is unavailable.</p>
        <p className="text-muted-foreground">No schedule is loaded for this case. Cost assessment can continue. Add a baseline schedule in the project reference library to calculate time. Time results are shown as unavailable, not as zero days.</p>
      </div>
    );
  }

  const makeHandoff = () => {
    const req = { caseId: state.caseId, scenarioId: 'SC-CHG', assessmentVersion: state.assessmentVersion, network: baseNetwork };
    const h = buildHandoff(req, f, [], ['XER user-defined fields and resource assignments are not included in this export.', 'Activity codes, notebook topics and baseline snapshots are not exported.']);
    setPkg(h);
    download(`${h.handoffId}.json`, JSON.stringify(h, null, 2));
  };
  const doReconcile = () => {
    if (!pkg) return;
    const ids = [...baseNetwork.activities.map((x) => x.id), ...f.activities.map((x) => x.id)];
    setReconcile(reconcileImport(csv, pkg, ids, levelled === 'unknown' ? null : levelled === 'yes').report);
  };

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border bg-card p-5" aria-label="Scheduling engine">
        <h3 className="font-semibold text-foreground">Scheduling engine</h3>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          {Object.values(engines).map((e) => {
            const i = e.info();
            return (
              <label key={i.id} className={`cursor-pointer rounded-lg border p-3 ${state.engineId === i.id ? 'border-accent bg-accent/5' : 'border-border'}`}>
                <span className="flex items-center gap-2 font-semibold text-foreground"><input type="radio" name="engine" checked={state.engineId === i.id} onChange={() => patch({ engineId: i.id })} />{i.name}</span>
                <span className="mt-1 block text-muted-foreground">{i.available ? 'Available' : 'Unavailable'} · {i.status.replace('_', ' ')}</span>
                <span className="mt-1 block text-sm text-muted-foreground">{i.statusNote}</span>
              </label>
            );
          })}
        </div>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-muted-foreground">{info.capabilities.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        {state.engineId === 'p6-service' ? <p className="mt-3 text-foreground">To enable: set P6_SERVICE_URL and P6_SERVICE_TOKEN on the server, then run the unchanged-copy validation. Until then no P6 results are shown.</p> : null}
      </section>

      <section className="rounded-lg border border-border bg-card p-5" aria-label="Reference schedule validation">
        <h3 className="font-semibold text-foreground">Reference schedule and engine validation</h3>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-md bg-muted px-3 py-2"><dt className="text-muted-foreground">Contractual baseline</dt><dd>Reference only</dd></div>
          <div className="rounded-md bg-muted px-3 py-2"><dt className="text-muted-foreground">Accepted update (selected)</dt><dd>FIR_Baseline_Oct26</dd></div>
          <div className="rounded-md bg-muted px-3 py-2"><dt className="text-muted-foreground">Unimpacted recalculated copy</dt><dd>{a.unimpactedResult?.ok ? 'Calculated' : 'Not calculated'}</dd></div>
          <div className="rounded-md bg-muted px-3 py-2"><dt className="text-muted-foreground">Impacted scenario</dt><dd>{a.impactedResult?.ok ? 'Calculated' : 'Not calculated'}</dd></div>
        </dl>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2">Data date<input type="date" value={state.dataDate} onChange={(e) => patch({ dataDate: e.target.value })} className="rounded-md border border-input bg-card px-3 py-2" /></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={state.scheduleConfirmed} onChange={(e) => patch({ scheduleConfirmed: e.target.checked })} />I confirm this schedule and data date</label>
          <label className="flex items-center gap-2">Tolerance (working days)<input type="number" min={0} value={state.tolerance} onChange={(e) => patch({ tolerance: Math.max(0, Number(e.target.value)) })} className="w-20 rounded-md border border-input bg-card px-3 py-2" /></label>
        </div>
        {validation ? (
          <div className="mt-4">
            <p className="font-semibold text-foreground">{validation.verdict === 'reproduced' ? `Unchanged copy reproduces the source: ${validation.compared} activities compared, no date, float or milestone differences.` : validation.verdict === 'differences_within_tolerance' ? 'Differences found, all within the stated tolerance. Planner acceptance required.' : 'The unchanged copy does not reproduce the source schedule. Do not rely on impact results.'}</p>
            {[...validation.mismatches, ...validation.milestoneMismatches].slice(0, 6).map((m) => <p key={`${m.id}${m.field}`} className="font-data text-sm">{m.id} {m.field}: source {String(m.source)}, recalculated {String(m.recalculated)} ({m.difference} d)</p>)}
            <details className="mt-3"><summary className="cursor-pointer font-medium text-accent">Settings captured or still needed</summary>
              <ul className="mt-2 space-y-1">{validation.requiredSettings.map((s) => <li key={s.key} className="flex gap-2"><span className={s.present ? 'text-success' : 'text-warning'}>{s.present ? 'Set' : 'Needs review'}</span><span><span className="font-medium">{s.key}.</span> {s.note}</span></li>)}</ul>
            </details>
            <p className="mt-3 flex items-start gap-2 text-muted-foreground"><Info size={16} className="mt-1 shrink-0" />Reading an XER successfully does not establish P6-equivalent behaviour. Equivalence is shown only by this comparison for the stated settings.</p>
          </div>
        ) : null}
        <div className="mt-3">
          <label className="block font-medium text-foreground" htmlFor="accept">Planner acceptance of tolerance</label>
          <div className="mt-1 flex flex-wrap gap-2">
            <input id="accept" className={`${inp} max-w-md`} placeholder="Reason for accepting these differences" onChange={(e) => patch({ plannerAccepted: e.target.value.trim() ? { by: 'Omar Haddad (Planner)', at: new Date().toISOString(), reason: e.target.value } : null })} />
            <span className="self-center text-muted-foreground">{state.plannerAccepted ? `Recorded by ${state.plannerAccepted.by}` : 'Not accepted'}</span>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-5" aria-label="Productivity and duration">
        <h3 className="font-semibold text-foreground">Productivity is not duration</h3>
        <div className="mt-3 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          <label>Basis<select value={p.basis} onChange={(e) => setP({ basis: e.target.value as ProductivityBasis })} className={inp}>{(Object.keys(PRODUCTIVITY_LABEL) as ProductivityBasis[]).map((k) => <option key={k} value={k}>{PRODUCTIVITY_LABEL[k]}</option>)}</select></label>
          <label>Quantity<input value={p.quantity} onChange={(e) => setP({ quantity: e.target.value })} className={inp} inputMode="decimal" /></label>
          <label>Unit<input value={p.unit} onChange={(e) => setP({ unit: e.target.value })} className={inp} /></label>
          <label>Source<input value={p.source} onChange={(e) => setP({ source: e.target.value })} className={inp} /></label>
          <label>Working calendar<select value={p.calendarId} onChange={(e) => setP({ calendarId: e.target.value })} className={inp}>{baseNetwork.calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label>Rounding<select value={p.roundingMode ?? 'up'} onChange={(e) => setP({ roundingMode: e.target.value as 'up' | 'half_up' | 'none' })} className={inp}><option value="up">Round up</option><option value="half_up">Round half up</option><option value="none">None before calendar placement</option></select></label>
          {p.basis === 'crew_output' ? <label>Approved crew output per working day ({p.unit}/day)<input value={p.outputPerDay ?? ''} onChange={(e) => setP({ outputPerDay: e.target.value })} className={inp} inputMode="decimal" placeholder="Required" /></label> : null}
          {p.basis === 'planner_duration' ? <><label>Planner duration (working days)<input value={p.plannerDurationDays ?? ''} onChange={(e) => setP({ plannerDurationDays: e.target.value })} className={inp} /></label><label className="md:col-span-2">Justification<input value={p.plannerJustification ?? ''} onChange={(e) => setP({ plannerJustification: e.target.value })} className={inp} /></label></> : null}
          {p.basis !== 'crew_output' && p.basis !== 'planner_duration' ? <>
            <label>Hours per {p.unit}<input value={p.hoursPerUnit ?? ''} onChange={(e) => setP({ hoursPerUnit: e.target.value })} className={inp} inputMode="decimal" /></label>
            <label>Resources (people, crews or items)<input value={p.resourceCount ?? ''} onChange={(e) => setP({ resourceCount: e.target.value })} className={inp} inputMode="decimal" /></label>
            <label>Effective hours per resource per day<input value={p.effectiveHoursPerResourcePerDay ?? ''} onChange={(e) => setP({ effectiveHoursPerResourcePerDay: e.target.value })} className={inp} inputMode="decimal" /></label>
          </> : null}
          <label className="md:col-span-2">Override note (optional)<input value={p.overrideNote ?? ''} onChange={(e) => setP({ overrideNote: e.target.value })} className={inp} /></label>
        </div>
        <div className="mt-4 rounded-md bg-muted p-4">
          <p className="font-medium text-foreground">{duration.formula}</p>
          {duration.ok ? (
            <>
              <ul className="mt-2 space-y-1 font-data text-sm">{duration.steps.map((s) => <li key={s}>{s}</li>)}</ul>
              <p className="mt-2 font-semibold text-foreground">Result: {duration.roundedWorkingDays} working days (calendar placement happens in the schedule run).</p>
            </>
          ) : <ul className="mt-2 space-y-1">{duration.errors.map((e) => <li key={e} className="flex items-start gap-2 text-foreground"><AlertTriangle size={16} className="mt-1 shrink-0 text-warning" />{e}</li>)}<li className="text-muted-foreground">No duration is assumed. Time results needing it stay unavailable.</li></ul>}
          <p className="mt-2 text-muted-foreground">Efficiency is applied once, inside the effective hours you enter. Resource units from a schedule are not treated as physical quantities.</p>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-5" aria-label="Resource field mapping">
        <h3 className="font-semibold text-foreground">Productivity field mapping</h3>
        <p className="mt-1 text-muted-foreground">Fields found in the schedule. Nothing is used until a planner maps and verifies it.</p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-border"><tr><th className="py-2 pr-3">Source field</th><th className="pr-3">Sample</th><th className="pr-3">Use as</th><th>Verified</th></tr></thead>
            <tbody className="divide-y divide-border">
              {state.fieldMaps.map((m, i) => (
                <tr key={m.sourceField}>
                  <td className="py-2 pr-3">{m.sourceField}<span className="block text-muted-foreground">{m.origin.replace('_', ' ')}</span></td>
                  <td className="pr-3 font-data">{m.sampleValue || 'empty'} {m.unit}</td>
                  <td className="pr-3"><select aria-label={`Use ${m.sourceField} as`} value={m.mappedTo} onChange={(e) => patch({ fieldMaps: state.fieldMaps.map((x, j) => (j === i ? { ...x, mappedTo: e.target.value as ResourceFieldKind } : x)) })} className="rounded-md border border-input bg-card px-2 py-1.5">{(Object.keys(RESOURCE_KIND_LABEL) as ResourceFieldKind[]).map((k) => <option key={k} value={k}>{RESOURCE_KIND_LABEL[k]}</option>)}</select></td>
                  <td><label className="flex items-center gap-2"><input type="checkbox" checked={m.reliability === 'planner_verified'} onChange={(e) => patch({ fieldMaps: state.fieldMaps.map((x, j) => (j === i ? { ...x, reliability: e.target.checked ? 'planner_verified' : 'unverified' } : x)) })} />Planner verified</label></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-5" aria-label="Work strategy and fragnet">
        <h3 className="font-semibold text-foreground">How the change enters the programme</h3>
        <label className="mt-2 block max-w-xl">Strategy<select value={state.strategy} onChange={(e) => patch({ strategy: e.target.value as WorkStrategy })} className={inp}>{(Object.keys(STRATEGY_LABEL) as WorkStrategy[]).map((k) => <option key={k} value={k}>{STRATEGY_LABEL[k]}</option>)}</select></label>
        {['resequence', 'change_resources', 'time_only_disruption'].includes(state.strategy) ? <p className="mt-2 text-foreground">This strategy needs planner-defined logic changes that the embedded engine does not model yet. No result is produced until it is entered as a fragnet or duration change.</p> : null}
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <label>Event / instruction date<input type="date" value={f.eventDate} onChange={(e) => patch({ fragnet: { ...f, eventDate: e.target.value } })} className={inp} /></label>
          <label>Assessment mode<select value={f.assessmentMode} onChange={(e) => patch({ fragnet: { ...f, assessmentMode: e.target.value as 'prospective' | 'retrospective' } })} className={inp}><option value="prospective">Prospective (from the data date)</option><option value="retrospective">Retrospective (historical update)</option></select></label>
          {f.assessmentMode === 'retrospective' ? <label>Historical update ID<input value={f.retrospective?.updateId ?? ''} onChange={(e) => patch({ fragnet: { ...f, retrospective: { method: f.retrospective?.method ?? '', basis: f.retrospective?.basis ?? '', updateId: e.target.value } } })} className={inp} /></label> : null}
          {f.assessmentMode === 'retrospective' ? <><label>Method<input value={f.retrospective?.method ?? ''} onChange={(e) => patch({ fragnet: { ...f, retrospective: { updateId: f.retrospective?.updateId ?? '', basis: f.retrospective?.basis ?? '', method: e.target.value } } })} className={inp} /></label><label className="md:col-span-2">Basis<input value={f.retrospective?.basis ?? ''} onChange={(e) => patch({ fragnet: { ...f, retrospective: { updateId: f.retrospective?.updateId ?? '', method: f.retrospective?.method ?? '', basis: e.target.value } } })} className={inp} /></label></> : null}
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-border"><tr><th className="py-2 pr-2">ID</th><th className="pr-2">Description</th><th className="pr-2">WBS</th><th className="pr-2">Type</th><th className="pr-2">Calendar</th><th className="pr-2">Duration basis</th><th className="pr-2">Days</th><th className="pr-2">Resources</th><th>Predecessors → successors</th></tr></thead>
            <tbody className="divide-y divide-border">
              {f.activities.map((x, i) => {
                const set = (v: Partial<typeof x>) => patch({ fragnet: { ...f, activities: f.activities.map((y, j) => (j === i ? { ...y, ...v } : y)) } });
                return (
                  <tr key={x.id}>
                    <td className="py-2 pr-2 font-data">{x.id}</td>
                    <td className="pr-2"><input aria-label={`Description ${x.id}`} value={x.description} onChange={(e) => set({ description: e.target.value })} className="w-full rounded border border-input bg-card px-2 py-1" /></td>
                    <td className="pr-2 text-muted-foreground">{x.wbs}</td><td className="pr-2">{x.type}</td>
                    <td className="pr-2"><select aria-label={`Calendar ${x.id}`} value={x.calendarId} onChange={(e) => set({ calendarId: e.target.value })} className="rounded border border-input bg-card px-1 py-1">{baseNetwork.calendars.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}</select></td>
                    <td className="pr-2"><input aria-label={`Basis ${x.id}`} value={x.durationBasis} onChange={(e) => set({ durationBasis: e.target.value })} className="w-full rounded border border-input bg-card px-2 py-1" /></td>
                    <td className="pr-2"><input aria-label={`Days ${x.id}`} type="number" min={0} value={x.durationDays} onChange={(e) => set({ durationDays: Number(e.target.value) })} className="w-16 rounded border border-input bg-card px-2 py-1 font-data" /></td>
                    <td className="pr-2 text-muted-foreground">{x.resources}</td>
                    <td className="font-data text-xs">{f.links.filter((l) => l.to === x.id).map((l) => `${l.from} ${l.type}${l.lag ? (l.lag > 0 ? '+' : '') + l.lag : ''}`).join(', ') || 'none'} → {f.links.filter((l) => l.from === x.id).map((l) => l.to).join(', ') || 'none'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <FragnetDiagram a={a} />
        <ul className="mt-3 space-y-1" aria-label="Fragnet validation">
          {fragnetIssues.length === 0 ? <li className="text-success">Fragnet passes all checks.</li> : fragnetIssues.map((i, k) => <li key={k} className={`flex items-start gap-2 ${i.severity === 'error' ? 'text-destructive' : 'text-foreground'}`}><AlertTriangle size={16} className={`mt-1 shrink-0 ${i.severity === 'error' ? 'text-destructive' : 'text-warning'}`} />{i.message}</li>)}
        </ul>
      </section>

      <section className="rounded-lg border border-border bg-card p-5" aria-label="Export and import handoff">
        <h3 className="font-semibold text-foreground">External scheduling handoff</h3>
        <p className="mt-1 text-muted-foreground">Export the approved instructions, schedule a controlled copy externally, then import the returned CSV. The source programme is never overwritten.</p>
        <div className="mt-3 flex flex-wrap gap-3">
          <button type="button" onClick={makeHandoff} className="inline-flex items-center gap-2 rounded-md border border-input bg-card px-4 py-2.5 font-semibold hover:bg-muted"><Download size={15} />Export handoff package</button>
          <button type="button" onClick={() => { const r = calculateCpm(baseNetwork); const rows = r.ok ? Object.values(r.activities).map((x) => [x.id, x.earlyStart, x.earlyFinish, x.lateStart, x.lateFinish, x.totalFloat].join(',')) : []; setCsv([pkg?.handoffId ?? '', 'id,earlyStart,earlyFinish,lateStart,lateFinish,totalFloat', ...rows].join('\n')); }} className="rounded-md border border-input bg-card px-4 py-2.5 font-medium hover:bg-muted">Fill example return (unchanged copy)</button>
        </div>
        <label className="mt-3 block">Returned CSV (first row = handoff ID)<textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={4} className={`${inp} font-data text-sm`} /></label>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">Resource levelling applied externally?<select value={levelled} onChange={(e) => setLevelled(e.target.value as 'unknown' | 'yes' | 'no')} className="rounded-md border border-input bg-card px-2 py-1.5"><option value="unknown">Not stated</option><option value="no">No</option><option value="yes">Yes</option></select></label>
          <button type="button" onClick={doReconcile} disabled={!pkg || !csv.trim()} className="rounded-md bg-primary px-4 py-2.5 font-semibold text-primary-foreground hover:opacity-90 disabled:bg-muted disabled:text-muted-foreground">Reconcile returned file</button>
        </div>
        {!pkg ? <p className="mt-2 text-muted-foreground">Export the package first so the returned file can be reconciled to it.</p> : null}
        {reconcile ? <div className="mt-3" role="status"><p className="font-semibold text-foreground">{reconcile.ok ? `Reconciled: ${reconcile.rows} activities match case, version and changes.` : 'Reconciliation found problems. Nothing was imported.'}</p><ul className="list-disc pl-5 text-foreground">{reconcile.errors.map((e) => <li key={e}>{e}</li>)}</ul></div> : null}
        {pkg ? <p className="mt-2 text-muted-foreground">Not carried in this export: {pkg.omittedFromExport.join(' ')}</p> : null}
      </section>
    </div>
  );
}

function FragnetDiagram({ a }: { a: AssessmentStore }) {
  const f = a.state.fragnet;
  const ids = f.activities.map((x) => x.id);
  const ext = Array.from(new Set(f.links.flatMap((l) => [l.from, l.to]).filter((id) => !ids.includes(id))));
  const nodes = [...ext.filter((e) => f.links.some((l) => l.to === ids[0] && l.from === e)), ...ids, ...ext.filter((e) => !f.links.some((l) => l.to === ids[0] && l.from === e))];
  const w = 150;
  const pos = new Map(nodes.map((n, i) => [n, { x: 16 + i * (w + 30), y: ids.includes(n) ? 70 : 16 }]));
  return (
    <div className="mt-4 overflow-x-auto rounded-md border border-border bg-background" role="img" aria-label="Fragnet dependency diagram">
      <svg width={Math.max(600, nodes.length * (w + 30) + 20)} height={140}>
        <defs><marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="currentColor" className="text-accent" /></marker></defs>
        {f.links.map((l, i) => { const s = pos.get(l.from); const t = pos.get(l.to); if (!s || !t) return null; return <g key={i}><line x1={s.x + w} y1={s.y + 18} x2={t.x} y2={t.y + 18} stroke="currentColor" className="text-accent" markerEnd="url(#arr)" /><text x={(s.x + w + t.x) / 2} y={(s.y + t.y) / 2 + 10} fontSize="12" className="fill-current text-muted-foreground" textAnchor="middle">{l.type}{l.lag ? (l.lag > 0 ? '+' : '') + l.lag : ''}</text></g>; })}
        {nodes.map((n) => { const p = pos.get(n) as { x: number; y: number }; const isNew = ids.includes(n); return <g key={n}><rect x={p.x} y={p.y} width={w} height={36} rx={6} className={isNew ? 'fill-accent/10 stroke-accent' : 'fill-muted stroke-border'} /><text x={p.x + 8} y={p.y + 23} fontSize="13" className="fill-current text-foreground">{n}{isNew ? ' (new)' : ' (existing)'}</text></g>; })}
      </svg>
    </div>
  );
}

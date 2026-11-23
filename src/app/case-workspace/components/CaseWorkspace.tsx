'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Download, Play, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import CaseStepper from '@/app/case-workspace/components/CaseStepper';
import AgentFeed from '@/app/case-workspace/components/AgentFeed';
import StageFooter from '@/app/case-workspace/components/StageFooter';
import DrawingStage from '@/app/case-workspace/components/DrawingStage';
import BoqStage from '@/app/case-workspace/components/BoqStage';
import ActivityStage from '@/app/case-workspace/components/ActivityStage';
import AssessmentStage from '@/app/case-workspace/components/AssessmentStage';
import EvidenceDrawer from '@/components/EvidenceDrawer';
import { useAssessment } from '@/lib/assessment/useAssessment';
import { demoPack, classifyFiles } from '@/lib/intake/triage';
import { STAGE_ORDER, useCaseStore, wait, makeEvent, type StageKey } from '@/lib/mapping/useCaseStore';
import { stageLabel } from '@/components/ui/StatusDot';

const NEXT: Record<StageKey, StageKey | null> = { prerequisites: 'drawing', drawing: 'boq', boq: 'activity', activity: null };
const EVIDENCE = [
  { name: 'PVR-0418.pdf', note: 'Synthetic sample file (not a real upload)' },
  { name: 'R4-CIV-101 Rev B.dxf', note: 'Synthetic sample drawing' },
  { name: 'R4-CIV-101 Rev C.dxf', note: 'Synthetic sample drawing' },
  { name: 'FIR_Baseline_Oct26.xer', note: 'Synthetic sample schedule' },
];

export default function CaseWorkspace() {
  const store = useCaseStore();
  const { state, setState, touch, runDrawing, runBoq, runActivity, confirmStage, running, hydrated } = store;
  const assessment = useAssessment(state.caseId, state.boq, state.mapping?.version ?? 0, true);
  const [view, setView] = useState<'mapping' | 'assessment'>('mapping');
  const [active, setActive] = useState<StageKey>('drawing');
  const [feedOpen, setFeedOpen] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const [explanations, setExplanations] = useState<Record<string, string>>({});
  const [explainNote, setExplainNote] = useState('');
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!hydrated) return;
    const first = STAGE_ORDER.find((k) => k !== 'prerequisites' && state.stages[k] !== 'confirmed');
    if (first) setActive(first);
    // only on first load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  const status = state.stages[active];
  const busy = running || playing;

  const explain = useCallback(async () => {
    try {
      const items = state.boq.map((m) => ({ id: m.id, facts: `${m.class} of ${m.description} (${m.boqRef}), ${m.quantity} ${m.unit}. Calculation: ${m.quantityCalc}` }));
      const res = await fetch('/api/agents/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: 'BoQ mapping', items, pvrText: 'Extend access road R4 from 5.0 km to 7.0 km.' }) });
      const data = (await res.json()) as { source?: string; rationales?: { id: string; text: string }[]; note?: string };
      if (data.source === 'model' && data.rationales) {
        const map: Record<string, string> = {};
        data.rationales.forEach((r) => { map[r.id] = r.text; });
        setExplanations(map);
        setExplainNote('Reasons written by the BoQ agent from the measured facts. Quantities were not changed by the model.');
      } else {
        setExplainNote(data.note ?? 'Showing rule-based reasons.');
      }
    } catch {
      setExplainNote('The model could not be reached. Showing rule-based reasons.');
    }
  }, [state.boq]);

  const runStage = async (k: StageKey) => {
    if (k === 'drawing') await runDrawing();
    if (k === 'boq') { await runBoq(); void explain(); }
    if (k === 'activity') await runActivity();
  };

  const canConfirm = (() => {
    if (status !== 'needs_review') return false;
    if (active === 'drawing') return state.changes.some((c) => c.included) && !state.changes.some((c) => c.included && c.needsQuestion);
    if (active === 'boq') return state.boq.some((m) => m.included);
    if (active === 'activity') return state.activities.length > 0;
    return false;
  })();

  const primary = (() => {
    if (status === 'not_started' || status === 'needs_rerun') return { label: 'Run', disabled: busy, fn: () => void runStage(active) };
    if (status === 'running') return { label: 'Running…', disabled: true, fn: () => undefined };
    if (status === 'confirmed') {
      const n = NEXT[active];
      return n ? { label: 'Continue', disabled: false, fn: () => setActive(n) } : { label: 'Continue to cost and programme', disabled: !state.mapping, fn: () => setView('assessment') };
    }
    return {
      label: active === 'drawing' ? 'Confirm changes and continue' : active === 'boq' ? 'Confirm items and continue' : 'Confirm Mapping v1',
      disabled: !canConfirm,
      fn: () => { confirmStage(active); toast.success(active === 'activity' ? 'Mapping v1 is locked and ready to export.' : 'Stage confirmed and locked.'); const n = NEXT[active]; if (n) setActive(n); },
    };
  })();

  const footerNote = status === 'needs_rerun' ? 'An earlier stage changed. Run this stage again to refresh it.' : status === 'confirmed' && active === 'activity' ? 'Mapping v1 is the only input the next stages read. Next: cost impact.' : active === 'drawing' && status === 'needs_review' && !canConfirm ? 'Answer the lighting question to continue.' : 'Confirming locks this stage. Editing it later marks the next stages for re-run.';

  const exportJson = () => {
    if (!state.mapping) return;
    const blob = new Blob([JSON.stringify(state.mapping, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.ref}-mapping-v${state.mapping.version}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const playScenario = async () => {
    if (playing) return;
    setPlaying(true);
    store.reset();
    await wait(200);
    store.setSpeed(2.5);
    try {
      setActive('drawing');
      await runDrawing();
      setState((s) => ({ ...s, changes: s.changes.map((c) => (c.needsQuestion ? { ...c, needsQuestion: undefined, confidence: 92 } : c)) }));
      await wait(900);
      confirmStage('drawing', 'Demo scenario');
      setActive('boq');
      await runBoq();
      await wait(900);
      confirmStage('boq', 'Demo scenario');
      setActive('activity');
      await runActivity();
      setState((s) => ({ ...s, activities: s.activities.map((m) => (m.activityId ? { ...m, accepted: true } : m)), newActivities: s.newActivities.map((n) => ({ ...n, accepted: true })) }));
      await wait(900);
      confirmStage('activity', 'Demo scenario');
      store.push(makeEvent('Orchestrator', 'handover', 'Mapping v1 is locked. Cost impact is next.'));
      toast.success('Scenario complete. Mapping v1 is locked.');
    } finally {
      store.setSpeed(1);
      setPlaying(false);
    }
  };

  const demoFiles = classifyFiles(demoPack()).files;

  if (!hydrated) return <div className="skeleton h-96 rounded-lg" aria-label="Loading case" />;

  return (
    <div className="-mx-4 -my-6 flex min-h-[calc(100vh-4rem)] flex-col sm:-mx-6 lg:-mx-8 xl:-mx-10 2xl:-mx-16">
      <header className="border-b border-border bg-card px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-3">
              <span className="font-data text-lg font-semibold text-foreground">{state.ref}</span>
              <span className="rounded-full bg-warning/20 px-2.5 py-0.5 text-sm font-medium text-foreground">{status === 'confirmed' && state.mapping ? 'Mapping v1 locked' : 'Needs your review'}</span>
              {state.mode === 'demo' ? <span className="rounded-full bg-muted px-2.5 py-0.5 text-sm text-muted-foreground">Sample data</span> : null}
            </div>
            <h2 className="mt-1 text-xl font-semibold text-foreground">{state.title}</h2>
            <p className="text-muted-foreground">{state.subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void playScenario()} disabled={busy} className="inline-flex items-center gap-2 rounded-md border border-input bg-card px-3.5 py-2 font-semibold hover:bg-muted disabled:opacity-60"><Play size={15} />{playing ? 'Playing…' : 'Play synthetic scenario'}</button>
            <button type="button" onClick={() => { store.reset(); setExplanations({}); setActive('drawing'); }} disabled={busy} className="inline-flex items-center gap-2 rounded-md border border-input bg-card px-3.5 py-2 font-medium hover:bg-muted disabled:opacity-60"><RotateCcw size={15} />Start over</button>
            <button type="button" onClick={() => setDrawer(true)} className="rounded-md border border-input bg-card px-3.5 py-2 font-medium hover:bg-muted">Evidence details</button>
          </div>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-1 lg:grid-cols-[250px_minmax(0,1fr)] xl:grid-cols-[250px_minmax(0,1fr)_320px]">
        <div className="border-b border-border bg-card p-4 lg:border-b-0 lg:border-r">
          <CaseStepper stages={state.stages} active={active} onSelect={(k) => { setView('mapping'); setActive(k); }} assessmentActive={view === 'assessment'} onSelectAssessment={() => setView('assessment')} mappingLocked={!!state.mapping} />
        </div>

        <main className="min-w-0 bg-background px-4 py-6 sm:px-6">
          {view === 'assessment' ? <AssessmentStage a={assessment} mappingLocked={!!state.mapping} /> : null}
          {view === 'mapping' && active === 'prerequisites' ? (
            <div className="space-y-4">
              <h1 className="text-headline font-semibold text-foreground">Prerequisites are confirmed.</h1>
              <p className="max-w-2xl text-muted-foreground">Change request, drawings, BoQ and baseline schedule were checked before the agents started.</p>
              <ul className="divide-y divide-border rounded-lg border border-border bg-card">{EVIDENCE.map((e) => <li key={e.name} className="flex justify-between gap-3 px-4 py-3"><span className="font-medium text-foreground">{e.name}</span><span className="text-muted-foreground">{e.note}</span></li>)}</ul>
              <Link href="/new-pvr" className="inline-block font-medium text-accent hover:underline">Start a different PVR</Link>
            </div>
          ) : null}
          {view === 'mapping' && active === 'drawing' ? <DrawingStage status={state.stages.drawing} changes={state.changes} pvrStated={state.pvrStated} onChange={(c) => setState((s) => ({ ...s, changes: c }))} onRun={() => void runStage('drawing')} running={running && state.stages.drawing === 'running'} onEdited={(k) => touch(k)} /> : null}
          {view === 'mapping' && active === 'boq' ? <BoqStage status={state.stages.boq} boq={state.boq} bills={state.billsSearched} onBills={(b) => setState((s) => ({ ...s, billsSearched: b }))} onChange={(m) => setState((s) => ({ ...s, boq: m }))} onRun={() => void runStage('boq')} running={running && state.stages.boq === 'running'} onEdited={(k) => touch(k)} explanations={explanations} explainNote={explainNote} /> : null}
          {view === 'mapping' && active === 'activity' ? <ActivityStage status={state.stages.activity} boq={state.boq} mappings={state.activities} suggestions={state.newActivities} filters={state.filters} onFilters={(f) => setState((s) => ({ ...s, filters: f }))} onChange={(m, n) => setState((s) => ({ ...s, activities: m, newActivities: n }))} onRun={() => void runStage('activity')} running={running && state.stages.activity === 'running'} onEdited={(k) => touch(k)} /> : null}

          {view === 'mapping' && state.stages[active] === 'needs_rerun' && active !== 'prerequisites' ? (
            <div role="alert" className="mt-5 rounded-lg border-2 border-warning bg-warning/5 p-4">
              <p className="font-semibold text-foreground">{stageLabel('needs_rerun')}</p>
              <p className="text-muted-foreground">An earlier stage was edited after it was confirmed. Results below are from the previous run. Run this stage again before confirming.</p>
            </div>
          ) : null}

          {view === 'mapping' && state.mapping ? (
            <section className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-success/30 bg-success/10 p-4" aria-label="Mapping v1">
              <div>
                <p className="font-semibold text-foreground">Mapping v{state.mapping.version} is locked</p>
                <p className="text-muted-foreground">{state.mapping.contents.boqMappings.filter((m) => m.included).length} BoQ items and {state.mapping.contents.activityMappings.filter((a) => a.accepted).length} activity links. Cost, schedule and PVR stages read only this file. Next: cost impact.</p>
              </div>
              <button type="button" onClick={exportJson} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 font-semibold text-primary-foreground hover:opacity-90"><Download size={15} />Export JSON</button>
            </section>
          ) : null}
        </main>

        <div className="border-t border-border bg-card p-4 xl:border-l xl:border-t-0">
          <AgentFeed events={state.events} live={busy} open={feedOpen} onToggle={() => setFeedOpen((v) => !v)}>
            <div className="mt-4 border-t border-border pt-4">
              <h3 className="font-semibold text-foreground">Evidence viewer</h3>
              <ul className="mt-2 space-y-2">{EVIDENCE.slice(0, 3).map((e) => <li key={e.name} className="rounded-md border border-border px-3 py-2"><p className="font-medium text-foreground">{e.name}</p><p className="text-sm text-muted-foreground">{e.note}</p></li>)}</ul>
            </div>
          </AgentFeed>
        </div>
      </div>

      <StageFooter
        note={view === 'assessment' ? (assessment.stale ? 'Inputs changed after the run was frozen. Freeze again to record a new run.' : 'Cost and programme calculate from the confirmed mapping. Freeze a run to record inputs and engine version.') : footerNote}
        primaryLabel={view === 'assessment' ? (assessment.state.frozen && !assessment.stale ? 'Run is frozen' : 'Freeze this run') : primary.label}
        primaryDisabled={view === 'assessment' ? !!(assessment.state.frozen && !assessment.stale) : primary.disabled || busy}
        onPrimary={view === 'assessment' ? () => { assessment.freeze(); toast.success('Run frozen with its inputs, assumptions and engine version.'); } : primary.fn}
        onBack={() => { if (view === 'assessment') { setView('mapping'); setActive('activity'); return; } const i = STAGE_ORDER.indexOf(active); if (i > 0) setActive(STAGE_ORDER[i - 1]); }}
        onSave={() => toast.success('Draft saved on this device.')}
        backDisabled={view === 'mapping' && active === 'prerequisites'}
      />
      <EvidenceDrawer open={drawer} onClose={() => setDrawer(false)} files={demoFiles} />
    </div>
  );
}

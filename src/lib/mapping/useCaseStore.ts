'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildChangeSet, buildFahidDrawings, checkAgainstPvr, compareRevisions, FAHID_ZONE } from '@/lib/mapping/drawingEngine';
import { BOQ_BILLS, mapChangesToBoq } from '@/lib/mapping/boqEngine';
import { buildFahidSchedule, DEMO_FIXTURE_FILTERS, mapBoqToActivities, type ScheduleFilters } from '@/lib/mapping/activityEngine';
import type { ActivityMapping, AgentEvent, BoqMapping, DrawingChange, MappingVersion, NewActivitySuggestion, StageStatus } from '@/lib/mapping/types';
import { validateMappingVersion } from '@/lib/mapping/schemas';

export type StageKey = 'prerequisites' | 'drawing' | 'boq' | 'activity';
export const STAGE_ORDER: StageKey[] = ['prerequisites', 'drawing', 'boq', 'activity'];

export interface CaseState {
  caseId: string;
  ref: string;
  title: string;
  subtitle: string;
  mode: 'demo' | 'real';
  stages: Record<StageKey, StageStatus>;
  changes: DrawingChange[];
  boq: BoqMapping[];
  billsSearched: number[];
  activities: ActivityMapping[];
  newActivities: NewActivitySuggestion[];
  filters: ScheduleFilters;
  versions: Record<StageKey, number>;
  mapping: MappingVersion | null;
  events: AgentEvent[];
  pvrStated: number;
  unitsConfirmed: boolean;
}

const KEY = 'pvr-agent-case-v2';

export const INITIAL_STAGES: Record<StageKey, StageStatus> = { prerequisites: 'confirmed', drawing: 'not_started', boq: 'not_started', activity: 'not_started' };

export function createCase(): CaseState {
  return {
    caseId: 'case-pvr-0418',
    ref: 'PVR-0418',
    title: 'Extend access road R4 from 5.0 km to 7.0 km',
    subtitle: 'Fahid Island Roads Package, Zone C East Spine, Civil Roads',
    mode: 'demo',
    stages: { ...INITIAL_STAGES },
    changes: [],
    boq: [],
    billsSearched: BOQ_BILLS.filter((b) => b.relevantByDefault).map((b) => b.number),
    activities: [],
    newActivities: [],
    filters: DEMO_FIXTURE_FILTERS,
    versions: { prerequisites: 1, drawing: 0, boq: 0, activity: 0 },
    mapping: null,
    events: [],
    pvrStated: 2000,
    unitsConfirmed: true,
  };
}

let eventCounter = 0;
export function makeEvent(agent: AgentEvent['agent'], kind: AgentEvent['kind'], text: string, durationMs?: number): AgentEvent {
  eventCounter += 1;
  const d = new Date();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  return { id: `ev-${Date.now()}-${eventCounter}`, agent, kind, text, time, durationMs };
}

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Mark every stage after `from` that has been run as needing a re-run. */
export function cascadeRerun(stages: Record<StageKey, StageStatus>, from: StageKey): Record<StageKey, StageStatus> {
  const next = { ...stages };
  const start = STAGE_ORDER.indexOf(from);
  STAGE_ORDER.forEach((k, i) => {
    if (i > start && (next[k] === 'confirmed' || next[k] === 'needs_review')) next[k] = 'needs_rerun';
  });
  return next;
}

export function useCaseStore() {
  const [state, setState] = useState<CaseState>(() => createCase());
  const [hydrated, setHydrated] = useState(false);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
  const cancelRef = useRef(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) setState(JSON.parse(raw) as CaseState);
    } catch {
      /* ignore corrupt draft */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* storage may be full */
    }
  }, [state, hydrated]);

  const push = useCallback((ev: AgentEvent) => setState((s) => ({ ...s, events: [...s.events, ev] })), []);
  const patch = useCallback((p: Partial<CaseState>) => setState((s) => ({ ...s, ...p })), []);
  const setStage = useCallback((k: StageKey, v: StageStatus) => setState((s) => ({ ...s, stages: { ...s.stages, [k]: v } })), []);

  const reset = useCallback(() => {
    cancelRef.current = true;
    setState(createCase());
    setRunning(false);
  }, []);

  /** Edit anything inside a confirmed stage: that stage reopens and later stages need a re-run. */
  const touch = useCallback((stage: StageKey, extra?: Partial<CaseState>) => {
    setState((s) => {
      const stages = cascadeRerun(s.stages, stage);
      if (s.stages[stage] === 'confirmed') stages[stage] = 'needs_review';
      return { ...s, ...extra, stages, mapping: s.mapping && s.stages[stage] === 'confirmed' ? null : s.mapping };
    });
  }, []);

  const runDrawing = useCallback(async () => {
    cancelRef.current = false;
    setRunning(true);
    setStage('drawing', 'running');
    const t = (ms: number) => wait(ms / speed);
    push(makeEvent('Orchestrator', 'plan', 'Plan: compare Rev B to Rev C, quantify, check against the PVR.'));
    await t(600);
    const { revB, revC } = buildFahidDrawings();
    push(makeEvent('Drawing agent', 'step', `[Demo] Read the built-in sample revisions, ${revC.layers.length} layers, units in metres. No uploaded file was read.`, 1100));
    await t(700);
    const diff = compareRevisions(revB, revC);
    push(makeEvent('Drawing agent', 'step', `Matched ${diff.matchedByHandle.toLocaleString('en-US')} entities by handle and ${diff.matchedByGeometry} by geometry.`, 900));
    await t(700);
    const changes = buildChangeSet(diff, FAHID_ZONE);
    const added = changes.filter((c) => c.type === 'added').length;
    push(makeEvent('Drawing agent', 'finding', `Found ${added} additions, ${changes.filter((c) => c.type === 'removed').length} removal and ${changes.filter((c) => c.type === 'modified').length} modification.`, 1400));
    await t(700);
    const check = checkAgainstPvr(changes, 2000);
    push(makeEvent('Drawing agent', 'finding', check.match ? 'Road extends 2,000 m, matching the PVR.' : `Road measures ${check.measured} m but the PVR says 2,000 m.`, 500));
    await t(600);
    const light = changes.find((c) => c.needsQuestion);
    if (light) push(makeEvent('Drawing agent', 'question', 'Lighting was counted from blocks. Please confirm it belongs in this PVR.'));
    push(makeEvent('Orchestrator', 'handover', 'Waiting for your review.'));
    setState((s) => ({ ...s, changes, stages: { ...s.stages, drawing: 'needs_review' } }));
    setRunning(false);
  }, [push, setStage, speed]);

  const runBoq = useCallback(async () => {
    cancelRef.current = false;
    setRunning(true);
    setStage('boq', 'running');
    const t = (ms: number) => wait(ms / speed);
    push(makeEvent('Orchestrator', 'plan', 'Plan: map confirmed drawing changes to BoQ items.'));
    await t(600);
    const cur = await new Promise<CaseState>((res) => setState((s) => { res(s); return s; }));
    const bills = cur.billsSearched;
    push(makeEvent('BoQ agent', 'step', `Chose ${bills.length} of ${BOQ_BILLS.length} bills from the change scope.`, 700));
    await t(800);
    const itemsSearched = BOQ_BILLS.filter((b) => bills.includes(b.number)).reduce((s, b) => s + b.itemCount, 0);
    push(makeEvent('BoQ agent', 'step', `[Demo] Searched ${itemsSearched} items in the built-in sample BoQ. No uploaded file was read.`, 1600));
    await t(900);
    const mapped = mapChangesToBoq({ changes: cur.changes, bills });
    push(makeEvent('BoQ agent', 'challenge', 'Challenged the Drawing agent: kerb length of 2,000 m conflicts with a BoQ unit of m.'));
    await t(800);
    push(makeEvent('Drawing agent', 'resolution', 'Resolved: kerb is on both sides, 4,000 m.'));
    await t(700);
    if (mapped.some((m) => m.class === 'new')) push(makeEvent('BoQ agent', 'question', 'No BoQ item for the culvert extension. Proposed a new item.'));
    push(makeEvent('Orchestrator', 'handover', 'Waiting for your review.'));
    setState((s) => ({ ...s, boq: mapped, stages: { ...s.stages, boq: 'needs_review' } }));
    setRunning(false);
  }, [push, setStage, speed]);

  const runActivity = useCallback(async () => {
    cancelRef.current = false;
    setRunning(true);
    setStage('activity', 'running');
    const t = (ms: number) => wait(ms / speed);
    push(makeEvent('Orchestrator', 'plan', 'Plan: map confirmed BoQ items to baseline activities.'));
    await t(600);
    const model = buildFahidSchedule();
    push(makeEvent('Schedule agent', 'step', `[Demo] Loaded the built-in sample baseline: ${model.activityCount} synthetic activities. No uploaded file was read.`, 1800));
    await t(900);
    const cur = await new Promise<CaseState>((res) => setState((s) => { res(s); return s; }));
    push(makeEvent('Schedule agent', 'step', `Filtered the WBS to ${cur.filters.zone}, CH 5+000 to 7+000, ${cur.filters.discipline}.`, 600));
    await t(800);
    const { mappings, suggestions } = mapBoqToActivities(cur.boq, model, cur.filters);
    const accepted = mappings.filter((m) => m.activityId).length;
    push(makeEvent('Schedule agent', 'finding', `Mapped ${new Set(mappings.filter((m) => m.activityId).map((m) => m.boqMappingId)).size} items to ${accepted} activities with reasons.`, 1200));
    await t(800);
    if (suggestions.length) push(makeEvent('Schedule agent', 'question', `${suggestions.length} item${suggestions.length === 1 ? ' has' : 's have'} no suitable activity. Proposed new activities.`));
    push(makeEvent('Orchestrator', 'handover', 'Waiting for your review.'));
    setState((s) => ({ ...s, activities: mappings, newActivities: suggestions, stages: { ...s.stages, activity: 'needs_review' } }));
    setRunning(false);
  }, [push, setStage, speed]);

  const confirmStage = useCallback((stage: StageKey, by = 'Sara Al Rumaithi') => {
    setState((s) => {
      const versions = { ...s.versions, [stage]: s.versions[stage] + 1 };
      const stages = { ...s.stages, [stage]: 'confirmed' as StageStatus };
      let mapping = s.mapping;
      if (stage === 'activity') {
        mapping = {
          id: `mapping-${s.caseId}-v${versions.activity}`,
          caseId: s.caseId,
          version: versions.activity,
          confirmedBy: by,
          confirmedAt: new Date().toISOString(),
          contents: { drawingChanges: s.changes, boqMappings: s.boq, activityMappings: s.activities, newActivities: s.newActivities },
          upstreamVersions: { drawing: versions.drawing, boq: versions.boq, activity: versions.activity },
        };
        const problems = validateMappingVersion(mapping);
        if (problems.length) mapping = null;
      }
      return { ...s, versions, stages, mapping };
    });
  }, []);

  const completedCount = useMemo(() => STAGE_ORDER.filter((k) => state.stages[k] === 'confirmed').length, [state.stages]);

  return { state, setState, patch, push, reset, touch, runDrawing, runBoq, runActivity, confirmStage, running, speed, setSpeed, hydrated, completedCount, cancelRef };
}

export type CaseStore = ReturnType<typeof useCaseStore>;

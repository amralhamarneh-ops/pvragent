'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BoqMapping } from '@/lib/mapping/types';
import { calculateCost, componentsFromMapping } from '@/lib/assessment/costEngine';
import { DEFAULT_RATE_POLICY, syntheticRates } from '@/lib/assessment/rates';
import { DEFAULT_SETTINGS, freezeRun, isRunStale, syntheticFragnet, syntheticNetwork } from '@/lib/assessment/fixtures';
import { calculateCpm, type CpmNetwork } from '@/lib/assessment/cpmEngine';
import { compareScenarios, EmbeddedEngine, ExternalP6Engine, HandoffEngine, increaseRemaining, insertFragnet, validateFragnet, validateUnchangedCopy, type Fragnet, type SchedulingEngine } from '@/lib/assessment/schedulingEngine';
import { computeDuration, sampleResourceFields, type ProductivityInput, type ResourceFieldMapping } from '@/lib/assessment/productivity';
import { STRATEGY_LABEL, type WorkStrategy } from '@/lib/assessment/workModel';
import type { Adjustment, FrozenRun, RateRecord, Scenario } from '@/lib/assessment/types';

const KEY = 'pvr-assessment-v1';

export interface PersistedAssessment {
  caseId: string;
  rateByRef: Record<string, string | undefined>;
  /**
   * Demo-only line decisions keyed by the stable mapping/component id (never by BOQ ref alone). Kept strictly inside
   * the demo assessment state; real cases use their own case-scoped store.
   */
  lineDecisions?: Record<string, { kind: 'manual_rate' | 'excluded_cost' | 'excluded_schedule' | 'excluded_scenario' | 'deferred' | 'unresolved'; reason: string; at: string; rate?: string; unit?: string; currency?: string }>;
  rates: RateRecord[];
  adjustments: Adjustment[];
  taxRatePct: string;
  roundingPlaces: number;
  strategy: WorkStrategy;
  fragnet: Fragnet;
  productivity: ProductivityInput;
  fieldMaps: ResourceFieldMapping[];
  engineId: string;
  scenarios: Scenario[];
  plannerAccepted: { by: string; at: string; reason: string } | null;
  tolerance: number;
  frozen: FrozenRun | null;
  assessmentVersion: number;
  claimedEot: string;
  assessedEot: string;
  approvedEot: string;
  scheduleConfirmed: boolean;
  dataDate: string;
}

export function defaults(caseId: string): PersistedAssessment {
  return {
    caseId,
    rateByRef: { 'BM-01': 'RT-01', 'BM-02': 'RT-02', 'BM-04': 'RT-04', 'BM-05': undefined, 'BM-06': 'RT-04' },
    rates: syntheticRates(),
    adjustments: [{ id: 'ADJ-OH', label: 'Site overheads', type: 'overheads', mode: 'percent_of_base', value: '8', evidence: '', justification: '', enabled: false, approval: 'proposed' }],
    taxRatePct: '',
    roundingPlaces: 2,
    strategy: 'insert_fragnet',
    fragnet: syntheticFragnet(),
    productivity: { basis: 'crew_output', quantity: '14000', unit: 'm2', source: 'Planner input, to be confirmed', calendarId: 'CAL6', outputPerDay: '', roundingMode: 'up' },
    fieldMaps: sampleResourceFields(),
    engineId: 'embedded',
    scenarios: [
      { id: 'SC-REF', name: 'Unchanged reference', kind: 'reference', changeIds: [] },
      { id: 'SC-CHG', name: 'Change scenario', kind: 'change', changeIds: ['PVR-0418'] },
    ],
    plannerAccepted: null,
    tolerance: 0,
    frozen: null,
    assessmentVersion: 1,
    claimedEot: '',
    assessedEot: '',
    approvedEot: '',
    scheduleConfirmed: false,
    dataDate: '2026-10-12',
  };
}

export function useAssessment(caseId: string, boq: BoqMapping[], mappingVersion: number, scheduleAvailable: boolean) {
  const [state, setState] = useState<PersistedAssessment>(() => defaults(caseId));
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`${KEY}:${caseId}`);
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedAssessment;
        if (parsed.caseId === caseId) setState({ ...defaults(caseId), ...parsed });
      }
    } catch { /* ignore corrupt draft */ }
    setHydrated(true);
  }, [caseId]);

  useEffect(() => {
    if (!hydrated) return;
    try { window.localStorage.setItem(`${KEY}:${caseId}`, JSON.stringify(state)); } catch { /* storage may be full */ }
  }, [state, hydrated, caseId]);

  const patch = useCallback((p: Partial<PersistedAssessment>) => setState((s) => ({ ...s, ...p })), []);

  const settings = useMemo(() => ({ ...DEFAULT_SETTINGS, rounding: { places: state.roundingPlaces, mode: 'half_up' as const }, taxRatePct: state.taxRatePct.trim() === '' ? null : state.taxRatePct }), [state.roundingPlaces, state.taxRatePct]);
  const components = useMemo(() => componentsFromMapping(boq, state.rateByRef), [boq, state.rateByRef]);
  const cost = useMemo(() => calculateCost({ components, rates: state.rates, adjustments: state.adjustments, policy: DEFAULT_RATE_POLICY, settings }), [components, state.rates, state.adjustments, settings]);

  const baseNetwork: CpmNetwork | null = useMemo(() => (scheduleAvailable ? { ...syntheticNetwork(), dataDate: state.dataDate } : null), [scheduleAvailable, state.dataDate]);
  const engines: Record<string, SchedulingEngine> = useMemo(() => ({ embedded: new EmbeddedEngine(), handoff: new HandoffEngine(), 'p6-service': new ExternalP6Engine(false, false) }), []);
  const unimpactedResult = useMemo(() => (baseNetwork ? calculateCpm(baseNetwork) : null), [baseNetwork]);
  const fragnetIssues = useMemo(() => (baseNetwork ? validateFragnet(state.fragnet, baseNetwork) : []), [baseNetwork, state.fragnet]);
  const fragnetOk = !fragnetIssues.some((i) => i.severity === 'error');
  const impactedNetwork: CpmNetwork | null = useMemo(() => {
    if (!baseNetwork || !fragnetOk) return null;
    if (state.strategy === 'insert_fragnet' || state.strategy === 'add_activity') return insertFragnet(baseNetwork, state.fragnet);
    if (state.strategy === 'increase_remaining') {
      const days = computeDuration(state.productivity).roundedWorkingDays;
      if (days === null) return null;
      const r = increaseRemaining(baseNetwork, 'C4060', days);
      return r.error ? null : r.network;
    }
    return null;
  }, [baseNetwork, fragnetOk, state.strategy, state.fragnet, state.productivity]);
  const impactedResult = useMemo(() => (impactedNetwork ? calculateCpm(impactedNetwork) : null), [impactedNetwork]);
  const comparison = useMemo(() => {
    if (!baseNetwork || !impactedNetwork || !unimpactedResult?.ok || !impactedResult?.ok) return null;
    const direct = state.strategy === 'increase_remaining' ? ['C4060'] : [];
    return compareScenarios(baseNetwork, unimpactedResult, impactedNetwork, impactedResult, direct, ['C4090']);
  }, [baseNetwork, impactedNetwork, unimpactedResult, impactedResult, state.strategy]);
  const validation = useMemo(() => {
    if (!baseNetwork || !unimpactedResult?.ok) return null;
    const source = Object.values(unimpactedResult.activities).map((a) => ({ id: a.id, start: a.earlyStart, finish: a.earlyFinish, totalFloat: a.totalFloat }));
    return validateUnchangedCopy(baseNetwork, source, { dates: state.tolerance, float: state.tolerance });
  }, [baseNetwork, unimpactedResult, state.tolerance]);
  const duration = useMemo(() => computeDuration(state.productivity), [state.productivity]);

  const freezeArgs = useMemo(() => ({
    caseId, assessmentVersion: state.assessmentVersion, mappingVersion, scheduleVersion: scheduleAvailable ? 'FIR_Baseline_Oct26' : 'none', dataDate: state.dataDate, ratePolicyId: DEFAULT_RATE_POLICY.id, settings,
    assumptions: ['Synthetic sample programme and rates. Not live project values.', 'Unconstrained CPM, retained logic, no resource levelling.'], components, adjustments: state.adjustments, network: impactedNetwork ?? baseNetwork, scenarios: state.scenarios, engineId: state.engineId,
  }), [caseId, state.assessmentVersion, mappingVersion, scheduleAvailable, state.dataDate, settings, components, state.adjustments, impactedNetwork, baseNetwork, state.scenarios, state.engineId]);

  const freeze = useCallback(() => setState((s) => ({ ...s, frozen: freezeRun(freezeArgs) })), [freezeArgs]);
  const stale = state.frozen ? isRunStale(state.frozen, freezeArgs) : false;
  const newVersion = useCallback(() => setState((s) => ({ ...s, assessmentVersion: s.assessmentVersion + 1, frozen: null })), []);

  return { state, patch, hydrated, cost, components, baseNetwork, unimpactedResult, impactedNetwork, impactedResult, comparison, validation, fragnetIssues, fragnetOk, duration, engines, freeze, stale, newVersion, strategyLabel: STRATEGY_LABEL[state.strategy] };
}

export type AssessmentStore = ReturnType<typeof useAssessment>;

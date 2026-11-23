import type { CpmNetwork } from './cpmEngine';
import type { Fragnet } from './schedulingEngine';
import { hashString } from './schedulingEngine';
import type { Adjustment, CalcSettings, FrozenRun, Scenario } from './types';
import type { ScopeComponent } from './types';
import { EMBEDDED_VERSION } from './schedulingEngine';

export const DEFAULT_SETTINGS: CalcSettings = { currency: 'AED', rounding: { places: 2, mode: 'half_up' }, taxRatePct: null, taxLabel: 'VAT (kept separate from the base assessment)' };

export const SAT_SUN_OFF = { id: 'CAL5', name: '5-day week (Mon-Fri)', workDays: [1, 2, 3, 4, 5], holidays: ['2026-12-02', '2026-12-03'] };
export const SIX_DAY = { id: 'CAL6', name: '6-day week (Mon-Sat)', workDays: [1, 2, 3, 4, 5, 6], holidays: ['2026-12-02', '2026-12-03'] };

/**
 * Synthetic R4 programme used for demonstration and verification. Clearly labelled synthetic.
 * Data date Mon 2026-10-12. Mon-Fri and Mon-Sat calendars. Holidays 2 and 3 Dec 2026.
 */
export function syntheticNetwork(): CpmNetwork {
  return {
    dataDate: '2026-10-12',
    projectCalendarId: 'CAL5',
    calendars: [SAT_SUN_OFF, SIX_DAY],
    settings: { progressMode: 'retained_logic', resourceLevelling: false, criticalDefinition: 'total_float_lte_zero' },
    activities: [
      { id: 'C4010', name: 'R4 Earthworks CH 0+000 to 5+000', type: 'task', calendarId: 'CAL6', originalDuration: 98, remainingDuration: 0, actualStart: '2026-03-02', actualFinish: '2026-07-14' },
      { id: 'C4030', name: 'R4 Subbase CH 0+000 to 5+000', type: 'task', calendarId: 'CAL6', originalDuration: 85, remainingDuration: 0, actualStart: '2026-05-04', actualFinish: '2026-08-28' },
      { id: 'C4050', name: 'R4 Binder course CH 0+000 to 5+000', type: 'task', calendarId: 'CAL6', originalDuration: 45, remainingDuration: 0, actualStart: '2026-07-01', actualFinish: '2026-09-02' },
      { id: 'C4060', name: 'R4 Wearing course CH 0+000 to 5+000', type: 'task', calendarId: 'CAL6', originalDuration: 108, remainingDuration: 20, actualStart: '2026-08-03' },
      { id: 'C4070', name: 'R4 Kerbs CH 0+000 to 5+000', type: 'task', calendarId: 'CAL6', originalDuration: 100, remainingDuration: 30, actualStart: '2026-06-15' },
      { id: 'C4120', name: 'R4 Street lighting install and test', type: 'task', calendarId: 'CAL5', originalDuration: 38, remainingDuration: 38 },
      { id: 'C4130', name: 'R4 Road marking and signage', type: 'task', calendarId: 'CAL6', originalDuration: 20, remainingDuration: 20 },
      { id: 'C4140', name: 'R4 Gully and drainage connections', type: 'task', calendarId: 'CAL6', originalDuration: 130, remainingDuration: 15, actualStart: '2026-04-01' },
      { id: 'C4090', name: 'R4 Handover', type: 'milestone_finish', calendarId: 'CAL5', originalDuration: 0, remainingDuration: 0 },
    ],
    relationships: [
      { from: 'C4010', to: 'C4030', type: 'SS', lag: 20 },
      { from: 'C4030', to: 'C4050', type: 'FS', lag: 0 },
      { from: 'C4050', to: 'C4060', type: 'FS', lag: 0 },
      { from: 'C4060', to: 'C4130', type: 'FS', lag: 0 },
      { from: 'C4060', to: 'C4120', type: 'FS', lag: 0 },
      { from: 'C4070', to: 'C4130', type: 'FS', lag: 0 },
      { from: 'C4140', to: 'C4120', type: 'FS', lag: 0 },
      { from: 'C4120', to: 'C4090', type: 'FS', lag: 0 },
      { from: 'C4130', to: 'C4090', type: 'FS', lag: 0 },
    ],
  };
}

/** Fragnet for the extension road: new subbase, binder, wearing, lighting tied into existing work and handover. */
export function syntheticFragnet(): Fragnet {
  return {
    id: 'FRAG-PVR-0418',
    eventDate: '2026-10-12',
    assessmentMode: 'prospective',
    affectedExisting: ['C4060', 'C4120'],
    affectedMilestones: ['C4090'],
    activities: [
      { id: 'N1000', description: 'Extension subbase CH 5+000 to 7+000', wbs: 'R4 / Extension / Subbase', type: 'task', calendarId: 'CAL6', durationBasis: 'Planner: crew output', durationDays: 25, resources: 'Subbase gang', startBasis: 'After wearing course tie-in' },
      { id: 'N1010', description: 'Extension binder course', wbs: 'R4 / Extension / Pavement', type: 'task', calendarId: 'CAL6', durationBasis: 'Planner: crew output', durationDays: 15, resources: 'Paving gang', startBasis: 'After subbase' },
      { id: 'N1020', description: 'Extension wearing course', wbs: 'R4 / Extension / Pavement', type: 'task', calendarId: 'CAL6', durationBasis: 'Planner: crew output', durationDays: 15, resources: 'Paving gang', startBasis: 'After binder' },
    ],
    links: [
      { from: 'C4050', to: 'N1000', type: 'FS', lag: 0, note: 'Existing binder complete, plant available' },
      { from: 'N1000', to: 'N1010', type: 'FS', lag: 0 },
      { from: 'N1010', to: 'N1020', type: 'FS', lag: 0 },
      { from: 'N1020', to: 'C4130', type: 'FS', lag: 0, note: 'Marking follows all pavement' },
    ],
  };
}

export function stableInputHash(parts: unknown): string {
  return hashString(JSON.stringify(parts));
}

export function freezeRun(args: {
  caseId: string;
  assessmentVersion: number;
  mappingVersion: number;
  scheduleVersion: string;
  dataDate: string;
  ratePolicyId: string;
  settings: CalcSettings;
  assumptions: string[];
  components: ScopeComponent[];
  adjustments: Adjustment[];
  network: CpmNetwork | null;
  scenarios: Scenario[];
  engineId: string;
  engineVersion?: string;
  createdAt?: string;
}): FrozenRun {
  const hash = stableInputHash({ c: args.components, a: args.adjustments, n: args.network, s: args.scenarios, set: args.settings, m: args.mappingVersion, sv: args.scheduleVersion });
  return {
    runId: `RUN-${args.caseId}-A${args.assessmentVersion}-${hash.slice(0, 6)}`,
    caseId: args.caseId,
    assessmentVersion: args.assessmentVersion,
    createdAt: args.createdAt ?? new Date().toISOString(),
    engineId: args.engineId,
    engineVersion: args.engineVersion ?? EMBEDDED_VERSION,
    inputs: { mappingVersion: args.mappingVersion, scheduleVersion: args.scheduleVersion, dataDate: args.dataDate, ratePolicyId: args.ratePolicyId },
    settings: args.settings,
    assumptions: args.assumptions,
    inputHash: hash,
  };
}

/** A run is stale if its input hash no longer matches the current inputs. */
export function isRunStale(run: FrozenRun, current: Parameters<typeof freezeRun>[0]): boolean {
  return freezeRun({ ...current, createdAt: run.createdAt }).inputHash !== run.inputHash;
}

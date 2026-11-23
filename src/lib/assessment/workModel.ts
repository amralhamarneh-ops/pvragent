import { D } from './decimal';

export type WorkStrategy =
  | 'increase_remaining' |'add_activity' |'insert_fragnet' |'resequence' |'change_resources' |'time_only_disruption';

export const STRATEGY_LABEL: Record<WorkStrategy, string> = {
  increase_remaining: 'Increase remaining duration of an existing activity',
  add_activity: 'Add a separate activity',
  insert_fragnet: 'Insert a fragnet',
  resequence: 'Resequence work',
  change_resources: 'Change resources / productivity',
  time_only_disruption: 'Model a time-only disruption',
};

export type ComponentArrangement = 'sequential' | 'parallel' | 'shared_resource';

export interface WorkModel {
  activityId: string;
  unit: string;
  originalPlanned: string;
  actualCompleted: string | null;
  /** Remaining quantity before change; null when no approved basis exists. */
  remainingBefore: string | null;
  added: string;
  omitted: string;
  /** Set when physical progress is derived from percent complete. Needs an approved basis. */
  progressBasis: 'measured' | 'approved_derivation' | 'none';
}

export interface WorkModelResult {
  ok: boolean;
  remainingAfter: string | null;
  errors: string[];
  warnings: string[];
  steps: string[];
}

/**
 * Model remaining work before changing duration.
 * An omission cannot remove executed work; added scope cannot be applied to completed work.
 */
export function modelRemainingWork(w: WorkModel): WorkModelResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const steps: string[] = [];
  if (w.actualCompleted === null || w.progressBasis === 'none') {
    errors.push('Actual completed quantity is unknown and there is no approved progress basis. Physical progress is not derived from duration percent complete.');
  }
  if (w.remainingBefore === null) errors.push('Remaining quantity before change is not established.');
  if (errors.length) return { ok: false, remainingAfter: null, errors, warnings, steps };
  const rem = D(w.remainingBefore as string);
  const add = D(w.added || '0');
  const om = D(w.omitted || '0');
  const planned = D(w.originalPlanned);
  const done = D(w.actualCompleted as string);
  steps.push(`Original planned ${planned.toString()} ${w.unit}; completed ${done.toString()}; remaining before change ${rem.toString()}.`);
  if (om.gt(rem)) {
    errors.push(`Omission of ${om.toString()} ${w.unit} exceeds the remaining ${rem.toString()} ${w.unit}. An omission cannot silently remove work already executed.`);
    return { ok: false, remainingAfter: null, errors, warnings, steps };
  }
  if (rem.isZero() && add.gt(0)) {
    errors.push('Activity has no remaining work (completed). Additional scope needs a new activity or fragnet; completed activities are not reopened.');
    return { ok: false, remainingAfter: null, errors, warnings, steps };
  }
  const after = rem.add(add).sub(om);
  steps.push(`Remaining after change = ${rem.toString()} + ${add.toString()} − ${om.toString()} = ${after.toString()} ${w.unit}.`);
  if (D(w.originalPlanned).sub(done).cmp(rem) !== 0) warnings.push('Remaining before change differs from planned minus completed. Confirm the basis.');
  return { ok: true, remainingAfter: after.toString(), errors, warnings, steps };
}

export interface ComponentDuration {
  id: string;
  name: string;
  days: number;
  resourceGroup?: string;
}

export interface CombineResult {
  ok: boolean;
  days: number | null;
  steps: string[];
  errors: string[];
}

/**
 * Combine component durations for an activity with several work components.
 * The arrangement must be explicit; the code does not guess between sum and max.
 */
export function combineComponents(components: ComponentDuration[], arrangement: ComponentArrangement | null): CombineResult {
  if (components.length === 0) return { ok: false, days: null, steps: [], errors: ['No components to combine.'] };
  if (components.length > 1 && !arrangement) {
    return { ok: false, days: null, steps: [], errors: ['Activity has several work components. State whether they are sequential, parallel or constrained by a shared resource.'] };
  }
  if (components.length === 1) return { ok: true, days: components[0].days, steps: [`Single component: ${components[0].days} working days.`], errors: [] };
  if (arrangement === 'sequential') {
    const t = components.reduce((a, c) => a + c.days, 0);
    return { ok: true, days: t, steps: [`Sequential: ${components.map((c) => c.days).join(' + ')} = ${t} working days.`], errors: [] };
  }
  if (arrangement === 'parallel') {
    const m = Math.max(...components.map((c) => c.days));
    return { ok: true, days: m, steps: [`Parallel (independent resources): longest component = ${m} working days.`], errors: [] };
  }
  const groups = new Map<string, number>();
  for (const c of components) {
    if (!c.resourceGroup) return { ok: false, days: null, steps: [], errors: [`Component "${c.name}" needs a shared resource group.`] };
    groups.set(c.resourceGroup, (groups.get(c.resourceGroup) ?? 0) + c.days);
  }
  const m = Math.max(...Array.from(groups.values()));
  return { ok: true, days: m, steps: [`Shared resource: components in one group run one after another; groups run in parallel. Result ${m} working days.`], errors: [] };
}

/** Non-quantity time effects that are not driven by a priced BOQ quantity. */
export type TimeEffectKind = 'design' | 'procurement' | 'approval' | 'mobilisation' | 'curing_testing' | 'handover' | 'disruption';

export interface TimeEffect {
  id: string;
  kind: TimeEffectKind;
  description: string;
  days: number;
  calendarId: string;
  source: string;
  supported: boolean;
}

export const TIME_EFFECT_LABEL: Record<TimeEffectKind, string> = {
  design: 'Design',
  procurement: 'Procurement',
  approval: 'Approvals',
  mobilisation: 'Mobilisation',
  curing_testing: 'Curing / testing',
  handover: 'Handover',
  disruption: 'Time-only disruption',
};

export function validateTimeEffects(effects: TimeEffect[]): string[] {
  const out: string[] = [];
  for (const e of effects) {
    if (!e.source.trim()) out.push(`${e.description}: no source or supporting basis recorded.`);
    if (!e.supported) out.push(`${e.description}: not yet supported by the change evidence.`);
    if (e.days < 0) out.push(`${e.description}: negative duration.`);
  }
  return out;
}

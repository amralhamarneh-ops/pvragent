import { D, Dec } from './decimal';

export type ProductivityBasis =
  | 'crew_output' |'labour_hours_per_unit' |'crew_hours_per_unit' |'equipment_hours_per_unit' |'planner_duration';

export const PRODUCTIVITY_LABEL: Record<ProductivityBasis, string> = {
  crew_output: 'Physical units per working day for a defined crew',
  labour_hours_per_unit: 'Labour-hours per physical unit',
  crew_hours_per_unit: 'Crew-hours per physical unit',
  equipment_hours_per_unit: 'Equipment-hours per physical unit',
  planner_duration: 'Planner-estimated duration (justified)',
};

export interface ProductivityInput {
  basis: ProductivityBasis;
  quantity: string;
  unit: string;
  source: string;
  calendarId: string;
  /** crew_output: approved total crew output per working day, already net of efficiency. */
  outputPerDay?: string;
  /** labour_hours_per_unit etc. */
  hoursPerUnit?: string;
  /** Capacity: number of resources and effective hours per resource per working day. Efficiency is applied ONCE, in `effectiveHoursPerDay`. */
  resourceCount?: string;
  effectiveHoursPerResourcePerDay?: string;
  /** Planner duration */
  plannerDurationDays?: string;
  plannerJustification?: string;
  roundingMode?: 'up' | 'half_up' | 'none';
  overrideNote?: string;
}

export interface ProductivityResult {
  ok: boolean;
  workingDays: string | null;
  roundedWorkingDays: number | null;
  requiredHours: string | null;
  capacityPerDay: string | null;
  formula: string;
  steps: string[];
  errors: string[];
}

function pos(v: string | undefined): Dec | null {
  if (v === undefined || v.trim() === '') return null;
  try {
    const d = D(v);
    return d.gt(0) ? d : null;
  } catch {
    return null;
  }
}

/**
 * Convert productivity into working duration. Never treats resource units as elapsed time.
 * Efficiency is not applied here; callers must give effective hours (already net of efficiency).
 */
export function computeDuration(p: ProductivityInput): ProductivityResult {
  const errors: string[] = [];
  const steps: string[] = [];
  const fail = (formula: string): ProductivityResult => ({ ok: false, workingDays: null, roundedWorkingDays: null, requiredHours: null, capacityPerDay: null, formula, steps, errors });
  const qty = pos(p.quantity);
  if (p.basis !== 'planner_duration' && !qty) errors.push('Quantity must be greater than zero.');
  if (!p.source.trim()) errors.push('Productivity source is required.');
  if (!p.calendarId.trim()) errors.push('A working calendar is required.');

  let days: Dec | null = null;
  let required: Dec | null = null;
  let capacity: Dec | null = null;
  let formula = '';

  if (p.basis === 'crew_output') {
    formula = 'Working duration = quantity ÷ approved total crew output per working day';
    const out = pos(p.outputPerDay);
    if (!out) errors.push('Approved crew output per working day is required.');
    if (qty && out) {
      days = qty.div(out);
      capacity = out;
      steps.push(`${qty.toString()} ${p.unit} ÷ ${out.toString()} ${p.unit}/day = ${days.toString()} working days`);
    }
  } else if (p.basis === 'planner_duration') {
    formula = 'Working duration = planner-estimated duration (requires justification)';
    const d = pos(p.plannerDurationDays);
    if (!d) errors.push('Planner duration must be greater than zero.');
    if (!p.plannerJustification || !p.plannerJustification.trim()) errors.push('Planner duration needs a written justification.');
    if (d) {
      days = d;
      steps.push(`Planner duration ${d.toString()} working days (justification recorded)`);
    }
  } else {
    const label = p.basis === 'labour_hours_per_unit' ? 'labour-hours' : p.basis === 'crew_hours_per_unit' ? 'crew-hours' : 'equipment-hours';
    formula = `Required ${label} = quantity × ${label} per unit. Working duration = required ${label} ÷ approved effective ${label} available per working day`;
    const hpu = pos(p.hoursPerUnit);
    const n = pos(p.resourceCount);
    const eff = pos(p.effectiveHoursPerResourcePerDay);
    if (!hpu) errors.push(`${label} per unit is required.`);
    if (!n) errors.push('Resource count (people, crews or items of equipment) is required.');
    if (!eff) errors.push('Effective hours per resource per working day is required (already net of efficiency).');
    if (qty && hpu) {
      required = qty.mul(hpu);
      steps.push(`Required ${label} = ${qty.toString()} × ${hpu.toString()} = ${required.toString()}`);
    }
    if (n && eff) {
      capacity = n.mul(eff);
      steps.push(`Capacity per working day = ${n.toString()} × ${eff.toString()} = ${capacity.toString()} ${label}`);
    }
    if (required && capacity) {
      days = required.div(capacity);
      steps.push(`Working duration = ${required.toString()} ÷ ${capacity.toString()} = ${days.toString()} working days (not ${required.toString()} elapsed hours)`);
    }
  }

  if (errors.length || !days) return fail(formula);
  const mode = p.roundingMode ?? 'up';
  let rounded: number;
  if (mode === 'none') rounded = days.toNumber();
  else if (mode === 'half_up') rounded = days.round(0, 'half_up').toNumber();
  else rounded = days.round(0, 'up').toNumber();
  steps.push(mode === 'none' ? 'No rounding applied before calendar placement.' : `Rounded ${mode === 'up' ? 'up' : 'half-up'} to ${rounded} whole working days (planner-selectable).`);
  if (p.overrideNote?.trim()) steps.push(`Planner override note: ${p.overrideNote.trim()}`);
  return { ok: true, workingDays: days.toString(), roundedWorkingDays: rounded, requiredHours: required ? required.toString() : null, capacityPerDay: capacity ? capacity.toString() : null, formula, steps, errors: [] };
}

/** Field-mapping for imported productivity data. Never assume resource units are physical quantities. */
export type ResourceFieldKind = 'ignore' | 'budgeted_labour_hours' | 'budgeted_equipment_hours' | 'physical_quantity' | 'crew_output_per_day' | 'cost_only';

export interface ResourceFieldMapping {
  sourceField: string;
  origin: 'task_udf' | 'resource_assignment' | 'activity_code' | 'supporting_reference';
  sampleValue: string;
  mappedTo: ResourceFieldKind;
  unit: string;
  reliability: 'unverified' | 'planner_verified';
}

export const RESOURCE_KIND_LABEL: Record<ResourceFieldKind, string> = {
  ignore: 'Do not use',
  budgeted_labour_hours: 'Budgeted labour-hours',
  budgeted_equipment_hours: 'Budgeted equipment-hours',
  physical_quantity: 'Physical quantity (with unit)',
  crew_output_per_day: 'Crew output per working day',
  cost_only: 'Cost only, not a productivity input',
};

export function usableProductivityFields(maps: ResourceFieldMapping[]): ResourceFieldMapping[] {
  return maps.filter((m) => m.mappedTo !== 'ignore' && m.mappedTo !== 'cost_only' && m.reliability === 'planner_verified');
}

/** Sample fields as they might appear in an XER. Clearly synthetic, unverified until the planner maps them. */
export function sampleResourceFields(): ResourceFieldMapping[] {
  return [
    { sourceField: 'TASKRSRC.target_qty (R4 paving gang)', origin: 'resource_assignment', sampleValue: '4200', unit: 'h', mappedTo: 'ignore', reliability: 'unverified' },
    { sourceField: 'TASKRSRC.target_cost', origin: 'resource_assignment', sampleValue: '188000', unit: 'AED', mappedTo: 'cost_only', reliability: 'unverified' },
    { sourceField: 'UDF: Planned quantity (m2)', origin: 'task_udf', sampleValue: '35000', unit: 'm2', mappedTo: 'ignore', reliability: 'unverified' },
    { sourceField: 'UDF: Crew output per day', origin: 'task_udf', sampleValue: '', unit: 'm2/day', mappedTo: 'ignore', reliability: 'unverified' },
  ];
}

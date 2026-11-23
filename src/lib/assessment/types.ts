/** Shared types for the cost and programme assessment pipeline. */

export type ApprovalState = 'proposed' | 'assessed' | 'approved';

export type CostLineKind = 'addition' | 'omission' | 'abortive' | 'adjustment' | 'unpriced';

export type RateSourceType =
  | 'contract_rate' |'derived_pro_rata' |'historical_benchmark' |'first_principles' |'daywork' |'quotation';

export const RATE_SOURCE_LABEL: Record<RateSourceType, string> = {
  contract_rate: 'Existing contract rate',
  derived_pro_rata: 'Derived / pro-rata rate',
  historical_benchmark: 'Approved historical benchmark',
  first_principles: 'First-principles build-up',
  daywork: 'Daywork basis',
  quotation: 'Quotation',
};

export type RateComponent = 'labour' | 'materials' | 'plant' | 'waste' | 'overheads' | 'profit' | 'other';

export interface Comparability {
  specification: boolean | null;
  location: boolean | null;
  timing: boolean | null;
  note: string;
}

export interface BuildUpRow {
  id: string;
  component: RateComponent;
  description: string;
  quantity: string;
  unit: string;
  unitCost: string;
  wastePct: string;
}

export interface RateRecord {
  id: string;
  source: RateSourceType;
  sourceRef: string;
  date: string;
  currency: string;
  unit: string;
  /** Source precision is preserved as a string. */
  value: string;
  inclusions: RateComponent[];
  exclusions: RateComponent[];
  derivation: string;
  adjustments: string;
  approval: ApprovalState;
  comparability?: Comparability;
  buildUp?: BuildUpRow[];
  /** Mark-ups applied inside a first-principles build-up (percent strings). */
  markups?: { overheadsPct: string; profitPct: string };
  fxAssumption?: { from: string; to: string; rate: string; date: string };
}

export interface RatePolicy {
  id: string;
  name: string;
  approvedBy: string;
  /** Ordered list of rate sources the project permits; order is a workflow, not an entitlement rule. */
  order: RateSourceType[];
  enabled: Record<RateSourceType, boolean>;
  currency: string;
  rounding: { places: number; mode: 'half_up' | 'half_even' | 'down' | 'up' };
}

export type MeasurementBasis = 'measured' | 'document_stated' | 'narrative_stated' | 'derived' | 'assumed' | 'user_confirmed';

export interface ScopeComponent {
  id: string;
  /** Work key used to detect overlapping charges (same physical work). */
  workKey: string;
  boqRef: string;
  description: string;
  kind: Exclude<CostLineKind, 'unpriced' | 'adjustment'>;
  quantity: string;
  unit: string;
  /** Unit the BOQ rate is expressed in. Conversion must be explicit. */
  rateUnit?: string;
  conversionFactor?: string;
  conversionNote?: string;
  rateId: string | null;
  changeIds: string[];
  basis: MeasurementBasis;
  /** If the selected rate bundles other components of the same work, list them here. */
  bundledWorkKeys?: string[];
  replacementGroup?: string;
  preamble?: string;
}

export interface Adjustment {
  id: string;
  label: string;
  type: 'overheads' | 'profit' | 'escalation' | 'time_related' | 'other';
  mode: 'percent_of_base' | 'fixed';
  value: string;
  evidence: string;
  justification: string;
  enabled: boolean;
  approval: ApprovalState;
}

export interface CalcSettings {
  currency: string;
  rounding: { places: number; mode: 'half_up' | 'half_even' | 'down' | 'up' };
  taxRatePct: string | null;
  taxLabel: string;
}

export interface CostLineResult {
  id: string;
  componentId: string;
  boqRef: string;
  description: string;
  kind: CostLineKind;
  quantity: string;
  unit: string;
  rateUnit: string;
  convertedQuantity: string | null;
  rate: string | null;
  currency: string;
  amount: string | null;
  rateSource: RateSourceType | null;
  rateId: string | null;
  rateComponents: { included: RateComponent[]; excluded: RateComponent[] } | null;
  approval: ApprovalState;
  issues: string[];
  excludedFromTotals: boolean;
  replacementGroup?: string;
}

export interface CostResult {
  lines: CostLineResult[];
  additions: string;
  omissions: string;
  abortive: string;
  adjustmentsTotal: string;
  adjustmentLines: { id: string; label: string; amount: string; type: Adjustment['type']; evidence: string }[];
  /** additions − omissions + abortive + justified adjustments, priced lines only. */
  netAssessed: string;
  pricedLineCount: number;
  unpricedLines: CostLineResult[];
  isComplete: boolean;
  tax: { label: string; ratePct: string; amount: string; grossIncludingTax: string } | null;
  replacements: { group: string; omitted: string; added: string; net: string; complete: boolean }[];
  warnings: string[];
  blockers: string[];
  currency: string;
  approvalSummary: Record<ApprovalState, string>;
}

export interface ProgrammeInputsRef {
  mappingVersion: number;
  scheduleVersion: string;
  dataDate: string;
}

export type ScenarioKind = 'reference' | 'change' | 'mitigation';

export interface Scenario {
  id: string;
  name: string;
  kind: ScenarioKind;
  /** Change IDs included. Cumulative scenarios list several. */
  changeIds: string[];
  mitigationNote?: string;
}

export interface FrozenRun {
  runId: string;
  caseId: string;
  assessmentVersion: number;
  createdAt: string;
  engineId: string;
  engineVersion: string;
  inputs: { mappingVersion: number; scheduleVersion: string; dataDate: string; ratePolicyId: string };
  settings: CalcSettings;
  assumptions: string[];
  inputHash: string;
}

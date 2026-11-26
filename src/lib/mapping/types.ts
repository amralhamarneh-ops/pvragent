export type ChangeType = 'added' | 'removed' | 'modified';
export type MeasureKind = 'length' | 'area' | 'count' | 'volume';
export type BoqClass = 'omission' | 'addition' | 'abortive' | 'new';
export type BoqStatus = 'confirmed' | 'needs_confirmation' | 'inferred';
export type ProgressStatus = 'completed' | 'in_progress' | 'not_started';

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DrawingChange {
  id: string;
  type: ChangeType;
  title: string;
  layer: string;
  zone: string;
  discipline: string;
  measure: MeasureKind;
  value: number;
  unit: string;
  bbox: BBox;
  confidence: number;
  evidence: string;
  reason: string;
  included: boolean;
  needsQuestion?: string;
  editReason?: string;
}

export interface BoqAlternative {
  boqRef: string;
  description: string;
  confidence: number;
  rejectedBecause: string;
  unit: string;
  bill: number;
  rate: number;
}

export interface BoqMapping {
  id: string;
  changeIds: string[];
  boqRef: string;
  description: string;
  bill: number;
  class: BoqClass;
  unit: string;
  quantity: number;
  quantityCalc: string;
  rateRef: number | null;
  status: BoqStatus;
  confidence: number;
  rationale: string;
  preamble: string;
  alternatives: BoqAlternative[];
  sources: string;
  included: boolean;
}

export interface ActivityCandidate {
  activityId: string;
  name: string;
  wbsPath: string;
  baselineStart: string;
  baselineFinish: string;
  durationDays: number;
  totalFloat: number;
  progressStatus: ProgressStatus;
  progressPct: number;
  isCritical: boolean;
  confidence: number;
  reason: string;
}

export interface ActivityMapping {
  id: string;
  boqMappingId: string;
  activityId: string | null;
  wbsPath: string;
  baselineStart: string;
  baselineFinish: string;
  durationDays: number;
  totalFloat: number;
  progressStatus: ProgressStatus;
  isCritical: boolean;
  quantityShare: number;
  confidence: number;
  reason: string;
  newActivityNeeded: boolean;
  accepted: boolean;
  candidate?: ActivityCandidate;
}

export interface NewActivitySuggestion {
  boqMappingId: string;
  name: string;
  predecessor: string;
  successor: string;
  accepted: boolean;
}

export interface ScheduleRelationship {
  from: string;
  to: string;
  type: 'FS' | 'SS' | 'FF' | 'SF';
  lag: number;
  /** Lag in the source unit (hours in XER). `lag` stays in days only when a calendar made that conversion possible. */
  lagHours?: number;
  /** Internal task ids (TASKPRED task_id / pred_task_id) preserved from the source. */
  fromTaskId?: string;
  toTaskId?: string;
  /** False when either end of the relationship could not be resolved to an imported activity. */
  resolved?: boolean;
}

export type ActivityKind = 'task' | 'milestone_start' | 'milestone_finish' | 'summary' | 'level_of_effort' | 'resource_dependent' | 'wbs_summary' | 'unknown';
export type ActivityStatus = 'not_started' | 'in_progress' | 'completed' | 'unknown';

export interface ActivityResourceAssignment {
  resourceId: string;
  resourceName: string;
  resourceCode: string;
  resourceType: string;
  /** Source quantities exactly as exported. Units are in `unit`. */
  targetQty: number | null;
  remainingQty: number | null;
  actualQty: number | null;
  unit: string;
  /** Productivity-like basis if the export carries one (qty per time) - never assumed. */
  unitsPerTimeText: string;
}

export interface ActivityConstraint {
  type: string;
  date: string;
}

export interface ScheduleActivity {
  /** Display activity code (task_code). Shown to people. */
  id: string;
  /** Internal source task id (task_id). Relationships link on this. */
  taskId?: string;
  name: string;
  /** Slash-joined WBS path from the root. */
  wbs: string;
  wbsId?: string;
  wbsPath?: string[];
  start: string;
  finish: string;
  /** Planned duration in days when the calendar hours-per-day is known; otherwise the source hours / 8 is NOT used. */
  duration: number;
  totalFloat: number;
  progressPct: number;
  chainFrom: number;
  chainTo: number;
  discipline: string;
  zone: string;
  // ---- Source-preserving fields (all optional so demo data still type-checks) ----
  kind?: ActivityKind;
  status?: ActivityStatus;
  rawTaskType?: string;
  rawStatusCode?: string;
  durationHours?: number | null;
  remainingDurationHours?: number | null;
  actualStart?: string;
  actualFinish?: string;
  earlyStart?: string;
  earlyFinish?: string;
  remainingStart?: string;
  remainingFinish?: string;
  totalFloatHours?: number | null;
  calendarId?: string;
  calendarName?: string;
  /** Hours per working day of the activity's calendar, when stated. */
  hoursPerDay?: number | null;
  constraints?: ActivityConstraint[];
  resources?: ActivityResourceAssignment[];
  activityCodes?: Record<string, string>;
  udf?: Record<string, string>;
  /** Time unit the numeric fields were converted from. */
  sourceTimeUnit?: 'hours';
}

export interface ScheduleCalendar {
  id: string;
  name: string;
  hoursPerDay: number | null;
  hoursPerWeek: number | null;
  hoursPerMonth: number | null;
  hoursPerYear: number | null;
  type: string;
  /** Raw working-time / exception data kept verbatim so no calendar is silently flattened. */
  rawData: string;
  exceptions: string[];
}

export interface ProductivityField {
  /** Where the value was found (table.field). */
  field: string;
  basis: string;
  assignments: number;
}

export interface ScheduleWbsNode {
  id: string;
  parentId: string;
  name: string;
  code: string;
  path: string[];
}

export interface ScheduleModel {
  /** Lossless source tables, including scheduling options and resource rates. */
  rawTables?: Record<string, { fields: string[]; rows: string[][] }>;
  fileName: string;
  activityCount: number;
  dataDate: string;
  activities: ScheduleActivity[];
  relationships: ScheduleRelationship[];
  // ---- Preserved structure from the XER ----
  wbs?: ScheduleWbsNode[];
  calendars?: ScheduleCalendar[];
  resources?: { id: string; name: string; code: string; type: string }[];
  activityCodeTypes?: string[];
  udfTypes?: string[];
  /** Fields that look like productivity or resource rates, and what they are measured against. Empty when the file has none. */
  productivityFields?: ProductivityField[];
  /** Everything the parser could not map, stated rather than skipped silently. */
  warnings?: string[];
  tablesFound?: string[];
}

export type StageStatus = 'not_started' | 'running' | 'needs_review' | 'confirmed' | 'needs_rerun' | 'locked';

export interface MappingVersion {
  id: string;
  caseId: string;
  version: number;
  confirmedBy: string;
  confirmedAt: string;
  contents: {
    drawingChanges: DrawingChange[];
    boqMappings: BoqMapping[];
    activityMappings: ActivityMapping[];
    newActivities: NewActivitySuggestion[];
  };
  upstreamVersions: { drawing: number; boq: number; activity: number };
}

export interface AgentEvent {
  id: string;
  agent: 'Orchestrator' | 'Drawing agent' | 'BoQ agent' | 'Schedule agent';
  kind: 'plan' | 'step' | 'finding' | 'challenge' | 'resolution' | 'question' | 'handover';
  text: string;
  time: string;
  durationMs?: number;
}

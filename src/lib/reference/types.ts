/** Reference Cases & Learning: types. A reference case is a reviewed library record, never a trained model. */

export type ReferenceStatus = 'draft' | 'under_review' | 'approved' | 'retired';
export type ReferencePartition = 'learning' | 'evaluation';

export const STATUS_LABEL: Record<ReferenceStatus, string> = {
  draft: 'Draft',
  under_review: 'Under review',
  approved: 'Approved reference',
  retired: 'Retired',
};

export type SourceRole =
  | 'pvr_narrative' | 'supporting' | 'drawing_original' | 'drawing_revised' | 'boq' | 'boq_revision' |'schedule_pre' | 'schedule_post' | 'cost_calc' | 'takeoff' | 'outcome';

export const SOURCE_ROLES: { role: SourceRole; label: string; required: boolean }[] = [
  { role: 'pvr_narrative', label: 'PVR narrative', required: true },
  { role: 'supporting', label: 'Supporting documents', required: false },
  { role: 'drawing_original', label: 'Original drawings', required: true },
  { role: 'drawing_revised', label: 'Revised drawings', required: true },
  { role: 'boq', label: 'BOQ', required: true },
  { role: 'boq_revision', label: 'BOQ revision', required: false },
  { role: 'schedule_pre', label: 'Pre-impact schedule', required: true },
  { role: 'schedule_post', label: 'Simulated / post-impact schedule', required: true },
  { role: 'cost_calc', label: 'Cost calculation', required: false },
  { role: 'takeoff', label: 'Quantity take-off', required: false },
  { role: 'outcome', label: 'Reviewed outcome', required: true },
];

export interface ReferenceSource {
  id: string;
  role: SourceRole;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  stored: boolean;
  storagePath: string | null;
  readStatus: 'read' | 'partial' | 'not_read';
  readDetail: string;
  textExcerpt: string;
  uploadedAt: string;
}

/** Quantity with its measurement basis. Original and revised are separate; nothing is netted silently. */
export interface QuantityPair {
  item: string;
  unit: string;
  original: number | null;
  revised: number | null;
  basis: string;
}

export interface BoqMapping { item: string; boqRef: string; unit: string; rateBasis: string; rate: number | null }
export interface ActivityMapping { activityId: string; name: string; rationale: string }

export interface ScheduleImpact {
  /** Which schedule produced the figure. Simulated and observed are NEVER merged. */
  simulatedDelayDays: number | null;
  simulationSettings: string;
  milestoneImpact: string;
  completionImpact: string;
  observedActualDelayDays: number | null;
  observedNote: string;
}

/** Claimed, assessed, approved and actual are four separate fields. */
export interface OutcomeFigures {
  claimed: number | null;
  assessed: number | null;
  approved: number | null;
  actual: number | null;
  currency: string;
  /** Free-text. An approved settlement does not by itself prove the technical calculation. */
  settlementNote: string;
  technicallyVerified: boolean;
}

export interface ReviewerCorrection { field: string; was: string; shouldBe: string; why: string }

export interface LearningRecord {
  changeType: string;
  workType: string;
  location: string;
  specifications: string[];
  /** Minimised: roles only, no names or contact details. */
  projectContext: string;
  quantities: QuantityPair[];
  boqMappings: BoqMapping[];
  activityMappings: ActivityMapping[];
  productivity: { assumption: string; resources: string; calendar: string; durationBasis: string };
  schedule: ScheduleImpact;
  outcome: OutcomeFigures;
  corrections: ReviewerCorrection[];
  reasoning: string;
  assumptions: string[];
  /** Searchable geometry / document references (source id plus locator). */
  geometryRefs: { sourceId: string; locator: string }[];
}

export interface ReviewEntry {
  at: string;
  action: 'created' | 'submitted' | 'approved' | 'returned' | 'retired' | 'replaced' | 'edited' | 'moved_partition';
  reviewer: string;
  version: number;
  note: string;
  evidence: string[];
}

export interface ReferenceCase {
  id: string;
  caseGroup: string;
  version: number;
  title: string;
  status: ReferenceStatus;
  partition: ReferencePartition;
  record: LearningRecord;
  sources: ReferenceSource[];
  missingEvidence: string[];
  reviewHistory: ReviewEntry[];
  replacedBy: string | null;
  /** Always false. Fine-tuning is a separate explicit process that does not exist in this module. */
  usedInFineTuning: false;
  createdAt: string;
  updatedAt: string;
}

/** The current project's own facts. Precedents may never override these. */
export interface CurrentContext {
  changeType: string;
  workType: string;
  specification: string;
  unit: string;
  projectContext: string;
  scheduleConditions: string;
  /** Present for audit: the current project's authoritative inputs, echoed so callers can show they were not replaced. */
  authoritative?: { quantities?: string; rates?: string; scheduleLogic?: string; calendars?: string; productivity?: string; contract?: string };
}

export interface SuitabilityCheck {
  name: string;
  result: 'match' | 'partial' | 'mismatch' | 'unknown';
  detail: string;
}

export interface PrecedentDecision {
  referenceId: string;
  title: string;
  version: number;
  score: number;
  decision: 'used' | 'rejected';
  checks: SuitabilityCheck[];
  /** Why it was rejected, or what it was allowed to influence. */
  reason: string;
  influence: string;
  citations: { sourceId: string; fileName: string; locator: string }[];
}

export interface RetrievalResult {
  query: CurrentContext;
  used: PrecedentDecision[];
  rejected: PrecedentDecision[];
  /** Explicit statement when nothing suitable exists. */
  noSuitableReference: boolean;
  statement: string;
  /** What the precedents were NOT allowed to replace. */
  notReplaced: string[];
}

export type EvalStage =
  | 'documentCoverage' | 'changeDetection' | 'quantityAccuracy' | 'boqMapping' | 'activityMapping' | 'programmeImpact' | 'evidenceQuality';

export const EVAL_STAGES: { key: EvalStage; label: string }[] = [
  { key: 'documentCoverage', label: 'Document coverage' },
  { key: 'changeDetection', label: 'Change detection' },
  { key: 'quantityAccuracy', label: 'Quantity accuracy' },
  { key: 'boqMapping', label: 'BOQ mapping and valuation' },
  { key: 'activityMapping', label: 'Activity mapping' },
  { key: 'programmeImpact', label: 'Programme impact' },
  { key: 'evidenceQuality', label: 'Evidence and exception handling' },
];

export interface Discrepancy { stage: EvalStage; caseId: string; field: string; expected: string; actual: string }

export interface StageResult {
  stage: EvalStage;
  compared: number;
  matched: number;
  /** Null when nothing could be compared. Never a made-up score. */
  rate: number | null;
  note: string;
}

export interface EvaluationRun {
  id: string;
  runAt: string;
  caseIds: string[];
  /** Cases skipped, with the reason (for example: pipeline output missing, leakage). */
  skipped: { caseId: string; reason: string }[];
  stages: StageResult[];
  discrepancies: Discrepancy[];
  /** Where the "actual" side came from. */
  actualSource: string;
  leakage: { ok: boolean; issues: string[] };
}

/** Output of the real processing pipeline for one case, supplied by the caller. Never invented here. */
export interface PipelineOutput {
  caseId: string;
  documentsRead: string[];
  changesDetected: string[];
  quantities: { item: string; unit: string; value: number }[];
  boqMappings: { item: string; boqRef: string; rate: number | null }[];
  activityIds: string[];
  simulatedDelayDays: number | null;
  exceptionsFlagged: string[];
}

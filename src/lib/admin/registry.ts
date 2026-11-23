/**
 * Agent registry for the Admin Kit. This is derived from the code that actually exists in this repository.
 * Every entry with status "implemented" or "partial" lists the source files that execute it (`code`). A unit test
 * checks that every listed file exists, so nothing here can name an agent that has no execution code.
 * Capabilities with no code are listed as "missing" or "planned" and are never shown as connected.
 */

export type AgentKind = 'ai_agent' | 'deterministic' | 'workflow_service' | 'hybrid';
export type ImplStatus = 'implemented' | 'partial' | 'planned' | 'missing';

export interface AgentModelCall {
  route: string;
  phase?: string;
  maxCompletionTokens: number;
  modelEnv: string;
  note: string;
}

export interface AgentTool {
  id: string;
  label: string;
  /** What kind of check can be run for it from the Admin Kit. */
  check: 'worker' | 'model' | 'database' | 'none';
  external: boolean;
}

export interface AgentDef {
  id: string;
  name: string;
  responsibility: string;
  kind: AgentKind;
  status: ImplStatus;
  /** Real files that execute this agent. Empty only for missing/planned. */
  code: string[];
  purpose: string;
  inputs: string[];
  outputs: string[];
  modelCalls: AgentModelCall[];
  tools: AgentTool[];
  upstream: string[];
  downstream: string[];
  referenceAccess: 'approved_precedents' | 'none';
  automaticDecisions: string[];
  humanInput: string[];
  limits: { maxItems?: string; retry: string; cancellation: string };
  /** Protected controls enforced in code. Not editable through rules. */
  protectedControls: string[];
  /** Plain statement of what is not built, for partial/missing/planned. */
  gaps: string[];
  /** Whether published rules from the Admin Kit are read by this agent at run time. */
  rulesExecute: boolean;
}

const T = {
  openai: { id: 'openai', label: 'OpenAI model (server key)', check: 'model', external: true } as AgentTool,
  db: { id: 'database', label: 'Supabase database', check: 'database', external: true } as AgentTool,
  worker: { id: 'worker', label: 'Processing worker', check: 'worker', external: true } as AgentTool,
  none: { id: 'in-process', label: 'In-process code (no external tool)', check: 'none', external: false } as AgentTool,
};

export const AGENTS: AgentDef[] = [
  {
    id: 'master',
    name: 'Master / Orchestrator',
    responsibility: 'Check prerequisites, dispatch tasks, track job states, reconcile conflicts, invalidate stale results, consolidate.',
    kind: 'workflow_service',
    status: 'partial',
    code: ['src/lib/boq/agentClient.ts', 'src/lib/drawings/jobService.ts', 'src/app/api/processing/jobs/route.ts', 'src/app/case-workspace/components/RealCaseWorkspace.tsx'],
    purpose: 'Runs the BOQ analysis sequence (understand change, search BOQ set, relate to lines) in the browser, and submits, stops, resumes and retries durable drawing-processing jobs on the server.',
    inputs: ['Case narrative and evidence documents', 'Included BOQ set', 'Selected drawings'],
    outputs: ['Agent event log', 'Durable job and task state', 'Staleness flags when inputs change'],
    modelCalls: [],
    tools: [T.db, T.worker],
    upstream: ['intake'],
    downstream: ['scope', 'boq_mapping', 'drawing', 'planning', 'cost'],
    referenceAccess: 'none',
    automaticDecisions: ['Skip a model call when identical evidence is cached', 'Reuse compatible completed job tasks on resume', 'Mark an analysis stale when BOQ or inputs change'],
    humanInput: ['Choosing between competing revisions', 'Confirming overlapping BOQ lines', 'Stopping or resuming a job'],
    limits: { maxItems: 'One active job per case run id', retry: 'Failed tasks are re-queued by Retry; tasks have max_attempts (default 3) in the database', cancellation: 'Stop requests server-side cancellation; state shows "stopping" until the worker acknowledges' },
    protectedControls: ['Per-run pinning to config_version', 'Ownership checks on every case route', 'Duplicate-result publication guard (lease token)'],
    gaps: ['No server-side orchestrator for the BOQ analysis sequence: it runs in the browser (runAgent).', 'Conflict reconciliation between specialist findings is not automated.', 'Downstream invalidation covers BOQ signature and job inputs only, not every stage.'],
    rulesExecute: false,
  },
  {
    id: 'intake',
    name: 'Document Intake & Classification',
    responsibility: 'Classify uploaded documents and decide readiness.',
    kind: 'deterministic',
    status: 'implemented',
    code: ['src/app/api/intake/triage/route.ts', 'src/lib/intake/triage.ts', 'src/lib/intake/readiness.ts', 'src/lib/intake/docGroups.ts', 'src/lib/docs/categories.ts'],
    purpose: 'Rule-based classification of uploaded files into document categories and a readiness check before analysis.',
    inputs: ['Uploaded file names and metadata'],
    outputs: ['Document category', 'Readiness messages'],
    modelCalls: [],
    tools: [T.none],
    upstream: [],
    downstream: ['master'],
    referenceAccess: 'none',
    automaticDecisions: ['Assign a document category from file name and type'],
    humanInput: ['Correcting a wrongly classified document'],
    limits: { retry: 'Stateless; safe to repeat', cancellation: 'Not applicable (synchronous)' },
    protectedControls: ['Classification is deterministic code; no model output is trusted'],
    gaps: [],
    rulesExecute: false,
  },
  {
    id: 'scope',
    name: 'PVR Scope & Evidence',
    responsibility: 'Reconcile narrative, documents and drawings; separate stated, measured, derived and assumed information.',
    kind: 'hybrid',
    status: 'implemented',
    code: ['src/app/api/boq-match/route.ts', 'src/lib/boq/agentSchemas.ts', 'src/lib/boq/scope.ts'],
    purpose: 'A model reads the narrative and extracted evidence and proposes change components. A deterministic validator then drops any quantity whose quote is not in the evidence.',
    inputs: ['Narrative (first 6,000 characters)', 'Up to 12 evidence items (5,000 characters each)'],
    outputs: ['Structured change scope with quoted quantities, contradictions, missing information, limitations'],
    modelCalls: [{ route: '/api/boq-match', phase: 'scope', maxCompletionTokens: 6000, modelEnv: 'OPENAI_MODEL', note: 'JSON response; result cached in-process for one hour' }],
    tools: [T.openai, T.db],
    upstream: ['intake'],
    downstream: ['boq_mapping'],
    referenceAccess: 'none',
    automaticDecisions: ['Create components supported by evidence', 'Flag plausible but unestablished components as potential'],
    humanInput: ['Quantity not stated in evidence', 'Contradictions between documents'],
    limits: { maxItems: '12 evidence items, 6,000-character narrative', retry: 'Caller retries; identical input is served from cache', cancellation: 'Not cancellable once the model request is sent' },
    protectedControls: ['Quantity kept only if its quote appears in the evidence', 'Untrusted document wrapper', 'JSON schema sanitiser'],
    gaps: [],
    rulesExecute: true,
  },
  {
    id: 'drawing',
    name: 'Drawing & Take-off',
    responsibility: 'Read drawings, pair revisions, validate units and alignment, compare geometry, quantify evidenced changes, report coverage.',
    kind: 'deterministic',
    status: 'partial',
    code: ['src/lib/drawings/compare.ts', 'src/lib/drawings/analyse.ts', 'src/lib/drawings/dxfRead.ts', 'src/lib/drawings/dwgConvert.ts', 'services/processing-worker/src/dxf.mjs', 'services/processing-worker/src/dwg.mjs', 'services/processing-worker/src/runner.mjs'],
    purpose: 'Deterministic DXF geometry reading, revision pairing and comparison; DWG goes through a converter on the processing worker.',
    inputs: ['DXF drawings', 'DWG drawings (via converter)', 'PDF/DOCX/image text'],
    outputs: ['Paired revisions', 'Geometry changes', 'Measured quantities with coverage and limitations'],
    modelCalls: [],
    tools: [T.worker],
    upstream: ['intake', 'master'],
    downstream: ['boq_mapping', 'planning', 'cost'],
    referenceAccess: 'none',
    automaticDecisions: ['Pair drawings by identity', 'Measure supported entities'],
    humanInput: ['Unpaired drawings', 'Unit or scale conflicts', 'Unsupported entities'],
    limits: { retry: 'Durable task retries up to max_attempts', cancellation: 'Server-side stop; completed checkpoints are kept' },
    protectedControls: ['Quantities come only from measured geometry', 'DWG reported "Not processed: converter unavailable" until a converter is verified'],
    gaps: ['DWG conversion depends on a deployed converter reachable through the worker.', 'Unsupported CAD entities are reported as coverage limits, not measured.'],
    rulesExecute: false,
  },
  {
    id: 'boq_mapping',
    name: 'BOQ Mapping',
    responsibility: 'Search all included BOQs, validate scope, specification and unit, separate alternatives from additional work.',
    kind: 'hybrid',
    status: 'implemented',
    code: ['src/app/api/boq-match/route.ts', 'src/lib/boq/retrieve.ts', 'src/lib/boq/matchEngine.ts', 'src/lib/boq/documents.ts', 'src/lib/boq/agentSchemas.ts'],
    purpose: 'Deterministic retrieval shortlists candidate BOQ lines across every included document; a model relates components to those candidates only; a validator discards any row id not in the shortlist.',
    inputs: ['Change scope', 'Shortlisted candidate lines per component'],
    outputs: ['Primary and alternative lines', 'Potentially affected', 'Unmatched', 'Overlaps'],
    modelCalls: [{ route: '/api/boq-match', phase: 'match', maxCompletionTokens: 6000, modelEnv: 'OPENAI_MODEL', note: 'Only candidate lines are sent, never the full BOQ' }],
    tools: [T.openai, T.db],
    upstream: ['scope'],
    downstream: ['cost'],
    referenceAccess: 'none',
    automaticDecisions: ['Propose a primary line from candidates', 'Mark overlapping composite rates'],
    humanInput: ['Confirming a primary line', 'Alternative BOQs that overlap'],
    limits: { retry: 'Caller retries; identical scope and candidates are cached', cancellation: 'Not cancellable once the model request is sent' },
    protectedControls: ['Row ids must come from the candidate list', 'No quantity or rate is produced by the model'],
    gaps: [],
    rulesExecute: true,
  },
  {
    id: 'cost',
    name: 'Cost & Valuation',
    responsibility: 'Additions, omissions, replacements, unpriced and excluded scope, using deterministic arithmetic.',
    kind: 'deterministic',
    status: 'implemented',
    code: ['src/lib/assessment/costEngine.ts', 'src/lib/assessment/decimal.ts', 'src/lib/assessment/rates.ts', 'src/lib/boq/valuation.ts', 'src/lib/boq/calc.ts', 'src/lib/boq/units.ts'],
    purpose: 'Decimal arithmetic for quantity x rate, unit checks, overlap detection and valuation. No model is involved.',
    inputs: ['Confirmed BOQ lines', 'Measured or stated quantities', 'Contract rates'],
    outputs: ['Cost build-up', 'Unpriced and excluded scope list'],
    modelCalls: [],
    tools: [T.none],
    upstream: ['boq_mapping', 'drawing'],
    downstream: ['reporting'],
    referenceAccess: 'none',
    automaticDecisions: ['Calculate priced lines', 'Preserve unpriced scope'],
    humanInput: ['Rate selection for new items', 'Resolving unit mismatches'],
    limits: { retry: 'Pure functions; safe to repeat', cancellation: 'Not applicable (synchronous)' },
    protectedControls: ['Arithmetic is code, never editable through rules or prompts'],
    gaps: [],
    rulesExecute: false,
  },
  {
    id: 'planning',
    name: 'Planning & Schedule Simulation',
    responsibility: 'Read XER, inspect logic, map changed work, derive duration from a productivity basis, simulate a controlled copy.',
    kind: 'deterministic',
    status: 'implemented',
    code: ['src/lib/mapping/xerParser.ts', 'src/lib/assessment/cpmEngine.ts', 'src/lib/assessment/schedulingEngine.ts', 'src/lib/assessment/productivity.ts', 'src/lib/mapping/activityEngine.ts'],
    purpose: 'Embedded CPM engine on a controlled copy of the schedule; duration comes from documented productivity inputs. A language model never produces schedule dates.',
    inputs: ['XER schedule', 'Mapped activities', 'Productivity and resource basis'],
    outputs: ['Activity, milestone and project impacts', 'Comparison between scenarios'],
    modelCalls: [],
    tools: [T.none],
    upstream: ['boq_mapping', 'drawing'],
    downstream: ['contract', 'reporting'],
    referenceAccess: 'none',
    automaticDecisions: ['Parse XER', 'Run CPM on the controlled copy'],
    humanInput: ['Activity mapping confirmation', 'Productivity basis'],
    limits: { retry: 'Pure functions; safe to repeat', cancellation: 'Not applicable (synchronous)' },
    protectedControls: ['Dates come only from the CPM engine', 'Original schedule is never modified'],
    gaps: ['Embedded CPM only: no external scheduler is connected, and CPM results are not validated against one.'],
    rulesExecute: false,
  },
  {
    id: 'contract',
    name: 'Contract Assessment',
    responsibility: 'Identify relevant clauses and evidence; flag interpretation needing human review.',
    kind: 'ai_agent',
    status: 'missing',
    code: [],
    purpose: 'No clause retrieval, prompt or engine exists in this project.',
    inputs: [], outputs: [], modelCalls: [], tools: [],
    upstream: ['planning', 'scope'], downstream: ['reporting'],
    referenceAccess: 'none', automaticDecisions: [], humanInput: ['All contract interpretation'],
    limits: { retry: 'Not applicable', cancellation: 'Not applicable' },
    protectedControls: [],
    gaps: ['No contract document reader, clause index, or entitlement or notice logic is implemented.', 'Entitlement and notice compliance cannot be shown as established.'],
    rulesExecute: false,
  },
  {
    id: 'explain',
    name: 'Explanation & Ranking (with precedents)',
    responsibility: 'Explain why each mapped item belongs to the change, citing approved historical precedents where relevant.',
    kind: 'ai_agent',
    status: 'implemented',
    code: ['src/app/api/agents/explain/route.ts', 'src/lib/mapping/schemas.ts', 'src/lib/reference/retrieve.ts'],
    purpose: 'Writes one or two plain sentences per item from supplied facts. It may use approved reference precedents as non-authoritative context and must cite them.',
    inputs: ['Items with computed facts', 'Up to 1,500 characters of PVR text', 'Up to 2,500 characters of precedent block'],
    outputs: ['Rationale text per item', 'Precedent citations'],
    modelCalls: [{ route: '/api/agents/explain', maxCompletionTokens: 1500, modelEnv: 'OPENAI_MODEL', note: 'JSON response; falls back to rule-based reasons when unavailable' }],
    tools: [T.openai],
    upstream: ['boq_mapping', 'planning'],
    downstream: ['reporting'],
    referenceAccess: 'approved_precedents',
    automaticDecisions: ['Write rationale text', 'Fall back to rule-based reasons'],
    humanInput: ['None required; text is explanatory only'],
    limits: { maxItems: '20 items per call', retry: 'Falls back on failure; caller may retry', cancellation: 'Not cancellable once sent' },
    protectedControls: ['Model never calculates or changes quantities', 'Rationale ids validated against input ids', 'Precedent values never replace current-project values'],
    gaps: ['The case-workspace UI does not yet pass the precedents field.'],
    rulesExecute: true,
  },
  {
    id: 'verification',
    name: 'Verification / Quality Review',
    responsibility: 'Check specialist outputs against reviewed expectations.',
    kind: 'deterministic',
    status: 'partial',
    code: ['src/lib/reference/evaluate.ts', 'src/lib/reference/lifecycle.ts'],
    purpose: 'Compares pipeline output you supply with reviewed expected outputs per stage and keeps discrepancies. It is an evaluation harness, not an automatic reviewer of live runs.',
    inputs: ['Reference cases (evaluation set)', 'Pipeline output JSON'],
    outputs: ['Per-stage comparison and discrepancies'],
    modelCalls: [],
    tools: [T.db],
    upstream: [], downstream: [],
    referenceAccess: 'none',
    automaticDecisions: ['Score only supplied output'],
    humanInput: ['Reviewing discrepancies'],
    limits: { retry: 'Pure comparison; safe to repeat', cancellation: 'Not applicable' },
    protectedControls: ['Leakage check between learning and evaluation sets', 'No score without executed comparison'],
    gaps: ['No automatic quality review runs against live PVRs.', 'The evaluation does not execute the processing pipeline itself.'],
    rulesExecute: false,
  },
  {
    id: 'reporting',
    name: 'Reporting',
    responsibility: 'Consolidated assessment report and exports.',
    kind: 'deterministic',
    status: 'partial',
    code: ['src/app/case-story/components/CaseStoryShell.tsx', 'src/app/case-workspace/components/ResultsPanel.tsx'],
    purpose: 'On-screen presentation of results. There is no report-generation service or export.',
    inputs: ['Case results'], outputs: ['On-screen case story and results'], modelCalls: [], tools: [T.none],
    upstream: ['cost', 'planning', 'explain'], downstream: [],
    referenceAccess: 'none', automaticDecisions: [], humanInput: ['Review before issue'],
    limits: { retry: 'Not applicable', cancellation: 'Not applicable' },
    protectedControls: [],
    gaps: ['No downloadable report, no report agent, and no versioned report record.'],
    rulesExecute: false,
  },
  {
    id: 'notifications',
    name: 'Notifications & Workflow',
    responsibility: 'Route outcome notifications and start the configured PVR/VO workflow at defined lifecycle events.',
    kind: 'workflow_service',
    status: 'partial',
    code: ['src/lib/admin/notifications.ts', 'src/app/api/admin/notifications/route.ts'],
    purpose: 'Configurable rules with preview and test modes, recipient resolution, duplicate prevention and a delivery log. No delivery provider is connected, so live delivery is blocked.',
    inputs: ['Lifecycle event', 'Notification rule'],
    outputs: ['Delivery records (preview, test, blocked)'],
    modelCalls: [], tools: [T.db],
    upstream: ['master'], downstream: [],
    referenceAccess: 'none',
    automaticDecisions: ['Create a workflow approval request at PVR submission', 'Record test notifications'],
    humanInput: ['Every approval and signature; a PVR submission never approves or certifies a VO'],
    limits: { retry: 'Deliveries use an idempotency key so a retry never duplicates', cancellation: 'Not applicable' },
    protectedControls: ['Live delivery requires explicit enablement and a connected provider', 'Approval and signature decisions are not automated'],
    gaps: ['No email, chat or webhook provider is installed or configured.', 'No project/team membership table exists, so recipients cannot be resolved and are reported unresolved.', 'No e-signature provider is integrated.', 'Lifecycle events are not yet emitted by the PVR submission screens.'],
    rulesExecute: false,
  },
];

export const agentById = (id: string): AgentDef | undefined => AGENTS.find((a) => a.id === id);

export const STATUS_LABELS: Record<ImplStatus, string> = { implemented: 'Implemented', partial: 'Partially implemented', planned: 'Planned', missing: 'Missing' };
export const KIND_LABELS: Record<AgentKind, string> = { ai_agent: 'AI agent', deterministic: 'Deterministic tool', workflow_service: 'Workflow service', hybrid: 'AI agent + deterministic validator' };

// Backend integration: replace with Case blackboard reads (EligibilityFinding, DrawingChange, ImpactedLine, ScheduleRun, BufferPosition).

export interface Chapter {
  id: string;
  number: number;
  label: string;
  headline: string;
}

export const chapters: Chapter[] = [
  { id: 'chapter-request', number: 1, label: 'The request', headline: 'Fahid Island is asking for access road R4 to grow from 5.0 km to 7.0 km.' },
  { id: 'chapter-contract', number: 2, label: 'What the contract says', headline: 'The extension is eligible as a variation under Clause 13.2, and notice was served in time.' },
  { id: 'chapter-drawings', number: 3, label: 'What changed on the drawings', headline: 'Rev C extends the R4 centreline by 2,000 m and adds 14,000 m² of pavement.' },
  { id: 'chapter-boq', number: 4, label: 'What it touches in the BoQ', headline: '14 BoQ lines are affected: 11 additions, 2 omissions and 1 abortive item.' },
  { id: 'chapter-cost', number: 5, label: 'What it costs', headline: 'The net cost impact is AED 3.26M, of which AED 0.41M is priced from first principles.' },
  { id: 'chapter-programme', number: 6, label: 'What it does to the programme', headline: 'Handover moves 41 days because the added work sits on the critical path.' },
  { id: 'chapter-buffer', number: 7, label: 'What Aldar can absorb', headline: 'Contingency absorbs the cost, but the programme buffer is exceeded by 11 days.' },
  { id: 'chapter-decision', number: 8, label: 'Your decision', headline: 'Three options are open. One holds the date for AED 0.74M more.' },
];

export interface PvrField {
  id: string;
  label: string;
  value: string;
  confidence: number;
  source: string;
}

export const pvrFields: PvrField[] = [
  { id: 'field-project', label: 'Project', value: 'Fahid Island Roads Package', confidence: 99, source: 'PVR-0418.pdf · p1' },
  { id: 'field-zone', label: 'Zone', value: 'Zone C – East Spine', confidence: 94, source: 'PVR-0418.pdf · p1' },
  { id: 'field-discipline', label: 'Discipline', value: 'Civil – Roads', confidence: 97, source: 'Drawing R4-CIV-101 title block' },
  { id: 'field-change', label: 'Change', value: 'Extend R4 from 5.0 km to 7.0 km', confidence: 92, source: 'PVR-0418.pdf · p2' },
  { id: 'field-requester', label: 'Requested by', value: 'Faisal Al Mansoori', confidence: 99, source: 'PVR-0418.pdf · p3' },
  { id: 'field-date', label: 'Event date', value: '20 Oct 2026', confidence: 88, source: 'Email 2026-10-20.eml' },
];

export interface ClauseCard {
  id: string;
  clause: string;
  title: string;
  excerpt: string;
  page: string;
}

export const clauses: ClauseCard[] = [
  { id: 'clause-13-2', clause: 'Clause 13.2', title: 'Variations initiated by the Employer', excerpt: 'The Employer may instruct a change to the Works, including additions, omissions and substitutions.', page: 'Contract p.74' },
  { id: 'clause-20-1', clause: 'Clause 20.1', title: 'Notice of claims', excerpt: 'Notice shall be given within 28 days of the Contractor becoming aware of the event.', page: 'Contract p.112' },
  { id: 'clause-13-4', clause: 'Clause 13.4', title: 'Valuation of variations', excerpt: 'Valued at contract rates, then pro-rata rates, then fair rates derived from the Bill of Quantities.', page: 'Contract p.77' },
];

export interface BoqLine {
  id: string;
  code: string;
  description: string;
  unit: string;
  qty: number;
  rate: number;
  kind: 'Addition' | 'Omission' | 'Abortive';
  source: string;
  confidence: number;
}

export const boqLines: BoqLine[] = [
  { id: 'boq-line-001', code: '2.1.04', description: 'Bulk excavation, common material', unit: 'm³', qty: 42000, rate: 18.5, kind: 'Addition', source: 'Contract rate', confidence: 96 },
  { id: 'boq-line-002', code: '2.3.11', description: 'Fill and compaction to 95% MDD', unit: 'm³', qty: 38500, rate: 24.2, kind: 'Addition', source: 'Contract rate', confidence: 95 },
  { id: 'boq-line-003', code: '3.2.06', description: 'Granular sub-base, 250 mm', unit: 'm²', qty: 14000, rate: 41, kind: 'Addition', source: 'Contract rate', confidence: 94 },
  { id: 'boq-line-004', code: '3.4.02', description: 'Asphalt base course, 80 mm', unit: 'm²', qty: 14000, rate: 78.6, kind: 'Addition', source: 'Pro-rata', confidence: 88 },
  { id: 'boq-line-005', code: '3.4.07', description: 'Asphalt wearing course, 50 mm', unit: 'm²', qty: 14000, rate: 62.3, kind: 'Addition', source: 'Pro-rata', confidence: 87 },
  { id: 'boq-line-006', code: '5.1.03', description: 'Precast kerb, 150×300', unit: 'm', qty: 4000, rate: 96.8, kind: 'Addition', source: 'Contract rate', confidence: 93 },
  { id: 'boq-line-007', code: '7.2.01', description: 'Street lighting column, 10 m', unit: 'no', qty: 67, rate: 14250, kind: 'Addition', source: 'Past BoQ', confidence: 79, },
  { id: 'boq-line-008', code: 'N-001', description: 'Wildlife crossing culvert (new item)', unit: 'no', qty: 1, rate: 410000, kind: 'Addition', source: 'First principles', confidence: 61 },
  { id: 'boq-line-009', code: '9.1.02', description: 'Temporary end barrier at CH 5+000', unit: 'm', qty: -60, rate: 320, kind: 'Omission', source: 'Contract rate', confidence: 91 },
  { id: 'boq-line-010', code: '9.4.05', description: 'Planted verge, Phase 2 edge', unit: 'm²', qty: -800, rate: 55, kind: 'Omission', source: 'Contract rate', confidence: 90 },
  { id: 'boq-line-011', code: '3.9.01', description: 'Surveyed set-out, abortive (superseded Rev B)', unit: 'sum', qty: 1, rate: 38000, kind: 'Abortive', source: 'Dayworks', confidence: 72 },
];

export const cutoverPoint = { value: 50 };

export interface GanttRow {
  id: string;
  activity: string;
  code: string;
  oldStart: number;
  oldLen: number;
  newStart: number;
  newLen: number;
  critical: boolean;
  floatDays: number;
}

export const ganttRows: GanttRow[] = [
  { id: 'gantt-a1000', activity: 'R4 earthworks CH 0–5 km', code: 'A1000', oldStart: 0, oldLen: 28, newStart: 0, newLen: 28, critical: false, floatDays: 9 },
  { id: 'gantt-a1010', activity: 'R4 drainage and culverts', code: 'A1010', oldStart: 14, oldLen: 24, newStart: 14, newLen: 24, critical: false, floatDays: 6 },
  { id: 'gantt-a1020', activity: 'R4 earthworks CH 5–7 km (new)', code: 'A1020N', oldStart: 28, oldLen: 0, newStart: 28, newLen: 22, critical: true, floatDays: 0 },
  { id: 'gantt-a1030', activity: 'R4 sub-base and base course', code: 'A1030', oldStart: 38, oldLen: 20, newStart: 50, newLen: 29, critical: true, floatDays: 0 },
  { id: 'gantt-a1040', activity: 'R4 kerbs and lighting', code: 'A1040', oldStart: 52, oldLen: 16, newStart: 68, newLen: 22, critical: true, floatDays: 0 },
  { id: 'gantt-a1050', activity: 'R4 wearing course and marking', code: 'A1050', oldStart: 64, oldLen: 12, newStart: 86, newLen: 16, critical: true, floatDays: 0 },
  { id: 'gantt-a1060', activity: 'Handover inspection', code: 'M9000', oldStart: 76, oldLen: 6, newStart: 102, newLen: 6, critical: true, floatDays: 0 },
];

export const waterfall = [
  { id: 'wf-additions', name: 'Additions', base: 0, value: 3.86, kind: 'add' },
  { id: 'wf-abortive', name: 'Abortive', base: 3.86, value: 0.04, kind: 'add' },
  { id: 'wf-omissions', name: 'Omissions', base: 3.86 - 0.64, value: 0.64, kind: 'omit' },
  { id: 'wf-net', name: 'Net impact', base: 0, value: 3.26, kind: 'net' },
];

export const agentEvents = [
  { id: 'event-001', time: '07:12:04', agent: 'Orchestrator', type: 'plan', text: 'Planned case PVR-0418: intake, contract, drawings, then cost and schedule in parallel.' },
  { id: 'event-002', time: '07:12:19', agent: 'Intake', type: 'finding', text: 'Classified 6 files. Change type: scope increase. Confidence 92%.' },
  { id: 'event-003', time: '07:13:02', agent: 'Contract', type: 'finding', text: 'Eligible under Clause 13.2. Notice served on day 9 of 28.' },
  { id: 'event-004', time: '07:14:40', agent: 'Drawing', type: 'tool_call', text: 'Compared R4-CIV-101 Rev B → Rev C. Centreline +2,000.0 m.' },
  { id: 'event-005', time: '07:15:11', agent: 'Schedule', type: 'challenge', text: 'Challenged Drawing: pavement area 14,000 m² implies 7.0 m carriageway, but typical section shows 7.0 m + 2×1.5 m shoulders.' },
  { id: 'event-006', time: '07:15:36', agent: 'Drawing', type: 'handover', text: 'Accepted. Shoulders are included in the 14,000 m² and in the wearing course measure.' },
  { id: 'event-007', time: '07:17:48', agent: 'Cost', type: 'escalation', text: 'Item N-001 (wildlife culvert) has no contract rate. Priced from first principles at confidence 61%. Human review requested.' },
  { id: 'event-008', time: '07:19:22', agent: 'Schedule', type: 'finding', text: 'CPM re-run complete. Handover moves from 08 Mar 2027 to 18 Apr 2027 (+41 days).' },
];
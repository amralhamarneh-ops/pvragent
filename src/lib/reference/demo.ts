import type { LearningRecord, ReferenceCase, ReferenceSource, SourceRole } from './types';
import { missingEvidence } from './lifecycle';

/**
 * DEMONSTRATION DATA. These records are illustrative, not real project history. They exist so the retrieval,
 * citation and rejection behaviour can be shown. They are labelled as demonstration cases in the UI.
 */

const T = '2026-01-15T09:00:00.000Z';
const h = (n: string) => n.padEnd(64, '0').slice(0, 64);

function src(id: string, role: SourceRole, fileName: string, sha: string, detail = 'Read in full.'): ReferenceSource {
  return { id, role, fileName, sha256: h(sha), sizeBytes: 20480, stored: true, storagePath: null, readStatus: 'read', readDetail: detail, textExcerpt: '', uploadedAt: T };
}

const blankRecord = (): LearningRecord => ({
  changeType: '', workType: '', location: '', specifications: [], projectContext: '', quantities: [], boqMappings: [], activityMappings: [],
  productivity: { assumption: '', resources: '', calendar: '', durationBasis: '' },
  schedule: { simulatedDelayDays: null, simulationSettings: '', milestoneImpact: '', completionImpact: '', observedActualDelayDays: null, observedNote: '' },
  outcome: { claimed: null, assessed: null, approved: null, actual: null, currency: 'AED', settlementNote: '', technicallyVerified: false },
  corrections: [], reasoning: '', assumptions: [], geometryRefs: [],
});

export function emptyRecord(): LearningRecord { return blankRecord(); }

export const DEMO_CASES: ReferenceCase[] = [
  {
    id: 'ref-demo-slab-001', caseGroup: 'demo-slab-thickening', version: 1, title: 'Demo: Podium slab thickened 200 to 250 mm (concrete, m3)',
    status: 'approved', partition: 'learning', replacedBy: null, usedInFineTuning: false, createdAt: T, updatedAt: T, missingEvidence: [],
    sources: [
      src('s1', 'pvr_narrative', 'PVR-014-narrative.docx', 'a1'), src('s2', 'drawing_original', 'S-101-revA.dxf', 'a2'), src('s3', 'drawing_revised', 'S-101-revB.dxf', 'a3'),
      src('s4', 'boq', 'BOQ-structure-bill3.xlsx', 'a4'), src('s5', 'schedule_pre', 'baseline.xer', 'a5'), src('s6', 'schedule_post', 'simulated.xer', 'a6'),
      src('s7', 'outcome', 'reviewed-outcome.pdf', 'a7'),
    ],
    reviewHistory: [
      { at: T, action: 'created', reviewer: 'Reviewer A', version: 1, note: 'Package uploaded.', evidence: [] },
      { at: T, action: 'approved', reviewer: 'Reviewer A', version: 1, note: 'Quantities re-measured against the revised drawing; mapping and simulation re-run.', evidence: ['s3 revised drawing', 's7 reviewed outcome'] },
    ],
    record: {
      ...blankRecord(), changeType: 'thickness increase', workType: 'in-situ concrete slab', location: 'Podium level 1', specifications: ['C40', '250mm'],
      projectContext: 'residential tower podium structure',
      quantities: [{ item: 'Podium slab concrete', unit: 'm3', original: 480, revised: 600, basis: 'Area 2400 m2 x thickness, from revised drawing S-101 revB' }],
      boqMappings: [{ item: 'Podium slab concrete', boqRef: '3.2.1', unit: 'm3', rateBasis: 'contract BOQ unit rate for C40 slab', rate: 612 }],
      activityMappings: [{ activityId: 'A1240', name: 'Pour podium slab L1', rationale: 'Activity places the slab concrete; duration scales with volume.' }],
      productivity: { assumption: '60 m3 per pour day', resources: 'two pump crews', calendar: '6-day week', durationBasis: 'volume divided by daily pour rate' },
      schedule: { simulatedDelayDays: 4, simulationSettings: '6-day week calendar, retained logic', milestoneImpact: 'Podium complete +4 days', completionImpact: 'No completion impact (float absorbed)', observedActualDelayDays: 3, observedNote: 'Observed on site after the works; separate from the simulated figure.' },
      outcome: { claimed: 98000, assessed: 73440, approved: 75000, actual: 74200, currency: 'AED', settlementNote: 'Settled commercially at 75,000. The settlement does not by itself prove the technical calculation; the quantity and rate were re-checked by the reviewer.', technicallyVerified: true },
      corrections: [{ field: 'Revised quantity', was: '560 m3', shouldBe: '600 m3', why: 'First pass missed the thickened drop-panel zone on the revised drawing.' }],
      reasoning: 'Revised quantity is the volume difference between thicknesses over the same plan area, mapped to the existing slab concrete BOQ item and the slab pour activity.',
      assumptions: ['Formwork area unchanged', 'No change to reinforcement ratio'],
      geometryRefs: [{ sourceId: 's3', locator: 'Layer S-SLAB, zone P1' }],
    },
  },
  {
    id: 'ref-demo-pipe-001', caseGroup: 'demo-pipe-reroute', version: 1, title: 'Demo: Chilled-water pipe re-route DN200 (linear metres)',
    status: 'approved', partition: 'learning', replacedBy: null, usedInFineTuning: false, createdAt: T, updatedAt: T, missingEvidence: [],
    sources: [src('p1', 'pvr_narrative', 'PVR-027-narrative.docx', 'b1'), src('p2', 'drawing_revised', 'M-210-revC.dxf', 'b2'), src('p3', 'boq', 'BOQ-mechanical.xlsx', 'b3'), src('p4', 'outcome', 'reviewed-outcome.pdf', 'b4')],
    reviewHistory: [{ at: T, action: 'approved', reviewer: 'Reviewer B', version: 1, note: 'Length re-measured from the revised route.', evidence: ['p2 revised drawing'] }],
    record: {
      ...blankRecord(), changeType: 'route change', workType: 'chilled water pipework', location: 'Plant room level B1', specifications: ['DN200', 'insulated'],
      projectContext: 'commercial office mechanical services',
      quantities: [{ item: 'DN200 CHW pipe', unit: 'm', original: 140, revised: 188, basis: 'Centreline length of revised route' }],
      boqMappings: [{ item: 'DN200 CHW pipe', boqRef: '7.4.2', unit: 'm', rateBasis: 'contract BOQ rate per metre, supply and install', rate: 410 }],
      activityMappings: [{ activityId: 'M3300', name: 'Install CHW mains B1', rationale: 'Length-driven installation activity.' }],
      productivity: { assumption: '12 m per gang-day', resources: 'two pipefitter gangs', calendar: '5-day week', durationBasis: 'length divided by daily rate' },
      schedule: { ...blankRecord().schedule, simulatedDelayDays: 2, simulationSettings: '5-day week calendar' },
      outcome: { ...blankRecord().outcome, claimed: 30000, assessed: 19680, approved: 19680, actual: null, technicallyVerified: true },
      reasoning: 'Length difference mapped to the DN200 per-metre BOQ rate.',
    },
  },
  {
    id: 'ref-demo-draft-001', caseGroup: 'demo-draft-partition', version: 1, title: 'Demo: Partition wall relocation (draft, not yet reviewed)',
    status: 'draft', partition: 'learning', replacedBy: null, usedInFineTuning: false, createdAt: T, updatedAt: T,
    sources: [src('d1', 'pvr_narrative', 'PVR-031-narrative.docx', 'c1')], missingEvidence: [], reviewHistory: [{ at: T, action: 'created', reviewer: 'Reviewer C', version: 1, note: 'Uploaded; incomplete.', evidence: [] }],
    record: { ...blankRecord(), changeType: 'relocation', workType: 'blockwork partition wall', specifications: ['150mm'], projectContext: 'residential tower fit-out', quantities: [{ item: 'Partition', unit: 'm2', original: 60, revised: 75, basis: 'unreviewed' }] },
  },
  {
    id: 'ref-demo-eval-001', caseGroup: 'demo-eval-slab', version: 1, title: 'Demo evaluation case: Basement slab thickening (reserved for evaluation)',
    status: 'approved', partition: 'evaluation', replacedBy: null, usedInFineTuning: false, createdAt: T, updatedAt: T, missingEvidence: [],
    sources: [src('e1', 'pvr_narrative', 'PVR-044-narrative.docx', 'e1'), src('e2', 'drawing_revised', 'S-050-revB.dxf', 'e2'), src('e3', 'boq', 'BOQ-substructure.xlsx', 'e3')],
    reviewHistory: [{ at: T, action: 'approved', reviewer: 'Reviewer A', version: 1, note: 'Expected outputs reviewed.', evidence: ['e2 revised drawing'] }],
    record: {
      ...blankRecord(), changeType: 'thickness increase', workType: 'in-situ concrete slab', specifications: ['C35', '300mm'], projectContext: 'basement structure',
      quantities: [{ item: 'Basement slab concrete', unit: 'm3', original: 300, revised: 360, basis: 'Revised drawing area x thickness' }],
      boqMappings: [{ item: 'Basement slab concrete', boqRef: '2.1.4', unit: 'm3', rateBasis: 'contract BOQ rate', rate: 580 }],
      activityMappings: [{ activityId: 'B0210', name: 'Pour basement slab', rationale: 'Volume-driven pour activity.' }],
      schedule: { ...blankRecord().schedule, simulatedDelayDays: 3 },
    },
  },
];

/** A new assessment that the approved slab case suits. */
export const DEMO_QUERY_SUITABLE = {
  changeType: 'thickness increase', workType: 'in-situ concrete slab', specification: 'C40 slab 250mm', unit: 'm3',
  projectContext: 'residential tower podium structure', scheduleConditions: '6-day week calendar, retained logic',
};

/** A new assessment for which the approved slab and pipe precedents are both unsuitable (pipework in metres). */
export const DEMO_QUERY_UNSUITABLE = {
  changeType: 'route change', workType: 'electrical cable containment', specification: 'DN100 tray', unit: 'm',
  projectContext: 'hospital electrical services', scheduleConditions: '7-day week night shifts',
};

/** Fresh case shell for an upload. Gaps are computed, never hidden. */
export function newDraft(id: string, title: string, caseGroup: string, now: string, reviewer: string): ReferenceCase {
  return {
    id, caseGroup, version: 1, title, status: 'draft', partition: 'learning', record: blankRecord(), sources: [], missingEvidence: missingEvidence([]),
    reviewHistory: [{ at: now, action: 'created', reviewer, version: 1, note: 'Case created.', evidence: [] }], replacedBy: null, usedInFineTuning: false, createdAt: now, updatedAt: now,
  };
}

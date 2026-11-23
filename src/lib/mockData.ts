// Backend integration: replace these static fixtures with reads from the PVRAgent API / Unifier adapter.

export type CaseStatus =
  | 'Intake' |'Contract Review' |'Impact Assessment' |'Awaiting Review' |'Approved' |'VO Issued' |'Rejected' |'Declined – Outside Scope';

export interface ProjectRow {
  id: string;
  name: string;
  zone: string;
  contractValue: number;
  pendingExposure: number;
  approvedExposure: number;
  contingencyTotal: number;
  contingencyUsedPct: number;
  openCases: number;
  oldestCaseDays: number;
}

export interface PvrCase {
  id: string;
  ref: string;
  title: string;
  changeType: string;
  zone: string;
  discipline: string;
  status: CaseStatus;
  netCost: number;
  eotDays: number;
  confidence: number;
  ageDays: number;
  requester: string;
}

export const projects: ProjectRow[] = [
  { id: 'project-yas-001', name: 'Yas Acres Phase 3', zone: 'Yas Island', contractValue: 412000000, pendingExposure: 5120000, approvedExposure: 8840000, contingencyTotal: 20600000, contingencyUsedPct: 68, openCases: 9, oldestCaseDays: 23 },
  { id: 'project-sad-002', name: 'Saadiyat Lagoons Infra', zone: 'Saadiyat Island', contractValue: 286500000, pendingExposure: 4310000, approvedExposure: 6120000, contingencyTotal: 14300000, contingencyUsedPct: 73, openCases: 7, oldestCaseDays: 31 },
  { id: 'project-fid-003', name: 'Fahid Island Roads Package', zone: 'Fahid Island', contractValue: 198400000, pendingExposure: 3640000, approvedExposure: 2210000, contingencyTotal: 9900000, contingencyUsedPct: 59, openCases: 5, oldestCaseDays: 12 },
  { id: 'project-ala-004', name: 'Al Reem Mixed-Use Tower B', zone: 'Al Reem Island', contractValue: 521000000, pendingExposure: 2480000, approvedExposure: 11700000, contingencyTotal: 26000000, contingencyUsedPct: 54, openCases: 4, oldestCaseDays: 8 },
  { id: 'project-raha-005', name: 'Raha Beach Promenade', zone: 'Al Raha', contractValue: 94200000, pendingExposure: 1960000, approvedExposure: 3380000, contingencyTotal: 4700000, contingencyUsedPct: 91, openCases: 3, oldestCaseDays: 41 },
  { id: 'project-mam-006', name: 'Mamsha Al Saadiyat Podium', zone: 'Saadiyat Island', contractValue: 143800000, pendingExposure: 910000, approvedExposure: 1540000, contingencyTotal: 7200000, contingencyUsedPct: 34, openCases: 2, oldestCaseDays: 6 },
];

export const cases: PvrCase[] = [
  { id: 'case-pvr-0418', ref: 'PVR-0418', title: 'Extend access road R4 from 5.0 km to 7.0 km', changeType: 'Scope increase', zone: 'Zone C – East Spine', discipline: 'Civil – Roads', status: 'Awaiting Review', netCost: 3260000, eotDays: 41, confidence: 86, ageDays: 6, requester: 'Faisal Al Mansoori' },
  { id: 'case-pvr-0417', ref: 'PVR-0417', title: 'Replace RC boundary wall with timber screen, Plot 14', changeType: 'Material replacement', zone: 'Zone B – Cluster 14', discipline: 'Architecture', status: 'Impact Assessment', netCost: -184500, eotDays: 0, confidence: 91, ageDays: 3, requester: 'Meera Nair' },
  { id: 'case-pvr-0416', ref: 'PVR-0416', title: 'Additional piling at Block C transfer slab', changeType: 'Site condition', zone: 'Zone A – Block C', discipline: 'Structure', status: 'Awaiting Review', netCost: 1427000, eotDays: 18, confidence: 72, ageDays: 14, requester: 'Hamdan Al Ketbi' },
  { id: 'case-pvr-0415', ref: 'PVR-0415', title: 'Omit landscaped median, Corniche Link', changeType: 'Scope decrease', zone: 'Zone D – Corniche', discipline: 'Landscape', status: 'Approved', netCost: -642000, eotDays: -6, confidence: 94, ageDays: 19, requester: 'Priya Venkatesan' },
  { id: 'case-pvr-0414', ref: 'PVR-0414', title: 'Upgrade chilled-water pipe spec to pre-insulated DI', changeType: 'Specification change', zone: 'Zone A – Plant Room 2', discipline: 'MEP – HVAC', status: 'Contract Review', netCost: 912400, eotDays: 9, confidence: 64, ageDays: 2, requester: 'Tariq Haddad' },
  { id: 'case-pvr-0413', ref: 'PVR-0413', title: 'Rock excavation encountered at CH 2+340', changeType: 'Site condition', zone: 'Zone C – East Spine', discipline: 'Civil – Earthworks', status: 'Awaiting Review', netCost: 2184300, eotDays: 27, confidence: 69, ageDays: 23, requester: 'Faisal Al Mansoori' },
  { id: 'case-pvr-0412', ref: 'PVR-0412', title: 'Supervision consultancy extension, 3 months', changeType: 'Supervision consultancy', zone: 'All zones', discipline: 'Management', status: 'VO Issued', netCost: 478000, eotDays: 0, confidence: 97, ageDays: 34, requester: 'Layla Al Zaabi' },
  { id: 'case-pvr-0411', ref: 'PVR-0411', title: 'Relocate substation S3 by 18 m', changeType: 'Scope increase', zone: 'Zone B – Utilities', discipline: 'MEP – Electrical', status: 'Declined – Outside Scope', netCost: 0, eotDays: 0, confidence: 88, ageDays: 28, requester: 'Hamdan Al Ketbi' },
  { id: 'case-pvr-0410', ref: 'PVR-0410', title: 'Provisional sum drawdown – external lighting', changeType: 'Provisional sum', zone: 'Zone D – Corniche', discipline: 'MEP – Electrical', status: 'Intake', netCost: 356000, eotDays: 0, confidence: 58, ageDays: 1, requester: 'Meera Nair' },
  { id: 'case-pvr-0409', ref: 'PVR-0409', title: 'Change paving from granite to porcelain, podium level', changeType: 'Material replacement', zone: 'Zone A – Podium', discipline: 'Architecture', status: 'Rejected', netCost: -91200, eotDays: 0, confidence: 83, ageDays: 41, requester: 'Priya Venkatesan' },
  { id: 'case-pvr-0408', ref: 'PVR-0408', title: 'Additional fire-rated shaft enclosure, Level 4–9', changeType: 'Scope increase', zone: 'Zone A – Block C', discipline: 'Architecture', status: 'Impact Assessment', netCost: 603700, eotDays: 11, confidence: 77, ageDays: 5, requester: 'Tariq Haddad' },
  { id: 'case-pvr-0407', ref: 'PVR-0407', title: 'Deepen stormwater attenuation tank by 1.2 m', changeType: 'Site condition', zone: 'Zone C – East Spine', discipline: 'Civil – Drainage', status: 'Approved', netCost: 1190000, eotDays: 14, confidence: 90, ageDays: 22, requester: 'Faisal Al Mansoori' },
];

export const statusOptions: CaseStatus[] = [
  'Intake',
  'Contract Review',
  'Impact Assessment',
  'Awaiting Review',
  'Approved',
  'VO Issued',
  'Rejected',
  'Declined – Outside Scope',
];

export const exposureByProject = [
  { name: 'Yas Acres P3', pending: 5.12, approved: 8.84 },
  { name: 'Saadiyat Lagoons', pending: 4.31, approved: 6.12 },
  { name: 'Fahid Roads', pending: 3.64, approved: 2.21 },
  { name: 'Reem Tower B', pending: 2.48, approved: 11.7 },
  { name: 'Raha Promenade', pending: 1.96, approved: 3.38 },
  { name: 'Mamsha Podium', pending: 0.91, approved: 1.54 },
];

export const rootCauses = [
  { name: 'Design change', value: 7.3 },
  { name: 'Site condition', value: 5.6 },
  { name: 'Client instruction', value: 3.1 },
  { name: 'Spec upgrade', value: 1.8 },
  { name: 'Statutory', value: 0.6 },
];

export const cycleTimeByWeek = [
  { week: 'W36', days: 14.2 },
  { week: 'W37', days: 12.8 },
  { week: 'W38', days: 15.6 },
  { week: 'W39', days: 11.4 },
  { week: 'W40', days: 9.7 },
  { week: 'W41', days: 13.9 },
  { week: 'W42', days: 18.3 },
  { week: 'W43', days: 16.1 },
];

export function formatAED(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  if (abs >= 1000000) return `${sign}AED ${(abs / 1000000).toFixed(2)}M`;
  if (abs >= 1000) return `${sign}AED ${Math.round(abs / 1000).toLocaleString('en-US')}K`;
  return `${sign}AED ${abs.toLocaleString('en-US')}`;
}

export function formatAEDFull(value: number): string {
  const sign = value < 0 ? '−' : '';
  return `${sign}AED ${Math.abs(value).toLocaleString('en-US')}`;
}
export type FileRole = 'pvr' | 'correspondence' | 'drawings' | 'boq' | 'schedule' | 'contract' | 'site' | 'reference' | 'unused';

export const ROLE_LABEL: Record<FileRole, string> = {
  pvr: 'Change request',
  correspondence: 'Correspondence',
  drawings: 'Drawings',
  boq: 'BoQ set',
  schedule: 'Schedule',
  contract: 'Contract',
  site: 'Site reports and other evidence',
  reference: 'Project reference library',
  unused: 'Unused',
};

export const ROLE_ORDER: FileRole[] = ['pvr', 'correspondence', 'drawings', 'boq', 'schedule', 'contract', 'site', 'reference', 'unused'];

export interface IncomingFile {
  path: string;
  size: number;
  /** first 400 characters of text content when available, treated as untrusted data */
  snippet?: string;
  hash?: string;
}

export interface ClassifiedFile extends IncomingFile {
  name: string;
  role: FileRole;
  reason: string;
  detail?: string;
}

export interface PvrFound {
  ref: string;
  title: string;
  path: string;
}

export interface TriageQuestion {
  id: string;
  text: string;
  options: { value: string; label: string; hint: string }[];
}

export interface TriageResult {
  files: ClassifiedFile[];
  pvrs: PvrFound[];
  projectMatch: { name: string; id: string; contractRef: string; evidence: string; level: 'High match' | 'Possible match' | 'No match' };
  questions: TriageQuestion[];
  drawingRevisions: string[];
  billsRelevant: number[];
}

const baseName = (p: string) => p.split('/').slice(-1)[0];

export function classifyOne(f: IncomingFile): ClassifiedFile {
  const name = baseName(f.path);
  const lower = name.toLowerCase();
  const path = f.path.toLowerCase();
  const mk = (role: FileRole, reason: string, detail?: string): ClassifiedFile => ({ ...f, name, role, reason, detail });
  if (lower.startsWith('~$') || lower.endsWith('.tmp') || lower === 'thumbs.db' || lower === '.ds_store') return mk('unused', 'Temporary file created by Excel or the system');
  if (/\.xer$/.test(lower)) return mk('schedule', 'Primavera P6 schedule export');
  if (/\.(dxf|dwg)$/.test(lower)) return mk('drawings', lower.endsWith('.dwg') ? 'DWG drawing (needs a converter or a DXF copy)' : 'DXF drawing');
  if (/(pvr|change[-_ ]?request|variation[-_ ]?request)/.test(lower) && /\.(pdf|docx?|txt)$/.test(lower)) return mk('pvr', 'Named as a change request');
  if (/(boq|bill)[-_ ]?\d*/.test(lower) && /\.(xlsx|xls|xlsm|csv)$/.test(lower)) return mk('boq', 'Bill of quantities workbook');
  if (/contract|agreement|conditions/.test(lower)) return mk('contract', 'Contract document');
  if (/(email|letter|instruction|correspondence|rfi|transmittal)/.test(lower) || /\.(eml|msg)$/.test(lower)) return mk('correspondence', 'Letter, email or instruction');
  if (/(site|daily|progress|inspection|photo)/.test(lower) || /\.(jpe?g|png)$/.test(lower)) return mk('site', 'Site report or photo');
  if (/(masterplan|brochure|general|policy|handbook|standard)/.test(lower) || /reference|library/.test(path)) return mk('reference', 'About the project in general, not this change');
  if (/\.(pdf|docx?)$/.test(lower) && f.snippet && /(extend|change|variation|omit|revise)/i.test(f.snippet)) return mk('pvr', 'Text describes a change');
  if (/\.(xlsx|xls)$/.test(lower)) return mk('reference', 'Spreadsheet not recognised as a BoQ bill');
  return mk('unused', 'Not relevant to a change assessment');
}

function pvrRef(name: string): string | null {
  const m = name.match(/pvr[-_ ]?(\d{3,4})/i);
  return m ? `PVR-${m[1].padStart(4, '0')}` : null;
}

function revOf(name: string): string | null {
  const m = name.match(/rev[-_ ]?([a-z0-9]+)/i);
  return m ? m[1].toUpperCase() : null;
}

export function classifyFiles(files: IncomingFile[]): TriageResult {
  const classified = files.map(classifyOne);
  const pvrs: PvrFound[] = classified
    .filter((f) => f.role === 'pvr')
    .map((f, i) => ({ ref: pvrRef(f.name) ?? `PVR-NEW-${i + 1}`, title: f.snippet?.split('\n')[0]?.slice(0, 90) || f.name.replace(/\.[^.]+$/, ''), path: f.path }));
  const drawingRevs = classified
    .filter((f) => f.role === 'drawings')
    .map((f) => revOf(f.name))
    .filter((r): r is string => !!r)
    .sort();
  const xers = classified.filter((f) => f.role === 'schedule');
  const questions: TriageQuestion[] = [];
  if (xers.length > 1) {
    questions.push({
      id: 'baseline',
      text: 'Which file is the baseline for this PVR?',
      options: xers.map((x) => ({ value: x.path, label: x.name, hint: x.detail ?? x.reason })),
    });
  }
  const boqFiles = classified.filter((f) => f.role === 'boq');
  const billNo = (n: string) => Number((n.match(/(\d{1,2})/) ?? [])[1] ?? 0);
  const billsRelevant = boqFiles.map((f) => billNo(f.name)).filter((n) => [3, 4, 5, 6, 12].includes(n));
  const hasContract = classified.some((f) => f.role === 'contract');
  // Project match is evidence-based: only the contract reference or project name found in file names/snippets counts.
  const haystack = classified.map((f) => `${f.path} ${f.snippet ?? ''}`).join('\n');
  const refHit = /FIR-CON-2025-011/i.test(haystack);
  const nameHit = /fahid\s*island/i.test(haystack);
  const level: TriageResult['projectMatch']['level'] = refHit ? 'High match' : nameHit ? 'Possible match' : 'No match';
  return {
    files: classified,
    pvrs,
    projectMatch: level === 'No match'
      ? { name: '', id: '', contractRef: '', evidence: 'No contract reference or project name was found in the file names or readable text. Choose a project or create a new one.', level }
      : {
          name: 'Fahid Island Roads Package',
          id: 'project-fid-003',
          contractRef: 'FIR-CON-2025-011',
          evidence: refHit
            ? `Contract reference FIR-CON-2025-011 found in ${hasContract ? 'the contract file name and ' : ''}the uploaded file names.`
            : 'The project name "Fahid Island" appears in the uploaded file paths. No contract reference was found to confirm it.',
          level,
        },
    questions,
    drawingRevisions: drawingRevs,
    billsRelevant,
  };
}

const BILL_TITLES = ['Preliminaries', 'Site clearance', 'Earthworks and roads', 'Drainage', 'Lighting and electrical', 'Signage and marking', 'Structures', 'Irrigation', 'Landscape softworks', 'Utilities', 'Telecoms', 'Demolition', 'Provisional sums'];

/** The synthetic 21-file Fahid Island folder used by demo mode. */
export function demoPack(): IncomingFile[] {
  const files: IncomingFile[] = [
    { path: 'FahidIsland_R4/01 Change/PVR-0418.pdf', size: 412_000, snippet: 'Extend access road R4 from 5.0 km to 7.0 km\nThe Employer requests an extension of 2,000 m.' },
    { path: 'FahidIsland_R4/02 Correspondence/Employer instruction 2026-10-20.eml', size: 28_400, snippet: 'Instruction dated 20 Oct 2026 to proceed with R4 extension assessment.' },
    { path: 'FahidIsland_R4/03 Drawings/R4-CIV-101 Rev B.dxf', size: 6_100_000 },
    { path: 'FahidIsland_R4/03 Drawings/R4-CIV-101 Rev C.dxf', size: 6_400_000 },
    ...BILL_TITLES.map((t, i) => ({ path: `FahidIsland_R4/04 BoQ/BoQ Bill ${i + 1} ${t}.xlsx`, size: 900_000 + i * 120_000 })),
    { path: 'FahidIsland_R4/05 Programme/FIR_Baseline_Oct26.xer', size: 3_900_000 },
    { path: 'FahidIsland_R4/05 Programme/K9-BL-Rev 002 - Approved.xer', size: 5_200_000 },
    { path: 'FahidIsland_R4/06 Contract/FIR-CON-2025-011 Contract Agreement.pdf', size: 8_800_000 },
    { path: 'FahidIsland_R4/04 BoQ/~$BoQ Bill 3 Earthworks and roads.xlsx', size: 165 },
  ];
  return files;
}

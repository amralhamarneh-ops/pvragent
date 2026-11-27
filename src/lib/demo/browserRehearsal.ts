import { buildImport, confirmImport, needsNoQuestion, stageUpload } from '@/lib/boq/importFlow';
import { buildBoqSet } from '@/lib/boq/matchEngine';
import { sha256Hex } from '@/lib/boq/readers';
import { retrieveCandidates, tokenize } from '@/lib/boq/retrieve';
import { analyseDocuments } from '@/lib/drawings/analyse';
import { buildSavedDrawingReplay, readSavedDrawingReplay, type SavedDrawingReplay } from '@/lib/drawings/replay';
import type { FileReadiness, ReconciledChange } from '@/lib/drawings/types';

import { isRehearsalSchedule, type RehearsalSchedule } from './scheduleRehearsal';

export type DemoFile = { name: string; bytes: Uint8Array };
type Source = { name: string; sha256: string; role: string };
type ProposedBoq = { ref: string; description: string; unit: string; file: string; sheet: string; row: number };
type Mapping = { id: string; proposal: ProposedBoq | null; reason: string };
export type BrowserRehearsal = {
  version: 1; savedAt: string; sources: Source[]; reads: FileReadiness[];
  changes: ReconciledChange[]; mappings: Mapping[]; replay: SavedDrawingReplay;
  schedule?: RehearsalSchedule;
  boqRows: number; events: { step: string; detail: string }[];
};
export const DEMO_KEY = 'pvr-browser-rehearsal-v1';
export const REHEARSAL_LIMIT = 650_000;

export async function runBrowserRehearsal(
  original: DemoFile, revised: DemoFile, boq: DemoFile, referenceName?: string,
  onStep: (stage: string) => void = () => {},
): Promise<BrowserRehearsal> {
  if (![original, revised].every(f => /\.dxf$/i.test(f.name) && f.bytes.length > 0 && f.bytes.length <= 8_000_000) ||
      !/\.csv$/i.test(boq.name) || boq.bytes.length === 0 || boq.bytes.length > 2_000_000)
    throw new Error('Use two small ASCII DXF revisions (up to 8 MB each) and a BOQ CSV (up to 2 MB).');
  if (original.name.toLowerCase() === revised.name.toLowerCase()) throw new Error('Use different file names for the original and revised DXFs, with revision labels.');
  const events: BrowserRehearsal['events'] = [];
  const step = (name: string, detail: string) => { events.push({step:name, detail}); onStep(name); };
  step('Read drawings', 'Read the original and revised DXF files in this browser. No narrative or processed PVR was passed into measurement.');
  const out = await analyseDocuments({ files:[original,revised].map(f => ({...f, role:'drawings'})), narrative:'', streamGeometry:false });
  const pair = out.pairs.filter(p => p.validated);
  if (pair.length !== 1 || pair[0].original.fileName !== original.name || pair[0].revised.fileName !== revised.name)
    throw new Error('A single validated original → revised drawing pair could not be established. Check both drawing numbers, revisions, units and alignment.');
  step('Compare revisions', `${pair[0].original.fileName} → ${pair[0].revised.fileName}; comparison passed the drawing validation checks.`);
  const changes = out.changes.filter(c => c.basis === 'measured' && !!c.entityRefs && !!c.trace &&
    !c.acceptedFrom && [c.addedQty, c.omittedQty, c.changeQty].some(q => Number.isFinite(Number(q)) && Number(q) !== 0));
  if (!changes.length) throw new Error('No non-zero drawing-based measured quantities were available to map.');
  step('Measure changes', `${changes.length} measured drawing change(s); geometry, formula and revision evidence retained.`);
  const replay = buildSavedDrawingReplay(out);
  if (!replay) throw new Error('This drawing pair is too large to save its replay. Use a small pair for rehearsal.');
  step('Read uploaded BOQ', 'Read the supplied CSV and inferred its item, description and unit columns.');
  const staged = await stageUpload(boq.name, boq.bytes);
  if (!needsNoQuestion(staged)) throw new Error('The BOQ headers or included rows were ambiguous. Use a clean CSV with Item, Description, Unit, Qty, Rate and Amount columns.');
  const {imp} = buildImport({caseId:'browser-rehearsal', staged, mappings:staged.mappings, currency:'AED', revisionLabel:'Uploaded CSV', revision:1});
  const set = buildBoqSet([confirmImport(imp)]);
  if (!set.items.length) throw new Error('No BOQ items were found in the uploaded CSV.');
  const mappings: Mapping[] = changes.map(c => {
    if (c.conflict || c.ambiguity) return {id:c.id, proposal:null, reason:'Drawing evidence needs review before mapping.'};
    const terms = [...new Set(tokenize(c.component))];
    // Strict proposals only: every work term must occur in the BOQ row itself, the unit must be
    // directly equivalent, and competing full-term items must stay unresolved. No dimension guessing.
    const candidates = retrieveCandidates(set.items,set.context,{name:c.component, discipline:'', workType:'', material:'',
      specification:'', location:'', searchTerms:[], expectedUnit:c.unit}, set.items.length);
    const exact = candidates.filter(x => x.unitCompat === 'same' && !x.specConflict && !!x.item.ref &&
      terms.length > 0 && terms.every(t => tokenize(x.item.description).includes(t)));
    if (exact.length !== 1) return {id:c.id, proposal:null, reason:exact.length > 1 ?
      'More than one BOQ item matches the work and unit. Review required.' : 'No unique BOQ line matched both the drawing work description and unit.'};
    const b = exact[0].item;
    return {id:c.id, proposal:{ref:b.ref, description:b.description, unit:b.unit, file:b.sourceFile, sheet:b.sheet, row:b.rowNumber},
      reason:'Work terms and unit match a unique uploaded BOQ item. Proposed only; not approved or priced.'};
  });
  step('Propose BOQ matches', `${mappings.filter(m => m.proposal).length} proposed; ${mappings.filter(m => !m.proposal).length} held for review. No rates or cost impact were calculated.`);
  const sources = await Promise.all([
    {file:original,role:'Original drawing'}, {file:revised,role:'Revised drawing'}, {file:boq,role:'BOQ'},
  ].map(async ({file, role}) => ({name:file.name, role, sha256:await sha256Hex(file.bytes)})));
  if (referenceName) sources.push({name:referenceName,role:'Reference only · not read for quantities or matching',sha256:''});
  const snapshot: BrowserRehearsal = {version:1,savedAt:new Date().toISOString(),sources,reads:out.files,changes,mappings,
    replay,boqRows:set.items.length,events};
  if (JSON.stringify(snapshot).length > REHEARSAL_LIMIT) throw new Error('The result exceeds the browser rehearsal save limit. Choose a smaller example.');
  return snapshot;
}

export function loadBrowserRehearsal(raw: string | null): BrowserRehearsal | null {
  if (!raw || raw.length > REHEARSAL_LIMIT) return null;
  try {
    const v = JSON.parse(raw) as BrowserRehearsal | null;
    if (!v || v.version !== 1 || !Number.isFinite(Date.parse(v.savedAt)) || !readSavedDrawingReplay(v.replay) ||
        !Array.isArray(v.changes) || !Array.isArray(v.mappings) || !Array.isArray(v.sources) ||
        !Array.isArray(v.reads) || !Array.isArray(v.events) || !Number.isSafeInteger(v.boqRows) || v.boqRows < 1 ||
        v.sources.length < 3 || v.sources.length > 4 || !v.sources.every(s => s && [s.name,s.sha256,s.role].every(x=>typeof x==='string')) ||
        !v.events.every(e=>e && typeof e.step==='string' && typeof e.detail==='string') ||
        !v.reads.every(r=>r && [r.fileName,r.stateLabel,r.detail].every(x=>typeof x==='string')) ||
        v.changes.length === 0 || !v.changes.every(c=>c && c.basis==='measured' && !!c.trace && !!c.entityRefs &&
          [c.id,c.component,c.description,c.unit,c.changeQty,c.trace.formula,c.trace.drawingRevision].every(x=>typeof x==='string') &&
          [c.addedQty,c.omittedQty,c.netQty].every(x=>x===undefined || typeof x==='string') &&
          Array.isArray(c.sources) && c.sources.every(x=>typeof x==='string')) ||
        (v.schedule !== undefined && (!isRehearsalSchedule(v.schedule) || v.schedule.mappings.length !== v.changes.length ||
          new Set(v.schedule.mappings.map(m=>m.id)).size !== v.changes.length ||
          !v.schedule.mappings.every(m=>v.changes.some(c=>c.id===m.id)))) ||
        v.mappings.length !== v.changes.length || !v.mappings.every(m=>m && typeof m.id==='string' &&
          typeof m.reason==='string' && v.changes.some(c=>c.id===m.id) &&
          (m.proposal===null || (m.proposal && [m.proposal.ref,m.proposal.description,m.proposal.unit,m.proposal.file,m.proposal.sheet].every(x=>typeof x==='string') &&
            Number.isSafeInteger(m.proposal.row))))) return null;
    return v;
  } catch { return null; }
}

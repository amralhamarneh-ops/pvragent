import { afterEach, expect, it, vi } from 'vitest';
import { analyseDocuments } from '../drawings/analyse';
import { buildHandoff } from '../drawings/handoff';
import { classifyOne } from '../intake/triage';
import { outcomeOf, runAgent } from './agentClient';
import { drawingProgrammeScope } from '../mapping/drawingProgrammeScope';
import { withDrawingQuantities } from './drawingQuantities';
import { buildImport, confirmImport, stageUpload } from './importFlow';
import { EMPTY_ANSWERS } from './matchEngine';
import { processedPvrScopeKey } from './resolutions';
import type { ChangeScope } from './scope';

vi.mock('@/lib/supabase/client', () => ({ getAccessToken: async () => null }));
afterEach(() => vi.unstubAllGlobals());
const rows = (...v: (string | number)[]) => new TextEncoder().encode(v.join('\n') + '\n');
const line = (layer: string, handle: string, start: number, end: number) => [0, 'LINE', 5, handle, 8, layer, 10, start, 20, 0, 11, end, 21, 0];
const dxf = (...v: (string | number)[]) => rows(0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 6, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES', ...v, 0, 'ENDSEC', 0, 'EOF');
const original = 'GR-51_Ver1.dxf', revised = 'GR-51_Ver2.dxf';
const base = [...line('GUARD-RAIL', '1', 0, 10), ...line('CONTROL', '2', 10, 20), ...line('CONTROL', '3', 20, 30)];
const docs = [original, revised].map((name, i) => ({ name, id: `doc${i}`, role: 'drawings', version: 1, sha256: String(i + 1).repeat(64) }));
const scope: ChangeScope = { summary: '', location: '', packageName: '', contradictions: [], limitations: [], missingInformation: [], components: [{
  id: 'claimed', name: 'GUARD-RAIL', action: 'add', expectedUnit: 'm', location: '', discipline: '', workType: '', material: '', specification: '', searchTerms: ['guard rail'],
  quantity: { value: '98765', unit: 'm', origin: 'measured_from_geometry', source: 'Processed PVR', quote: '98765' }, evidence: [], missingInputs: [], potential: false, potentialReason: '',
}] };

async function measuredHandoff() {
  const result = await analyseDocuments({ narrative: '', files: [
    { name: original, bytes: dxf(...base), role: 'drawings' },
    { name: revised, bytes: dxf(...base, ...line('GUARD-RAIL', '4', 30, 42)), role: 'drawings' },
  ]});
  expect(result.changes.find((c) => c.addedQty === '12')?.entityRefs?.revised.map((e) => e.handle)).toEqual(['4']);
  return buildHandoff(result, {}, '', { originalNarrative: '', documents: docs, analysisVersion: 1 });
}

it('keeps benchmark evidence and quantity overrides out of the real valuation entry point', async () => {
  const handoff = await measuredHandoff();
  handoff.documents = [...docs, { name: 'Unlabelled reviewer comparison.pdf', role: 'reference', id: 'ref', version: 1, sha256: '3'.repeat(64) }];
  const csv = rows('Item,Description,Unit,Qty,Rate,Amount', 'A1,Guard Rail,m,0,20,0');
  const staged = await stageUpload('boq.csv', csv);
  const { imp } = buildImport({ caseId: 'case-1', staged, mappings: staged.mappings, currency: 'AED', revisionLabel: 'Rev 1', revision: 1 });
  const posts: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (_url: string, req: RequestInit) => {
    const body = JSON.parse(String(req.body)); posts.push(body);
    if (body.phase === 'scope') return Response.json({ scope, problems: [], events: [], cached: false });
    return Response.json({ match: { lines: body.scope.components.filter((c: { id: string }) => body.candidates[c.id]?.length).map((c: { id: string }) => ({
      componentId: c.id, rowId: body.candidates[c.id][0].rowId, role: 'primary', why: 'Same item', preambleNote: '',
    })), potentiallyAffected: [], unmatched: [], overlaps: [] }, problems: [], cached: false, events: [] });
  });
  vi.stubGlobal('fetch', fetch);
  const evidence = ['Original change instruction.txt', 'Processed PVR.xlsx', 'Unlabelled reviewer comparison.pdf', 'Automatic change analysis'].map((name) => ({ name, kind: 'pvr' as const, text: 'quantities available', extracted: true, note: '' }));
  const run = await runAgent({ imports: [confirmImport(imp)], evidence, narrative: '', drawingQuantityHandoff: handoff, activeDrawingDocuments: docs });
  expect((posts[0].evidence as typeof evidence).map((e) => e.name)).toEqual(['Original change instruction.txt']);
  const c = run.scope.components.find((c) => c.quantity)!;
  expect(c.quantity).toMatchObject({ value: '12', unit: 'm', origin: 'measured_from_geometry' });
  expect(c.quantity!.source).toContain(revised);
  const result = outcomeOf(run, { ...EMPTY_ANSWERS, quantity: { [c.id]: { value: '98765', unit: 'm' } } });
  expect(result.lines[0].calc).toMatchObject({ ok: true, signedAmount: '240' });
  const audit={ file:'comparison.pdf',page:'1',row:'3 / Engineer',scopeKey:processedPvrScopeKey(c) };
  const generic={ rateBasis:'Quotation',value:'99',unit:'m',currency:'AED',reason:'No BOQ rate',reference:'reviewed estimate',attachmentName:'',
    inclusions:{labour:true,materials:true,plant:true,overheads:true,profit:true},enteredAt:'2026-01-01T00:00:00Z',enteredBy:'reviewer',status:'proposed' as const };
  const pilot={ ...generic,rateBasis:'Processed PVR (pilot only)',processedPvr:audit };
  const price = (r:typeof run,manual:typeof generic|typeof pilot) => outcomeOf(r,{...EMPTY_ANSWERS,resolutions:{[c.id]:{kind:'manual_rate',manual}}});
  expect(price(run,pilot).lines[0].calc).toMatchObject({ok:true,signedAmount:'240'});
  const missing=structuredClone(run);
  for (const item of missing.set.items) item.rate={state:'missing',cell:'E2',text:'',formulaStatus:'none'};
  for (const candidate of (missing.shortlist[c.id]??[])) candidate.item.rate={state:'missing',cell:'E2',text:'',formulaStatus:'none'};
  expect(price(missing,generic).lines[0].manual).toBeUndefined();
  expect(price(missing,pilot).lines[0].manual?.amountSigned).toBe('1188');
  expect(price(missing,pilot).lines[0].manual?.rate.processedPvr).toMatchObject(audit);


  const current = [docs[0], { ...docs[1], sha256: 'f'.repeat(64), version: 2 }];
  const stale = await runAgent({ imports: [confirmImport(imp)], evidence, narrative: '', drawingQuantityHandoff: handoff, activeDrawingDocuments: current });
  expect(stale.scope.components.every((c) => c.quantity === null)).toBe(true);
  expect(outcomeOf(stale, { ...EMPTY_ANSWERS, quantity: { claimed: { value: '98765', unit: 'm' } } }).lines[0]).toMatchObject({ calc: null, quantityText: '—' });
});

it('ignores handoff overrides, blanks and holds conflicting or untraceable drawing quantities', async () => {
  const h = await measuredHandoff();
  const [valid] = h.changes;
  const untrusted = [
    { ...valid, acceptedFrom: 'document_stated' as const },
    { ...valid, conflict: true },
    { ...valid, entityRefs: undefined },
    { ...valid, sources: ['Benchmark.pdf', revised] },
  ];
  for (const change of untrusted) {
    const derived = withDrawingQuantities(scope, { ...h, changes: [change] }, docs);
    expect(derived.components[0].quantity).toBeNull();
  }
  expect(withDrawingQuantities(scope, h, []).components[0].quantity).toBeNull();
  expect(classifyOne({ path: 'Rate Comparison Schedule - Guard rail.pdf', size: 1 }).role).toBe('reference');
  expect(classifyOne({ path: 'PVR 017 original instruction.pdf', size: 1 }).role).toBe('pvr');
});

it('uses both revisions to value a measured relocation as rework, not an omission', async () => {
  const h = await measuredHandoff();
  const change = h.changes.find((c) => c.addedQty === '12')!;
  const moved = {
    ...change, addedQty: '0', omittedQty: '0', change: 'modified' as const, originalQty: '12',
    relocationEvidence: { source: 'Instruction', sentence: 'Relocate the guard rail.' },
    entityRefs: { ...change.entityRefs!, original: [{ ...change.entityRefs!.revised[0], handle: '5' }] },
  } as typeof change;
  const result = withDrawingQuantities({ ...scope, components: [] }, { ...h, changes: [moved] }, docs);
  expect(result.components).toHaveLength(1);
  expect(result.components[0]).toMatchObject({ action: 'rework', quantity: { value: '12', origin: 'measured_from_geometry' } });
});

it('carries measured scope into the programme before BOQ confirmation and holds stale evidence', async () => {
  const h=await measuredHandoff();
  const noBoq=drawingProgrammeScope(h,'AED',docs);
  expect(noBoq.lines.find(l=>l.work.quantity==='12')).toMatchObject({origin:'scope_only',priced:false,work:{executes:true,unit:'m',quantity:'12'}});
  const stale=drawingProgrammeScope(h,'AED',[docs[0],{...docs[1],version:2}]);
  expect(stale.lines.every(l=>l.work.quantity===null)).toBe(true);
  expect(stale.lines.some(l=>l.work.executes)).toBe(true);
});

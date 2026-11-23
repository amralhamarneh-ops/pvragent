import { describe, expect, it } from 'vitest';
import { buildImport, confirmImport, stageUpload } from './importFlow';
import { buildBoqModel, classifyUpload, documentKeyOf, duplicateReport, EMPTY_INCLUSION, INCLUSION_ANSWER_KEY, parseInclusion, serialiseInclusion, uploadIdentity } from './documents';
import { buildCoverage, overlappingItems, type RegisterDocInput } from './coverage';
import { buildBoqSet, shortlistForScope } from './matchEngine';
import { recordsFromImport } from './calc';
import type { BoqImport } from './types';
import type { ChangeScope } from './scope';

const enc = (s: string) => new TextEncoder().encode(s);

const ROADS_V1 = ['Item,Description,Unit,Qty,Rate,Amount', 'R-01,Excavation in common material,m3,0,18,0', 'R-02,Asphalt wearing course 50mm thick,m2,0,85,0', 'R-03,Precast concrete kerbstone 150x300,m,0,95,0'].join('\n');
const ROADS_V2 = ['Item,Description,Unit,Qty,Rate,Amount', 'R-01,Excavation in common material,m3,0,20,0', 'R-02,Asphalt wearing course 50mm thick,m2,0,90,0', 'R-03,Precast concrete kerbstone 150x300,m,0,95,0', 'R-04,Subbase crushed aggregate 200mm,m3,0,60,0'].join('\n');
const DRAIN = ['Item,Description,Unit,Qty,Rate,Amount', 'D-01,Reinforced concrete pipe culvert 600mm dia,m,0,410,0', 'D-02,Storm water gully with grating,nr,0,780,0'].join('\n');
const LIGHT = ['Item,Description,Unit,Qty,Rate,Amount', 'L-01,Street lighting column 10m complete,nr,0,3500,0', 'L-02,Luminaire LED 150W,nr,0,'].join('\n');
// An alternative commercial BOQ repeating the roads work under another file name.
const ROADS_ALT = ['Item,Description,Unit,Qty,Rate,Amount', 'A-01,Asphalt wearing course 50mm thick,m2,0,99,0'].join('\n');

let counter = 0;
async function imp(name: string, csv: string, revision: number): Promise<BoqImport> {
  const staged = await stageUpload(name, enc(csv));
  const { imp: i } = buildImport({ caseId: 'case-1', staged, mappings: staged.mappings, currency: 'AED', revisionLabel: `Revision ${revision}`, revision });
  counter += 1;
  return confirmImport({ ...i, id: `imp-${counter}` });
}

describe('BOQ set, document and revision model', () => {
  it('includes two different bills together with no revision selection needed', async () => {
    const roads = await imp('Roads.csv', ROADS_V1, 1);
    const drain = await imp('Drainage.csv', DRAIN, 2);
    const m = buildBoqModel([roads, drain], EMPTY_INCLUSION, roads.id);
    expect(m.includedDocuments).toBe(2);
    expect(m.selectedRevisions).toBe(2);
    expect(m.assessmentImports.map((i) => i.id).sort()).toEqual([drain.id, roads.id].sort());
    expect(m.documents.every((d) => !d.competing)).toBe(true);
    expect(m.summary).toContain('2 BOQ documents included; 1 selected revision per document.');
    // Item counts are exact: 3 + 2.
    expect(m.itemCount).toBe(5);
  });

  it('three documents: summary reads "3 BOQ documents included; 1 selected revision per document."', async () => {
    const m = buildBoqModel([await imp('Roads.csv', ROADS_V1, 1), await imp('Drainage.csv', DRAIN, 2), await imp('Lighting.csv', LIGHT, 3)], EMPTY_INCLUSION, null);
    expect(m.summary.startsWith('3 BOQ documents included; 1 selected revision per document.')).toBe(true);
    expect(m.itemCount).toBe(3 + 2 + 2);
  });

  it('a revised version of one bill only competes with that bill; the other bill is untouched', async () => {
    const r1 = await imp('Roads.csv', ROADS_V1, 1);
    const drain = await imp('Drainage.csv', DRAIN, 2);
    const r2 = await imp('Roads.csv', ROADS_V2, 3);
    const m = buildBoqModel([r1, drain, r2], EMPTY_INCLUSION, r1.id);
    expect(m.includedDocuments).toBe(2);
    const roads = m.documents.find((d) => d.key === documentKeyOf('Roads.csv'))!;
    expect(roads.competing).toBe(true);
    expect(roads.revisions.map((r) => r.label)).toEqual(['selected', 'superseded']);
    // Case-level selection pointed at r1, so r1 is the selected revision of Roads; Drainage is untouched.
    expect(roads.selectedImportId).toBe(r1.id);
    const drainDoc = m.documents.find((d) => d.key === documentKeyOf('Drainage.csv'))!;
    expect(drainDoc.competing).toBe(false);
    expect(drainDoc.selectedImportId).toBe(drain.id);
    // Exactly one revision per document reaches analysis: roads r1 (3 items) + drain (2 items).
    expect(m.assessmentImports.map((i) => i.id).sort()).toEqual([drain.id, r1.id].sort());
    expect(m.itemCount).toBe(5);
  });

  it('with no explicit choice the newest revision of a document is selected, and an explicit choice wins', async () => {
    const r1 = await imp('Roads.csv', ROADS_V1, 1);
    const r2 = await imp('Roads.csv', ROADS_V2, 2);
    expect(buildBoqModel([r1, r2], EMPTY_INCLUSION, null).assessmentImports[0].id).toBe(r2.id);
    const chosen = buildBoqModel([r1, r2], { excluded: {}, selected: { [documentKeyOf('Roads.csv')]: r1.id } }, null);
    expect(chosen.assessmentImports[0].id).toBe(r1.id);
    expect(chosen.documents[0].revisions.find((r) => r.importId === r2.id)!.label).toBe('superseded');
  });

  it('a duplicate upload is labelled, never competes and is never valued twice', async () => {
    const a = await imp('Roads.csv', ROADS_V1, 1);
    const dup = await imp('Roads.csv', ROADS_V1, 2); // identical content imported again
    const drain = await imp('Drainage.csv', DRAIN, 3);
    const m = buildBoqModel([a, dup, drain], EMPTY_INCLUSION, a.id);
    const roads = m.documents.find((d) => d.key === documentKeyOf('Roads.csv'))!;
    expect(roads.competing).toBe(false);
    expect(roads.revisions.map((r) => r.label)).toEqual(['selected', 'duplicate']);
    expect(roads.revisions[1].duplicateOf).toBe(a.id);
    expect(m.duplicateUploads).toBe(1);
    // Only one of the two identical imports reaches analysis.
    expect(m.assessmentImports.filter((i) => documentKeyOf(i.source.fileName) === documentKeyOf('Roads.csv'))).toHaveLength(1);
    expect(m.itemCount).toBe(3 + 2);
    // Reconciliation reports the duplicate but deletes nothing: both imports still exist as inputs.
    const rep = duplicateReport(m);
    expect(rep).toHaveLength(1);
    expect(rep[0].duplicateImportIds).toEqual([dup.id]);
    expect(rep[0].keptImportId).toBe(a.id);
  });

  it('the same filename with DIFFERENT content is a revision, not a duplicate', async () => {
    const a = await imp('Roads.csv', ROADS_V1, 1);
    const b = await imp('Roads.csv', ROADS_V2, 2);
    expect(classifyUpload('Roads.csv', b.source.sha256, [a]).kind).toBe('new_revision');
    expect(classifyUpload('Roads.csv', a.source.sha256, [a]).kind).toBe('duplicate');
    expect(classifyUpload('Other.csv', a.source.sha256, [a]).kind).toBe('new_document');
  });

  it('excluding a document removes it from the set but keeps it, and including it again restores it', async () => {
    const roads = await imp('Roads.csv', ROADS_V1, 1);
    const drain = await imp('Drainage.csv', DRAIN, 2);
    const key = documentKeyOf('Drainage.csv');
    const ex = buildBoqModel([roads, drain], { excluded: { [key]: 'Excluded by you.' }, selected: {} }, roads.id);
    expect(ex.includedDocuments).toBe(1);
    expect(ex.excludedDocuments).toBe(1);
    expect(ex.assessmentImports.map((i) => i.id)).toEqual([roads.id]);
    expect(ex.documents.find((d) => d.key === key)!.included).toBe(false);
    expect(ex.documents.find((d) => d.key === key)!.revisions).toHaveLength(1);
    expect(ex.summary).toContain('1 excluded');
    expect(buildBoqModel([roads, drain], EMPTY_INCLUSION, roads.id).includedDocuments).toBe(2);
  });

  it('an incomplete (unconfirmed) import never appears in the model', async () => {
    const good = await imp('Roads.csv', ROADS_V1, 1);
    const partial = { ...(await imp('Drainage.csv', DRAIN, 2)), confirmedAt: null };
    const m = buildBoqModel([good, partial], EMPTY_INCLUSION, good.id);
    expect(m.includedDocuments).toBe(1);
    expect(m.assessmentImports).toHaveLength(1);
  });

  it('inclusion state survives a reload round trip and ignores corrupt data', () => {
    const s = { excluded: { a: 'x' }, selected: { b: 'imp-9' } };
    expect(parseInclusion({ [INCLUSION_ANSWER_KEY]: serialiseInclusion(s) })).toEqual(s);
    expect(parseInclusion({ [INCLUSION_ANSWER_KEY]: '{not json' })).toEqual(EMPTY_INCLUSION);
    expect(parseInclusion(undefined)).toEqual(EMPTY_INCLUSION);
  });
});

describe('Identity used for React keys', () => {
  it('upload identity is document + content, so the same upload always maps to one entry', async () => {
    const a = await imp('Roads.csv', ROADS_V1, 1);
    expect(uploadIdentity('Roads.csv', a.source.sha256)).toBe(uploadIdentity('  roads.CSV ', a.source.sha256));
    const b = await imp('Roads.csv', ROADS_V2, 2);
    expect(uploadIdentity('Roads.csv', a.source.sha256)).not.toBe(uploadIdentity('Roads.csv', b.source.sha256));
  });

  it('every revision, document and record id in a multi-document model is unique', async () => {
    const all = [await imp('Roads.csv', ROADS_V1, 1), await imp('Roads.csv', ROADS_V1, 2), await imp('Roads.csv', ROADS_V2, 3), await imp('Drainage.csv', DRAIN, 4)];
    const m = buildBoqModel(all, EMPTY_INCLUSION, null);
    const docKeys = m.documents.map((d) => d.key);
    expect(new Set(docKeys).size).toBe(docKeys.length);
    const revIds = m.documents.flatMap((d) => d.revisions.map((r) => r.importId));
    expect(new Set(revIds).size).toBe(revIds.length);
    const recordIds = m.assessmentImports.flatMap((i) => recordsFromImport(i).map((r) => r.id));
    expect(new Set(recordIds).size).toBe(recordIds.length);
  });
});

describe('The whole included set reaches search and matching', () => {
  const scope: ChangeScope = {
    summary: 's', problems: [],
    components: [
      { id: 'c1', name: 'Asphalt wearing course', action: 'add', location: 'Road R4', description: 'Asphalt wearing course 50mm thick', evidence: [], quantity: null, potential: false, potentialReason: '' },
      { id: 'c2', name: 'Storm water gully', action: 'add', location: 'Road R4', description: 'Storm water gully with grating', evidence: [], quantity: null, potential: false, potentialReason: '' },
      { id: 'c3', name: 'Street lighting column', action: 'add', location: 'Road R4', description: 'Street lighting column 10m', evidence: [], quantity: null, potential: false, potentialReason: '' },
    ],
  } as unknown as ChangeScope;

  it('retrieval finds a match from EACH included document and keeps file provenance', async () => {
    const roads = await imp('Roads.csv', ROADS_V1, 1);
    const drain = await imp('Drainage.csv', DRAIN, 2);
    const light = await imp('Lighting.csv', LIGHT, 3);
    const set = buildBoqSet(buildBoqModel([roads, drain, light], EMPTY_INCLUSION, roads.id).assessmentImports);
    expect(set.files).toHaveLength(3);
    expect(set.items).toHaveLength(7);
    const sl = shortlistForScope(set, scope);
    expect(sl.c1[0].item.sourceFile).toBe('Roads.csv');
    expect(sl.c2[0].item.sourceFile).toBe('Drainage.csv');
    expect(sl.c3[0].item.sourceFile).toBe('Lighting.csv');
    // Every record keeps import id, sheet and row for provenance.
    expect(set.items.every((i) => i.importId && i.sheet !== undefined && i.rowNumber > 0 && i.sourceSha256)).toBe(true);
  });

  it('an excluded document is not searched; a superseded revision is not searched alongside the selected one', async () => {
    const r1 = await imp('Roads.csv', ROADS_V1, 1);
    const r2 = await imp('Roads.csv', ROADS_V2, 2);
    const drain = await imp('Drainage.csv', DRAIN, 3);
    const m = buildBoqModel([r1, r2, drain], { excluded: { [documentKeyOf('Drainage.csv')]: 'x' }, selected: {} }, null);
    const set = buildBoqSet(m.assessmentImports);
    expect(set.files.map((f) => f.fileName)).toEqual(['Roads.csv']);
    expect(set.files[0].importId).toBe(r2.id);
    expect(set.items).toHaveLength(4); // r2 has 4 items, not r1+r2
    expect(shortlistForScope(set, scope).c2.every((c) => c.item.sourceFile !== 'Drainage.csv')).toBe(true);
  });

  it('retrieval does not stop at the first page: every item of a large document is searchable', async () => {
    const big = ['Item,Description,Unit,Qty,Rate,Amount', ...Array.from({ length: 2400 }, (_, i) => `B-${i},Generic work item number ${i} concrete,m3,0,10,0`), 'B-X,Asphalt wearing course 50mm thick,m2,0,77,0'].join('\n');
    const b = await imp('Big.csv', big, 1);
    const set = buildBoqSet(buildBoqModel([b, await imp('Drainage.csv', DRAIN, 2)], EMPTY_INCLUSION, null).assessmentImports);
    expect(set.items.length).toBe(2401 + 2);
    expect(shortlistForScope(set, scope).c1.some((c) => c.item.ref === 'B-X')).toBe(true);
  });

  it('overlapping alternative BOQs are detected across included documents and stay distinguishable', async () => {
    const roads = await imp('Roads.csv', ROADS_V1, 1);
    const alt = await imp('Roads-alternative.csv', ROADS_ALT, 2);
    const m = buildBoqModel([roads, alt], EMPTY_INCLUSION, null);
    expect(m.includedDocuments).toBe(2);
    const items = m.assessmentImports.flatMap((i) => recordsFromImport(i));
    const ov = overlappingItems(items);
    expect(ov).toHaveLength(1);
    expect(ov[0].members.map((x) => x.sourceFile).sort()).toEqual(['Roads-alternative.csv', 'Roads.csv']);
    // Distinct record ids, so a row can never be valued twice by identity.
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });
});

describe('Document coverage register', () => {
  const doc = (over: Partial<RegisterDocInput> & { id: string; name: string }): RegisterDocInput => ({ category: 'Other', role: 'unused', sha256: over.id, version: 1, stored: true, storageDetail: '', state: 'stored', stateDetail: '', hasBytes: true, ...over });

  it('lists every uploaded document, including excluded, superseded, duplicate and unsupported ones', async () => {
    const r1 = await imp('Roads.csv', ROADS_V1, 1);
    const r2 = await imp('Roads.csv', ROADS_V2, 2);
    const drain = await imp('Drainage.csv', DRAIN, 3);
    const model = buildBoqModel([r1, r2, drain], { excluded: { [documentKeyOf('Drainage.csv')]: 'Excluded by you.' }, selected: {} }, null);
    const docs: RegisterDocInput[] = [
      doc({ id: 'd1', name: 'Roads.csv', role: 'boq', category: 'BOQ', sha256: r1.source.sha256 }),
      doc({ id: 'd2', name: 'Roads-v2.csv', role: 'boq', category: 'BOQ', sha256: r2.source.sha256 }),
      doc({ id: 'd3', name: 'Drainage.csv', role: 'boq', category: 'BOQ', sha256: drain.source.sha256 }),
      doc({ id: 'd4', name: 'Roads-copy.csv', role: 'boq', category: 'BOQ', sha256: r2.source.sha256 }),
      doc({ id: 'd5', name: 'site-photo.dwg', role: 'drawing', category: 'Drawings', sha256: 'zzz' }),
      doc({ id: 'd6', name: 'method.pdf', role: 'spec', category: 'Specification', sha256: 'yyy', stored: false, storageDetail: 'Not stored: network' }),
    ];
    const { rows, totals } = buildCoverage(docs, model, { readNames: [], unreadNotes: {}, runAt: null, importSignature: null }, null);
    expect(rows).toHaveLength(6); // nothing disappears
    expect(new Set(rows.map((r) => r.key)).size).toBe(6);
    const by = (id: string) => rows.find((r) => r.docId === id)!;
    expect(by('d2').inclusion).toBe('included'); // newest revision is the selected one
    expect(by('d1').inclusion).toBe('superseded');
    expect(by('d3').inclusion).toBe('excluded');
    expect(by('d3').inclusionReason).toContain('Excluded');
    expect(by('d4').inclusion).toBe('duplicate'); // identical content to d2 uploaded under another name
    expect(by('d5').read.status).toBe('unsupported');
    expect(by('d5').unreadContent).toContain('DWG');
    expect(by('d6').storage.stored).toBe(false);
    expect(totals.uploaded).toBe(6);
    expect(totals.used).toBe(0); // no analysis has run, so nothing is claimed as used
  });

  it('distinguishes uploaded, readable, processed and used, and marks a changed set as stale', async () => {
    const roads = await imp('Roads.csv', ROADS_V1, 1);
    const model = buildBoqModel([roads], EMPTY_INCLUSION, roads.id);
    const docs = [doc({ id: 'd1', name: 'Roads.csv', role: 'boq', category: 'BOQ', sha256: roads.source.sha256 }), doc({ id: 'd2', name: 'notes.txt', role: 'spec', category: 'Specification', sha256: 'n1' })];
    const ran = buildCoverage(docs, model, { readNames: ['Roads.csv', 'notes.txt'], unreadNotes: {}, runAt: '2026-11-21T07:00:00.000Z', importSignature: 'sig-A' }, 'sig-A');
    expect(ran.rows.find((r) => r.docId === 'd1')!.used).toBe(true);
    expect(ran.rows.find((r) => r.docId === 'd1')!.analysis).toBe('current');
    expect(ran.rows.find((r) => r.docId === 'd1')!.consumedBy).toContain('BOQ search, AI matching and valuation');
    const stale = buildCoverage(docs, model, { readNames: ['Roads.csv'], unreadNotes: {}, runAt: '2026-11-21T07:00:00.000Z', importSignature: 'sig-A' }, 'sig-B');
    expect(stale.rows.find((r) => r.docId === 'd1')!.analysis).toBe('stale');
    // Supporting evidence that was listed but not read is reviewed-not-used, with its reason.
    const unread = buildCoverage(docs, model, { readNames: ['Roads.csv'], unreadNotes: { 'notes.txt': 'The file is empty.' }, runAt: '2026-11-21T07:00:00.000Z', importSignature: 'sig-A' }, 'sig-A');
    const n = unread.rows.find((r) => r.docId === 'd2')!;
    expect(n.uploaded).toBe(true);
    expect(n.used).toBe(false);
    expect(n.unreadContent).toBe('The file is empty.');
    expect(n.inclusion).toBe('reference');
    expect(n.inclusionLabel).toBe('Reviewed as supporting evidence');
  });

  it('a BOQ workbook that was never imported is listed as excluded with the reason, not hidden', async () => {
    const docs = [doc({ id: 'd1', name: 'Pending.xlsx', role: 'boq', category: 'BOQ', sha256: 'p1' })];
    const { rows } = buildCoverage(docs, buildBoqModel([], EMPTY_INCLUSION, null), { readNames: [], unreadNotes: {}, runAt: null, importSignature: null }, null);
    expect(rows).toHaveLength(1);
    expect(rows[0].inclusion).toBe('excluded');
    expect(rows[0].inclusionReason).toContain('Not imported as BOQ rows yet');
    expect(rows[0].used).toBe(false);
  });
});

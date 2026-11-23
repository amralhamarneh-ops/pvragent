import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { buildImport, confirmImport, needsNoQuestion, stageUpload } from './importFlow';
import { assemble, buildBoqSet, shortlistForScope, EMPTY_ANSWERS } from './matchEngine';
import { retrieveCandidates } from './retrieve';
import { sanitiseMatch, sanitiseScope } from './agentSchemas';
import { buildRowContext } from './context';
import type { BoqImport } from './types';
import type { ChangeScope, ModelMatchResult, ScopeComponent } from './scope';

const enc = (s: string) => new TextEncoder().encode(s);

async function xlsx(build: (wb: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

async function importOf(name: string, bytes: Uint8Array, rev: number): Promise<BoqImport> {
  const staged = await stageUpload(name, bytes);
  const { imp } = buildImport({ caseId: 'case-1', staged, mappings: staged.mappings, currency: 'AED', revisionLabel: `Rev ${rev}`, revision: rev });
  return confirmImport(imp);
}

// Layout 1: plain CSV, standard headings.
const ROADS_CSV = [
  'Item,Description,Unit,Qty,Rate,Amount',
  'R-01,Excavation in common material,m3,0,18,0',
  'R-02,Asphalt wearing course 50mm thick,m2,0,85,0',
  'R-03,Asphalt wearing course 80mm thick,m2,0,120,0',
  'R-04,Precast concrete kerbstone 150x300,m,0,95,0',
  'R-05,Subbase crushed aggregate 200mm,m3,0,60,0',
].join('\n');

// Layout 2: XLSX with title rows, a different header vocabulary, bill headings, subtotal and a repeated header.
async function drainageXlsx(): Promise<Uint8Array> {
  return xlsx((wb) => {
    const ws = wb.addWorksheet('Bill 5 - Drainage');
    ws.addRow(['PROJECT: FAHID ISLAND ROADS']);
    ws.addRow([]);
    ws.addRow(['Bill No. 5 Drainage']);
    ws.addRow(['Ref', 'Work Item', 'UOM', 'Contract Qty', 'Unit Rate', 'Total']);
    ws.addRow(['5.1', 'Reinforced concrete pipe culvert 600mm dia', 'm', 0, 410, 0]);
    ws.addRow(['5.2', 'Storm water gully with grating', 'nr', 0, 780, 0]);
    ws.addRow(['', 'Sub-total Bill 5', '', '', '', 0]);
    ws.addRow(['Ref', 'Work Item', 'UOM', 'Contract Qty', 'Unit Rate', 'Total']);
    ws.addRow(['5.3', 'Manhole 1.2m dia', 'nr', 0, 2200, 0]);
    const ws2 = wb.addWorksheet('Cover');
    ws2.addRow(['Cover page']);
    ws2.addRow(['Contractor tender summary']);
  });
}

// Layout 3: a third file, different column order and wording, with a wrapped description line and a blank rate.
const LIGHTING_CSV = [
  'S/N;Particulars;Qty;U/M;Price',
  'L1;Supply and install street lighting column 10m;0;nr;3500',
  'L2;Luminaire LED 150W;0;nr;',
  ';(complete with driver and surge protection);;;',
].join('\n');

function comp(p: Partial<ScopeComponent> & { id: string; name: string }): ScopeComponent {
  return { action: 'add', discipline: '', workType: '', material: '', specification: '', location: '', searchTerms: [], expectedUnit: '', quantity: null, missingInputs: [], potential: false, potentialReason: '', evidence: [], ...p };
}

function scopeOf(components: ScopeComponent[], extra: Partial<ChangeScope> = {}): ChangeScope {
  return { summary: 'Road extension', location: '', packageName: '', components, contradictions: [], missingInformation: [], limitations: [], ...extra };
}

describe('automatic interpretation of different workbook layouts (no manual mapping)', () => {
  it('reads a plain CSV with standard headings without any mapping step', async () => {
    const staged = await stageUpload('roads.csv', enc(ROADS_CSV));
    expect(staged.interpretation.clear).toBe(true);
    expect(needsNoQuestion(staged)).toBe(true);
    const imp = await importOf('roads.csv', enc(ROADS_CSV), 1);
    const items = imp.rows.filter((r) => r.included);
    expect(items.map((r) => r.ref)).toEqual(['R-01', 'R-02', 'R-03', 'R-04', 'R-05']);
    expect(items[1].rate).toMatchObject({ state: 'value', value: '85' });
  });

  it('reads an XLSX with title rows, different header words, a subtotal and a repeated header', async () => {
    const bytes = await drainageXlsx();
    const staged = await stageUpload('drainage.xlsx', bytes);
    const drain = staged.interpretation.sheets.find((s) => s.sheet === 'Bill 5 - Drainage')!;
    expect(drain.mapping.included).toBe(true);
    expect(drain.mapping.headerRow).toBe(4);
    const cover = staged.interpretation.sheets.find((s) => s.sheet === 'Cover')!;
    expect(cover.mapping.included).toBe(false);
    const imp = await importOf('drainage.xlsx', bytes, 1);
    const priced = imp.rows.filter((r) => r.included);
    expect(priced.map((r) => r.ref)).toEqual(['5.1', '5.2', '5.3']);
    expect(imp.rows.some((r) => r.rowClass === 'subtotal')).toBe(true);
    expect(imp.rows.some((r) => r.rowClass === 'repeated_heading')).toBe(true);
    expect(priced[0].rate.value).toBe('410');
  });

  it('reads a semicolon CSV with a different column order and keeps a blank rate unpriced', async () => {
    const imp = await importOf('lighting.csv', enc(LIGHTING_CSV), 1);
    const items = imp.rows.filter((r) => r.included);
    expect(items.map((r) => r.ref)).toEqual(['L1', 'L2']);
    expect(items[0].unit).toBe('nr');
    expect(items[0].rate.value).toBe('3500');
    expect(items[1].rate.state).toBe('missing');
    expect(items[1].rowClass).toBe('unpriced_item');
  });

  it('attaches a wrapped continuation line to the item above instead of pricing it', async () => {
    const imp = await importOf('lighting.csv', enc(LIGHTING_CSV), 1);
    const ctx = buildRowContext(imp.rows);
    const l2 = imp.rows.find((r) => r.ref === 'L2')!;
    expect(ctx.get(l2.id)?.fullDescription).toContain('surge protection');
    expect(imp.rows.filter((r) => r.included)).toHaveLength(2);
  });

  it('asks a targeted question when two columns could hold the rate', async () => {
    const csv = ['Item,Description,Unit,Qty,Rate,Rate,Amount', 'A1,Pavement surface course,m2,10,5,6,50', 'A2,Kerb unit,m,10,7,8,70', 'A3,Edge drain,m,10,9,10,90'].join('\n');
    const staged = await stageUpload('two-rates.csv', enc(csv));
    const amb = staged.interpretation.ambiguities.find((a) => a.field === 'rate');
    expect(amb).toBeDefined();
    expect(amb!.candidates.map((c) => c.letter)).toEqual(expect.arrayContaining(['E', 'F']));
    expect(staged.interpretation.clear).toBe(false);
  });
});

describe('scope-to-item matching across several BOQ files', () => {
  async function fullSet() {
    const roads = await importOf('roads.csv', enc(ROADS_CSV), 1);
    const drain = await importOf('drainage.xlsx', await drainageXlsx(), 2);
    const light = await importOf('lighting.csv', enc(LIGHTING_CSV), 3);
    return buildBoqSet([roads, { ...drain, id: 'imp-drain' }, { ...light, id: 'imp-light' }]);
  }

  it('retrieves items from several files for one road-extension change', async () => {
    const set = await fullSet();
    const scope = scopeOf([
      comp({ id: 'c1', name: 'Asphalt surfacing', workType: 'asphalt pavement', searchTerms: ['bituminous', 'wearing course'], expectedUnit: 'm2', specification: '50mm' }),
      comp({ id: 'c2', name: 'Street lighting', workType: 'street lighting', searchTerms: ['luminaire', 'column'], expectedUnit: 'nr' }),
      comp({ id: 'c3', name: 'Pipe culvert', workType: 'drainage culvert', searchTerms: ['pipe'], expectedUnit: 'm' }),
    ]);
    const sl = shortlistForScope(set, scope);
    const files = (id: string) => sl[id].map((c) => c.item.sourceFile);
    expect(files('c1')).toContain('roads.csv');
    expect(files('c2')).toContain('lighting.csv');
    expect(files('c3')).toContain('drainage.xlsx');
  });

  it('matches differently worded descriptions through synonyms', async () => {
    const set = await fullSet();
    const c = comp({ id: 'k', name: 'Curb', workType: 'curb installation', searchTerms: ['kerbstone'], expectedUnit: 'm' });
    const hits = retrieveCandidates(set.items, set.context, c);
    expect(hits[0].item.ref).toBe('R-04');
  });

  it('ranks the compatible specification above a similar but incompatible one', async () => {
    const set = await fullSet();
    const c = comp({ id: 'a', name: 'Asphalt wearing course', workType: 'asphalt', specification: '50mm thick', expectedUnit: 'm2' });
    const hits = retrieveCandidates(set.items, set.context, c);
    const r2 = hits.find((h) => h.item.ref === 'R-02')!;
    const r3 = hits.find((h) => h.item.ref === 'R-03');
    expect(r2.specConflict).toBeNull();
    expect(r3?.specConflict ?? 'x').not.toBeNull();
    expect(hits[0].item.ref).toBe('R-02');
  });

  it('excludes an incompatible unit from the top ranks', async () => {
    const set = await fullSet();
    const c = comp({ id: 'a', name: 'Asphalt', workType: 'asphalt wearing course', expectedUnit: 'nr' });
    const hits = retrieveCandidates(set.items, set.context, c);
    expect(hits.every((h) => h.unitCompat !== 'same')).toBe(true);
  });

  it('uses each component quantity separately and takes the rate from the uploaded file', async () => {
    const set = await fullSet();
    const scope = scopeOf([
      comp({ id: 'c1', name: 'Asphalt surfacing', workType: 'asphalt', specification: '50mm', expectedUnit: 'm2', quantity: { value: '14000', unit: 'm2', origin: 'stated_in_document', source: 'narrative', quote: '14,000 m2' } }),
      comp({ id: 'c2', name: 'Kerbs', workType: 'kerb', expectedUnit: 'm', quantity: { value: '4000', unit: 'm', origin: 'stated_in_document', source: 'narrative', quote: '4,000 m' } }),
    ]);
    const sl = shortlistForScope(set, scope);
    const r2 = set.items.find((i) => i.ref === 'R-02')!;
    const r4 = set.items.find((i) => i.ref === 'R-04')!;
    const proposal: ModelMatchResult = { lines: [{ componentId: 'c1', rowId: r2.id, role: 'primary', why: 'x', preambleNote: '' }, { componentId: 'c2', rowId: r4.id, role: 'primary', why: 'y', preambleNote: '' }], potentiallyAffected: [], unmatched: [], overlaps: [] };
    const out = assemble(set, scope, proposal, sl);
    const a = out.lines.find((l) => l.item.ref === 'R-02')!;
    const k = out.lines.find((l) => l.item.ref === 'R-04')!;
    expect(a.calc && a.calc.ok && a.calc.signedAmount).toBe('1190000');
    expect(k.calc && k.calc.ok && k.calc.signedAmount).toBe('380000');
    expect(out.total).toBe('1570000');
  });

  it('does not price alternative candidates, keeps different changes on one row separate, and blocks identical work', async () => {
    const set = await fullSet();
    const q = { value: '100', unit: 'm2', origin: 'stated_in_document' as const, source: 'n', quote: '100 m2' };
    const scope = scopeOf([
      comp({ id: 'c1', name: 'Asphalt', workType: 'asphalt', expectedUnit: 'm2', location: 'Road A', quantity: q }),
      comp({ id: 'c2', name: 'Asphalt', workType: 'asphalt', expectedUnit: 'm2', location: 'Road B', quantity: q }),
      comp({ id: 'c3', name: 'Asphalt', workType: 'asphalt', expectedUnit: 'm2', location: 'Road B', quantity: q }),
    ]);
    const sl = shortlistForScope(set, scope);
    const r2 = set.items.find((i) => i.ref === 'R-02')!;
    const r3 = set.items.find((i) => i.ref === 'R-03')!;
    const proposal: ModelMatchResult = { lines: [
      { componentId: 'c1', rowId: r2.id, role: 'primary', why: '', preambleNote: '' },
      { componentId: 'c1', rowId: r3.id, role: 'alternative', why: '', preambleNote: '' },
      { componentId: 'c2', rowId: r2.id, role: 'primary', why: '', preambleNote: '' },
      { componentId: 'c3', rowId: r2.id, role: 'primary', why: '', preambleNote: '' },
    ], potentiallyAffected: [], unmatched: [], overlaps: [] };
    const out = assemble(set, scope, proposal, sl);
    const alt = out.lines.find((l) => l.item.ref === 'R-03' && l.componentId === 'c1')!;
    expect(alt.valued).toBe(false);
    // Road A and Road B are different changes on the same row: both valued. The second Road B is identical work: blocked.
    expect(out.lines.filter((l) => l.valued && l.item.ref === 'R-02').map((l) => l.componentId)).toEqual(['c1', 'c2']);
    expect(out.lines.find((l) => l.componentId === 'c3')?.status).toBe('blocked');
    expect(out.needs.some((n) => n.kind === 'overlap')).toBe(true);
    expect(out.total).toBe('17000');
  });

  it('discards model references that are not in the uploaded BOQ or not among the retrieved candidates', async () => {
    const set = await fullSet();
    const scope = scopeOf([comp({ id: 'c1', name: 'Kerbs', workType: 'kerb', expectedUnit: 'm', quantity: { value: '10', unit: 'm', origin: 'stated_in_document', source: 'n', quote: '10 m' } })]);
    const sl = shortlistForScope(set, scope);
    const proposal: ModelMatchResult = { lines: [{ componentId: 'c1', rowId: 'imp-fake:CSV!99', role: 'primary', why: '', preambleNote: '' }], potentiallyAffected: [], unmatched: [], overlaps: [] };
    const out = assemble(set, scope, proposal, sl);
    expect(out.rejectedModelRefs.length).toBe(1);
    expect(out.lines.filter((l) => l.valued)).toHaveLength(0);
    expect(out.unmatched.map((u) => u.componentId)).toEqual(['c1']);
    expect(out.total).toBeNull();
  });

  it('keeps unmatched scope visible and a blank rate unpriced, never zero', async () => {
    const set = await fullSet();
    const scope = scopeOf([comp({ id: 'c1', name: 'LED luminaire', workType: 'luminaire', expectedUnit: 'nr', quantity: { value: '20', unit: 'nr', origin: 'stated_in_document', source: 'n', quote: '20 nr' } })]);
    const sl = shortlistForScope(set, scope);
    const lum = set.items.find((i) => i.ref === 'L2')!;
    const out = assemble(set, scope, { lines: [{ componentId: 'c1', rowId: lum.id, role: 'primary', why: '', preambleNote: '' }], potentiallyAffected: [], unmatched: [], overlaps: [] }, sl);
    const line = out.lines[0];
    expect(line.status).toBe('unpriced');
    expect(out.total).toBeNull();
    expect(out.needs.some((n) => n.kind === 'missing_rate')).toBe(true);
  });

  it('triggers a targeted question for a missing dimension and blocks valuation until it is given', async () => {
    const set = await fullSet();
    const comps = [comp({ id: 'c1', name: 'Asphalt', workType: 'asphalt', specification: '50mm', expectedUnit: 'm2', quantity: { value: '2000', unit: 'm', origin: 'stated_in_document', source: 'n', quote: '2,000 m' } })];
    const scope = scopeOf(comps);
    const sl = shortlistForScope(set, scope);
    const r2 = set.items.find((i) => i.ref === 'R-02')!;
    const proposal: ModelMatchResult = { lines: [{ componentId: 'c1', rowId: r2.id, role: 'primary', why: '', preambleNote: '' }], potentiallyAffected: [], unmatched: [], overlaps: [] };
    const blocked = assemble(set, scope, proposal, sl);
    expect(blocked.total).toBeNull();
    expect(blocked.needs.some((n) => n.kind === 'missing_dimension')).toBe(true);
    const answered = assemble(set, scope, proposal, sl, { ...EMPTY_ANSWERS, derivation: { c1: { inputs: { width: { value: '7', unit: 'm' } }, basis: 'Typical section in PVR' } } });
    expect(answered.total).toBe('1190000');
  });

  it('keeps a plausible but unestablished component out of the valuation', async () => {
    const set = await fullSet();
    const scope = scopeOf([
      comp({ id: 'c1', name: 'Kerbs', workType: 'kerb', expectedUnit: 'm', quantity: { value: '10', unit: 'm', origin: 'stated_in_document', source: 'n', quote: '10 m' } }),
      comp({ id: 'c2', name: 'Street lighting', workType: 'street lighting', expectedUnit: 'nr', potential: true, potentialReason: 'Roads usually need lighting, but the PVR does not mention it.' }),
    ]);
    const sl = shortlistForScope(set, scope);
    const r4 = set.items.find((i) => i.ref === 'R-04')!;
    const out = assemble(set, scope, { lines: [{ componentId: 'c1', rowId: r4.id, role: 'primary', why: '', preambleNote: '' }], potentiallyAffected: [], unmatched: [], overlaps: [] }, sl);
    expect(out.potentials.map((p) => p.componentId)).toEqual(['c2']);
    expect(out.total).toBe('950');
    expect(out.needs.find((n) => n.kind === 'potential')?.issue).toContain('Potentially affected: clarification required');
  });

  it('changing the narrative changes which items are proposed', async () => {
    const set = await fullSet();
    const a = shortlistForScope(set, scopeOf([comp({ id: 'c1', name: 'Kerbs', workType: 'kerb', expectedUnit: 'm' })]));
    const b = shortlistForScope(set, scopeOf([comp({ id: 'c1', name: 'Pipe culvert', workType: 'drainage culvert', searchTerms: ['pipe'], expectedUnit: 'm' })]));
    expect(a.c1[0].item.ref).toBe('R-04');
    expect(b.c1[0].item.ref).toBe('5.1');
  });

  it('every proposed item and rate comes from the uploaded files', async () => {
    const set = await fullSet();
    const scope = scopeOf([comp({ id: 'c1', name: 'Kerbs', workType: 'kerb', expectedUnit: 'm', quantity: { value: '10', unit: 'm', origin: 'stated_in_document', source: 'n', quote: '10 m' } })]);
    const sl = shortlistForScope(set, scope);
    const r4 = set.items.find((i) => i.ref === 'R-04')!;
    const out = assemble(set, scope, { lines: [{ componentId: 'c1', rowId: r4.id, role: 'primary', why: '', preambleNote: '' }], potentiallyAffected: [], unmatched: [], overlaps: [] }, sl);
    const l = out.lines[0];
    expect(l.item.sourceFile).toBe('roads.csv');
    expect(l.item.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(l.calc && l.calc.ok && l.calc.rate).toBe('95');
  });
});

describe('model reply validation', () => {
  it('drops a quantity whose quote is not in the evidence', () => {
    const raw = { summary: 's', components: [{ id: 'c1', name: 'Asphalt', action: 'add', quantity: { value: '9999', unit: 'm', quote: 'nine thousand metres' } }] };
    const res = sanitiseScope(raw, [], 'Extend road by 2,000 m');
    expect(res.scope!.components[0].quantity).toBeNull();
    expect(res.problems.join(' ')).toContain('dropped');
  });

  it('keeps a quantity whose quote is in the narrative and contains the number', () => {
    const raw = { summary: 's', components: [{ id: 'c1', name: 'Road', action: 'add', quantity: { value: '2000', unit: 'm', quote: '2,000 m' } }] };
    const res = sanitiseScope(raw, [], 'Extend road R4 by 2,000 m');
    expect(res.scope!.components[0].quantity).toMatchObject({ value: '2000', unit: 'm', origin: 'stated_in_document' });
  });

  it('lists unreadable evidence as a limitation rather than claiming it was analysed', () => {
    const res = sanitiseScope({ summary: 's', components: [{ id: 'c1', name: 'x', action: 'add' }] }, [{ name: 'rev-c.dxf', kind: 'drawing', text: '', extracted: false, note: 'Drawing geometry is not analysed in this pass.' }], 'narrative');
    expect(res.scope!.limitations.join(' ')).toContain('rev-c.dxf');
  });

  it('rejects a row id that was not offered for that component', () => {
    const res = sanitiseMatch({ lines: [{ componentId: 'c1', rowId: 'x', role: 'primary' }, { componentId: 'c1', rowId: 'ok', role: 'primary' }] }, { c1: ['ok'] });
    expect(res.match!.lines.map((l) => l.rowId)).toEqual(['ok']);
    expect(res.problems).toHaveLength(1);
  });
});

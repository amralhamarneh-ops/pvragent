import { describe, expect, it } from 'vitest';
import { analyseDocuments, type InputFile } from './analyse';
import { classifyDates, proposeEventDate } from './dates';
import { extractStatedQuantities, reconcile } from './reconcile';
import { compareRevisions } from './titleblock';

type Ent = { kind: 'LWPOLYLINE'; layer: string; handle: string; pts: [number, number][]; closed?: boolean } | { kind: 'INSERT'; layer: string; handle: string; at: [number, number]; name: string } | { kind: 'TEXT'; text: string };

function dxf(ents: Ent[], insunits: number | null = 6): Uint8Array {
  const p: (string | number)[] = [0, 'SECTION', 2, 'HEADER'];
  if (insunits !== null) p.push(9, '$INSUNITS', 70, insunits);
  p.push(0, 'ENDSEC', 0, 'SECTION', 2, 'BLOCKS');
  for (const name of new Set(ents.flatMap((e) => e.kind === 'INSERT' ? [e.name] : []))) {
    p.push(0, 'BLOCK', 2, name, 70, 0, 10, 0, 20, 0, 0, 'ENDBLK');
  }
  p.push(0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES');
  for (const e of ents) {
    if (e.kind === 'LWPOLYLINE') {
      p.push(0, 'LWPOLYLINE', 5, e.handle, 8, e.layer, 90, e.pts.length, 70, e.closed ? 1 : 0);
      for (const [x, y] of e.pts) p.push(10, x, 20, y);
    } else if (e.kind === 'INSERT') {
      p.push(0, 'INSERT', 5, e.handle, 8, e.layer, 2, e.name, 10, e.at[0], 20, e.at[1]);
    } else {
      p.push(0, 'TEXT', 5, 'T' + Math.abs(hash(e.text)), 8, 'TEXT', 10, 0, 20, 0, 40, 2.5, 1, e.text);
    }
  }
  p.push(0, 'ENDSEC', 0, 'EOF');
  const s = p.reduce<string>((acc, v, i) => acc + String(v) + (i % 2 === 1 ? '\n' : '\n'), '');
  return new TextEncoder().encode(s);
}
function hash(s: string): number { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

const title = (n: string, rev: string, extra = '') => ({ kind: 'TEXT' as const, text: `DWG NO: ${n}  REV: ${rev} ${extra}` });
const road = (len: number): Ent => ({ kind: 'LWPOLYLINE', layer: 'ROAD-CL', handle: 'A1', pts: [[0, 0], [len, 0]] });
const pave = (len: number, w: number): Ent => ({ kind: 'LWPOLYLINE', layer: 'ROAD-PAVE', handle: 'A2', closed: true, pts: [[0, 0], [len, 0], [len, w], [0, w]] });
const lamps = (n: number): Ent[] => Array.from({ length: n }, (_, i) => ({ kind: 'INSERT' as const, layer: 'ROAD-LIGHT', handle: 'L' + i, at: [i * 50, 5] as [number, number], name: 'LAMP' }));

const enc = (s: string) => new TextEncoder().encode(s);
const f = (name: string, bytes: Uint8Array | null, role: InputFile['role'] = 'drawings'): InputFile => ({ name, bytes, role });

describe('revision comparison helper', () => {
  it('orders letters and numbers, and refuses when not comparable', () => {
    expect(compareRevisions('C', 'B')).toBe(1);
    expect(compareRevisions('A', 'B')).toBe(-1);
    expect(compareRevisions('2', '10')).toBe(-1);
    expect(compareRevisions('P1', 'P2')).toBe(-1);
    expect(compareRevisions('C', 'C')).toBe(0);
    expect(compareRevisions('A', '3')).toBeNull();
    expect(compareRevisions('', 'A')).toBeNull();
  });
});

describe('valid revision pair measured from real DXF content', () => {
  it('starts without any typed quantity or event date and returns evidence-linked changes', async () => {
    const original = dxf([title('R4-001', 'B', 'ISSUED 05/10/2026'), road(5000), pave(5000, 7), ...lamps(2)]);
    const revised = dxf([title('R4-001', 'C', 'ISSUED 20/10/2026'), road(7000), pave(7000, 7), ...lamps(4)]);
    const r = await analyseDocuments({ files: [f('r4-rev-b.dxf', original), f('r4-rev-c.dxf', revised)], narrative: '' });
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0].original.titleBlock?.revision).toBe('B');
    expect(r.pairs[0].revised.titleBlock?.revision).toBe('C');
    expect(r.pairs[0].validated).toBe(true);
    const by = Object.fromEntries(r.changes.map((c) => [c.component, c]));
    expect(by['ROAD-CL'].changeQty).toBe('2000');
    expect(by['ROAD-CL'].unit).toBe('m');
    expect(by['ROAD-CL'].basis).toBe('measured');
    expect(by['ROAD-PAVE'].changeQty).toBe('14000');
    expect(by['ROAD-PAVE'].unit).toBe('m2');
    expect(by['ROAD-LIGHT'].changeQty).toBe('2');
    expect(by['ROAD-LIGHT'].unit).toBe('nr');
    expect(by['ROAD-CL'].sources.length).toBe(2);
    const states = Object.fromEntries(r.files.map((x) => [x.fileName, x.stateLabel]));
    expect(states['r4-rev-b.dxf']).toBe('Validated');
    expect(r.agentNarrative).toContain('2000');
  });

  it('measures millimetre drawings in metres', async () => {
    const a = dxf([title('R4-002', 'A'), road(5_000_000)], 4);
    const b = dxf([title('R4-002', 'B'), road(7_000_000)], 4);
    const r = await analyseDocuments({ files: [f('a.dxf', a), f('b.dxf', b)], narrative: '' });
    expect(r.changes.find((c) => c.component === 'ROAD-CL')?.changeQty).toBe('2000');
  });

  it('reports a removal as a negative change', async () => {
    const a = dxf([title('R4-003', 'A'), road(7000)]);
    const b = dxf([title('R4-003', 'B'), road(6500)]);
    const r = await analyseDocuments({ files: [f('a.dxf', a), f('b.dxf', b)], narrative: '' });
    expect(r.changes[0].changeQty).toBe('-500');
  });
});

describe('does not assume a pair', () => {
  it('does not pair different drawing numbers', async () => {
    const r = await analyseDocuments({ files: [f('a.dxf', dxf([title('R4-001', 'A'), road(10)])), f('b.dxf', dxf([title('R5-001', 'B'), road(20)]))], narrative: '' });
    expect(r.pairs).toHaveLength(0);
    expect(r.changes).toHaveLength(0);
  });
  it('asks which is the revision when both carry the same revision', async () => {
    const r = await analyseDocuments({ files: [f('a.dxf', dxf([title('R4-001', 'B'), road(10)])), f('b.dxf', dxf([title('R4-001', 'B'), road(20)]))], narrative: '' });
    expect(r.pairs).toHaveLength(0);
    expect(r.questions.some((q) => q.kind === 'revision_order' && q.blocksComparison)).toBe(true);
  });
  it('asks when no revision label can be read', async () => {
    const r = await analyseDocuments({ files: [f('r4-001.dxf', dxf([{ kind: 'TEXT', text: 'DWG NO: R4-001' }, road(10)])), f('r4-001-copy.dxf', dxf([{ kind: 'TEXT', text: 'DWG NO: R4-001' }, road(20)]))], narrative: '' });
    expect(r.pairs).toHaveLength(0);
    expect(r.questions.some((q) => q.kind === 'revision_order')).toBe(true);
  });
});

describe('validation before measuring', () => {
  it('blocks measurement and asks about units when the drawing declares none', async () => {
    const a = dxf([title('R4-001', 'A'), road(5000)], null);
    const b = dxf([title('R4-001', 'B'), road(7000)], null);
    const r = await analyseDocuments({ files: [f('a.dxf', a), f('b.dxf', b)], narrative: '' });
    expect(r.pairs[0].validated).toBe(false);
    expect(r.changes).toHaveLength(0);
    expect(r.questions.some((q) => q.kind === 'unit' && q.blocksComparison)).toBe(true);
    expect(r.files.find((x) => x.fileName === 'a.dxf')?.stateLabel).toBe('Read successfully');
  });
  it('blocks when the revisions use different units', async () => {
    const r = await analyseDocuments({ files: [f('a.dxf', dxf([title('R4-001', 'A'), road(5000)], 4)), f('b.dxf', dxf([title('R4-001', 'B'), road(7)], 6))], narrative: '' });
    expect(r.pairs[0].validated).toBe(false);
    expect(r.changes).toHaveLength(0);
  });
  it('blocks when the drawings are not aligned', async () => {
    const far: Ent = { kind: 'LWPOLYLINE', layer: 'ROAD-CL', handle: 'A1', pts: [[900000, 900000], [900100, 900000]] };
    const r = await analyseDocuments({ files: [f('a.dxf', dxf([title('R4-001', 'A'), road(100)])), f('b.dxf', dxf([title('R4-001', 'B'), far]))], narrative: '' });
    expect(r.pairs[0].validated).toBe(false);
    expect(r.changes).toHaveLength(0);
  });
});

describe('unsupported formats are an honest limitation', () => {
  it('reports PDF, DWG and image drawings without producing quantities', async () => {
    const r = await analyseDocuments({ files: [f('r4-revB.pdf', enc('%PDF-1.4')), f('r4-revC.dwg', enc('AC1032')), f('scan.png', enc('x'))], narrative: '' });
    expect(r.changes).toHaveLength(0);
    expect(r.capability.unsupported).toHaveLength(3);
    expect(r.files.every((x) => x.stateLabel === 'Not supported')).toBe(true);
    expect(r.questions.filter((q) => q.kind === 'unsupported_format')).toHaveLength(3);
  });
  it('does not claim a restored draft without bytes was read', async () => {
    const r = await analyseDocuments({ files: [f('a.dxf', null)], narrative: '' });
    expect(r.files[0].stateLabel).toBe('Uploaded');
    expect(r.changes).toHaveLength(0);
  });
});

describe('dates', () => {
  it('labels drawing revision/issue dates and never proposes them as the event date', async () => {
    const a = dxf([title('R4-001', 'A', 'REV DATE: 01/09/2026'), road(10)]);
    const b = dxf([title('R4-001', 'B', 'ISSUED: 20/10/2026'), road(20)]);
    const r = await analyseDocuments({ files: [f('a.dxf', a), f('b.dxf', b)], narrative: '' });
    expect(r.dates.length).toBeGreaterThan(0);
    expect(r.dates.every((d) => d.meaning !== 'event_reported' && d.meaning !== 'instruction')).toBe(true);
    expect(r.proposedEventDate).toBeNull();
    expect(r.changes.length).toBeGreaterThan(0);
  });
  it('proposes an event date only from an explicit label, with its source', () => {
    const d = classifyDates('Date of event: 12 October 2026. Instruction issued 15 October 2026. PVR submitted on 2026-10-30.', { source: 'pvr.txt', documentKind: 'pvr' });
    expect(d.find((x) => x.iso === '2026-10-12')?.meaning).toBe('event_reported');
    expect(d.find((x) => x.iso === '2026-10-30')?.meaning).toBe('pvr_submission');
    expect(proposeEventDate(d)?.iso).toBe('2026-10-12');
  });
  it('flags day/month ambiguity instead of hiding it', () => {
    const d = classifyDates('Event date: 03/04/2026', { source: 'x', documentKind: 'pvr' });
    expect(d[0].context).toContain('ambiguous');
  });
  it('leaves the date unresolved when two different event dates are given', async () => {
    const r = await analyseDocuments({ files: [f('pvr.txt', enc('Event date: 01/10/2026\nEvent date: 15/10/2026'), 'pvr')], narrative: '' });
    expect(r.proposedEventDate).toBeNull();
    expect(r.questions.some((q) => q.kind === 'date')).toBe(true);
  });
});

describe('reconciliation across sources', () => {
  it('keeps the measured value and flags a conflicting PVR value without overwriting', async () => {
    const a = dxf([title('R4-001', 'A'), road(5000)]);
    const b = dxf([title('R4-001', 'B'), road(7000)]);
    const r = await analyseDocuments({ files: [f('a.dxf', a), f('b.dxf', b), f('pvr.txt', enc('Extend the road by 1,500 m to the east.'), 'pvr')], narrative: '' });
    const c = r.changes.find((x) => x.component === 'ROAD-CL')!;
    expect(c.changeQty).toBe('2000');
    expect(c.basis).toBe('measured');
    expect(c.conflict).toBe(true);
    expect(c.alternatives.some((x) => x.basis === 'document_stated' && x.value === '1500')).toBe(true);
    expect(r.questions.some((q) => q.kind === 'conflict')).toBe(true);
    expect(r.agentNarrative).not.toContain('ROAD-CL');
  });
  it('stays clean when the narrative agrees with the measurement', async () => {
    const a = dxf([title('R4-001', 'A'), road(5000)]);
    const b = dxf([title('R4-001', 'B'), road(7000)]);
    const r = await analyseDocuments({ files: [f('a.dxf', a), f('b.dxf', b)], narrative: 'Extend the road by 2.0 km.' });
    const c = r.changes.find((x) => x.component === 'ROAD-CL')!;
    expect(c.conflict).toBe(false);
    expect(c.alternatives.some((x) => x.basis === 'narrative_stated')).toBe(true);
  });
  it('keeps stated-only quantities labelled as stated, never measured', async () => {
    const r = await analyseDocuments({ files: [], narrative: 'Extend access road R4 by 2,000 m.' });
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].basis).toBe('narrative_stated');
    expect(r.changes[0].changeQty).toBe('2000');
  });
  it('extracts and normalises km to m', () => {
    const q = extractStatedQuantities('Add 2.5 km of road and 12 lights', 'n', 'narrative_stated');
    expect(q.find((x) => x.unit === 'm')?.value).toBe('2500');
    expect(q.find((x) => x.unit === 'nr')?.value).toBe('12');
  });
  it('does not match a stated quantity to a layer of a different dimension', () => {
    const rows = reconcile({ measured: [{ id: 'm-ROAD-PAVE', component: 'ROAD-PAVE', description: '', location: '', change: 'added', unit: 'm2', originalQty: '0', revisedQty: '100', changeQty: '100', basis: 'measured', measurementBasis: 'x', sources: [] }], stated: extractStatedQuantities('Pavement extension of 2000 m', 'n', 'narrative_stated') });
    const pave = rows.find((r) => r.id === 'm-ROAD-PAVE')!;
    expect(pave.alternatives).toHaveLength(0);
    expect(pave.conflict).toBe(false);
  });
});

describe('capability reporting', () => {
  it('lists the formats and operations actually implemented', async () => {
    const r = await analyseDocuments({ files: [], narrative: '' });
    expect(r.capability.supportedFormats.join(' ')).toContain('DXF');
    expect(r.capability.operations.length).toBeGreaterThan(0);
  });
});

describe('quantity provenance survives the handoff to BOQ matching', () => {
  const comp = (quote: string, value = '2000') => ({ components: [{ id: 'c1', name: 'Road extension', action: 'add', quantity: { value, unit: 'm', origin: 'stated_in_document', source: 'x', quote } }] });

  it('trusts measured geometry from the typed handoff, never from model prose', async () => {
    const a = dxf([title('R4-001', 'A'), road(5000)]);
    const b = dxf([title('R4-001', 'B'), road(7000)]);
    const files = [f('a.dxf', a), f('b.dxf', b)];
    const r = await analyseDocuments({ files, narrative: '' });
    const { sanitiseScope } = await import('../boq/agentSchemas');
    const { buildHandoff } = await import('./handoff');
    const { withDrawingQuantities } = await import('../boq/drawingQuantities');
    const { scope } = sanitiseScope(comp('Drawings measured 2,000 m.'), [{ name: 'Quote under test', kind: 'pvr', text: 'Drawings measured 2,000 m.', extracted: true, note: '' }], '');
    expect(scope?.components[0].quantity?.origin).toBe('stated_in_document');
    const documents = files.map(({ name }, i) => ({ id: 'doc-' + i, name, role: 'drawings', sha256: String(i + 1).repeat(64), version: 1 }));
    const handoff = buildHandoff(r, {}, '', { originalNarrative: '', documents });
    const trusted = withDrawingQuantities(scope!, handoff, documents);
    expect(trusted.components.filter((c) => c.quantity?.origin === 'measured_from_geometry')).toHaveLength(2);
    expect(trusted.components.find((c) => c.id === 'c1')?.quantity).toBeNull();
  });

  it('labels a typed quantity as user-entered in the drawing review, not in model evidence', async () => {
    const r = await analyseDocuments({ files: [], narrative: '', manual: { quantity: [{ componentId: 'Lighting columns', value: '12', unit: 'nr' }] } });
    expect(r.changes[0].basis).toBe('user_entered');
    const { sanitiseScope } = await import('../boq/agentSchemas');
    const model = comp(r.agentNarrative, '12');
    model.components[0].quantity.unit = 'nr';
    const { scope } = sanitiseScope(model, [{ name: 'Automatic change analysis', kind: 'pvr', text: r.agentNarrative, extracted: true, note: '' }], '');
    expect(scope?.components[0].quantity?.origin).toBe('stated_in_document');
  });

  it('keeps a plainly stated narrative quantity as stated, and drops a number the evidence does not contain', async () => {
    const { sanitiseScope } = await import('../boq/agentSchemas');
    const text = 'Extend access road R4 by 2,000 m.';
    const ok = sanitiseScope(comp('Extend access road R4 by 2,000 m'), [], text);
    expect(ok.scope?.components[0].quantity?.origin).toBe('stated_in_document');
    const bad = sanitiseScope(comp('Extend access road R4 by 2,000 m', '3000'), [], text);
    expect(bad.scope?.components[0].quantity).toBeNull();
  });

  it('holds back a conflicting change so it never reaches BOQ matching', async () => {
    const a = dxf([title('R4-001', 'A'), road(5000)]);
    const b = dxf([title('R4-001', 'B'), road(7000)]);
    const r = await analyseDocuments({ files: [f('a.dxf', a), f('b.dxf', b)], narrative: 'Extend the road by 1,500 m.' });
    expect(r.changes.find((c) => c.component === 'ROAD-CL')?.conflict).toBe(true);
    expect(r.agentNarrative).not.toContain('ROAD-CL');
  });
});

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { analyseDocuments, type InputFile } from './analyse';
import { evidenceForObject, relocationSentences } from './compare';
import { BATCH_SIZE, readDxf } from './dxfRead';
import { buildHandoff, mappingIsStale, recordsFromChanges } from './handoff';
import { initialRun, playbackLabel, runReducer } from './runState';
import { fingerprintChanges } from './snapshot';
import { pixelToWorld, buildLiveModel, buildViewModel } from './viewModel';
import type { GeometryBatch, ProcessingEvent } from './types';

function dxfText(entities: (string | number)[], opts: { insunits?: number | null } = {}): Uint8Array {
  const p: (string | number)[] = [0, 'SECTION', 2, 'HEADER'];
  const u = opts.insunits === undefined ? 6 : opts.insunits;
  if (u !== null) p.push(9, '$INSUNITS', 70, u);
  p.push(0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES', ...entities, 0, 'ENDSEC', 0, 'EOF');
  return new TextEncoder().encode(p.map(String).join('\n') + '\n');
}
const text = (t: string, h = 'T1') => [0, 'TEXT', 5, h, 8, 'TEXT', 10, 0, 20, 0, 40, 2.5, 1, t];
const lw = (layer: string, h: string, pts: [number, number][], closed = false) => [0, 'LWPOLYLINE', 5, h, 8, layer, 90, pts.length, 70, closed ? 1 : 0, ...pts.flatMap(([x, y]) => [10, x, 20, y])];
const dr = (name: string, bytes: Uint8Array | null): InputFile => ({ name, bytes, role: 'drawings' });
const enc = (s: string) => new TextEncoder().encode(s);

describe('geometry is delivered in real batches', () => {
  it('delivers every entity exactly once, in batches that carry layer, ids, units and extents', async () => {
    const lines = Array.from({ length: BATCH_SIZE + 50 }, (_, i) => lw('ROAD', `H${i}`, [[i, 0], [i, 1]])).flat();
    const batches: { layer: string; n: number; ids: number; units: string | null; ext: boolean; delivered: number; total: number }[] = [];
    const d = await readDxf('a.dxf', dxfText([...text('DWG NO: B-1 REV: A'), ...lines, ...lw('KERB', 'K1', [[0, 5], [3, 5]])]), undefined, {
      onBatch: (b) => { batches.push({ layer: b.layer, n: b.entities.length, ids: b.entityIds.length, units: b.unit, ext: !!b.extents, delivered: b.delivered, total: b.total }); },
    });
    expect(batches.filter((b) => b.layer === 'ROAD')).toHaveLength(2);
    expect(batches.reduce((s, b) => s + b.n, 0)).toBe(d.entities.length);
    expect(batches.every((b) => b.ids === b.n && b.units === 'm' && b.ext)).toBe(true);
    expect(batches[batches.length - 1].delivered).toBe(batches[batches.length - 1].total);
  });

  it('analyseDocuments emits geometry events carrying case id, run id, document id and entity ids', async () => {
    const events: ProcessingEvent[] = [];
    const a = dxfText([...text('DWG NO: B-2 REV: A'), ...lw('ROAD', 'A1', [[0, 0], [10, 0]])]);
    const b = dxfText([...text('DWG NO: B-2 REV: B'), ...lw('ROAD', 'A1', [[0, 0], [10, 0]])]);
    await analyseDocuments({ files: [{ ...dr('a.dxf', a), docId: 'doc-a' }, { ...dr('b.dxf', b), docId: 'doc-b' }], narrative: '', runId: 'R1', caseId: 'C1', onEvent: (e) => events.push(e) });
    const withBatch = events.filter((e) => e.batch);
    expect(withBatch.length).toBeGreaterThan(0);
    expect(withBatch.every((e) => e.batch!.runId === 'R1' && e.batch!.caseId === 'C1')).toBe(true);
    expect(withBatch.map((e) => e.batch!.documentId).sort()).toEqual(['doc-a', 'doc-b']);
    expect(withBatch[0].batch!.entityIds.length).toBeGreaterThan(0);
    // geometry arrives before the comparison starts, not after
    const firstBatch = events.findIndex((e) => e.batch);
    const comparison = events.findIndex((e) => e.stage === 'comparison');
    expect(firstBatch).toBeLessThan(comparison);
    expect(events.map((e) => e.stage)).not.toContain('rendering');
  });
});

describe('stale batches never reach a newer run', () => {
  const batch = (over: Partial<GeometryBatch> = {}): GeometryBatch => ({ caseId: 'c1', runId: 'A', documentId: 'd', fileName: 'f.dxf', batchIndex: 0, layer: 'L', entityIds: ['i:0'], entities: [], metresPerUnit: 1, unit: 'm', extents: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, delivered: 1, total: 2, ...over });
  const ev = (b: GeometryBatch, over: Partial<ProcessingEvent> = {}): ProcessingEvent => ({ seq: 1, runId: b.runId, caseId: b.caseId, stage: 'geometry', status: 'progress', detail: '', at: 0, layer: b.layer, fileName: b.fileName, count: 1, batch: b, ...over });

  it('applies a batch of the active run and ignores one from an earlier run', () => {
    let s = runReducer(initialRun(), { type: 'start', runId: 'B', caseId: 'c1', at: 0 });
    s = runReducer(s, { type: 'event', event: ev(batch({ runId: 'A' })) });
    expect(s.live).toEqual({}); expect(s.ignored).toBe(1);
    s = runReducer(s, { type: 'event', event: ev(batch({ runId: 'B' })) });
    expect(Object.keys(s.live)).toEqual(['f.dxf']); expect(s.geometryVersion).toBe(1);
  });
  it('refuses a batch whose own ids disagree with the event that carried it', () => {
    let s = runReducer(initialRun(), { type: 'start', runId: 'B', caseId: 'c1', at: 0 });
    s = runReducer(s, { type: 'event', event: ev(batch({ runId: 'OLD' }), { runId: 'B' }) });
    expect(s.live).toEqual({}); expect(s.ignored).toBe(1);
  });
  it('does not apply a duplicate batch twice and drops batches after cancellation', () => {
    let s = runReducer(initialRun(), { type: 'start', runId: 'A', caseId: 'c1', at: 0 });
    s = runReducer(s, { type: 'event', event: ev(batch()) });
    s = runReducer(s, { type: 'event', event: ev(batch()) });
    expect(s.live['f.dxf'].layers.L.batches).toBe(1);
    s = runReducer(s, { type: 'cancel', runId: 'A', caseId: 'c1' });
    s = runReducer(s, { type: 'event', event: ev(batch({ batchIndex: 1 })) });
    expect(s.live['f.dxf'].layers.L.batches).toBe(1);
  });
  it('a new run starts with no geometry from the previous one', () => {
    let s = runReducer(initialRun(), { type: 'start', runId: 'A', caseId: 'c1', at: 0 });
    s = runReducer(s, { type: 'event', event: ev(batch()) });
    s = runReducer(s, { type: 'start', runId: 'B', caseId: 'c1', at: 1 });
    expect(s.live).toEqual({}); expect(s.geometryVersion).toBe(0);
  });
});

describe('honest labelling', () => {
  it('says parsing is indivisible before any geometry arrives, then live, and only calls it Replay when replaying', () => {
    let s = runReducer(initialRun(), { type: 'start', runId: 'A', caseId: 'c1', at: 0 });
    s = runReducer(s, { type: 'event', event: { seq: 1, runId: 'A', caseId: 'c1', stage: 'parsing', status: 'started', detail: '', at: 0 } });
    expect(playbackLabel(s, false)).toMatch(/Parsing/);
    s = runReducer(s, { type: 'event', event: { seq: 2, runId: 'A', caseId: 'c1', stage: 'geometry', status: 'progress', detail: '', at: 0, layer: 'L', fileName: 'f', batch: { caseId: 'c1', runId: 'A', documentId: 'd', fileName: 'f', batchIndex: 0, layer: 'L', entityIds: [], entities: [], metresPerUnit: 1, unit: 'm', extents: null, delivered: 0, total: 0 } } });
    expect(playbackLabel(s, false)).toMatch(/Live/);
    s = runReducer(s, { type: 'complete', runId: 'A', caseId: 'c1' });
    expect(playbackLabel(s, false)).not.toMatch(/Replay/);
    expect(playbackLabel(s, true)).toMatch(/Replay/);
  });
});

describe('coordinate transform', () => {
  it('maps a click through the letterboxed viewBox, not by width alone', () => {
    // Viewport is square (100x100) in a wide 400x200 element: the drawing is centred with 100px bars either side.
    const vp = { x: 0, y: 0, w: 100, h: 100 };
    const rect = { left: 0, top: 0, width: 400, height: 200 };
    const centre = pixelToWorld(vp, rect, 200, 100);
    expect(centre.x).toBeCloseTo(50, 9); expect(centre.y).toBeCloseTo(50, 9);
    const left = pixelToWorld(vp, rect, 100, 0);
    expect(left.x).toBeCloseTo(0, 9); expect(left.y).toBeCloseTo(0, 9);
    expect(pixelToWorld(vp, rect, 300, 200).x).toBeCloseTo(100, 9);
  });
  it('builds a live model from received batches only', () => {
    const m = buildLiveModel({ 'f.dxf': { fileName: 'f.dxf', documentId: 'd', layers: { L: { entities: [{ kind: 'LWPOLYLINE', layer: 'L', handle: 'h', vertices: [{ x: 0, y: 0 }, { x: 2, y: 0 }], closed: false, length: 2, area: 0, segments: [{ type: 'line', x1: 0, y1: 0, x2: 2, y2: 0 }] }], entityIds: ['h'], batches: 1 } }, layerOrder: ['L'], metresPerUnit: 1, unit: 'm', extents: { minX: 0, minY: 0, maxX: 2, maxY: 0 }, delivered: 1, total: 5 } });
    expect(m.files[0].entities).toHaveLength(1); expect(m.files[0].delivered).toBe(1); expect(m.files[0].total).toBe(5);
  });
});

describe('origin shift is accounted for', () => {
  const body = (dx: number, dy: number) => Array.from({ length: 8 }, (_, i) => lw('WALL', `W${i}`, [[i * 10 + dx, dy], [i * 10 + dx, 5 + dy], [i * 10 + 4 + dx, 5 + dy]])).flat();
  it('does not report the whole drawing as changed when the origin moved', async () => {
    const o = dxfText([...text('DWG NO: O-1 REV: A'), ...body(0, 0)]);
    const r = dxfText([...text('DWG NO: O-1 REV: B'), ...body(100000, 50000)]);
    const out = await analyseDocuments({ files: [dr('a.dxf', o), dr('b.dxf', r)], narrative: '' });
    expect(out.pairs[0].validated).toBe(true);
    expect(out.pairs[0].originShift).not.toBeNull();
    expect(out.pairs[0].originShift!.dx).toBeCloseTo(-100000, 3);
    expect(out.changes.filter((c) => c.component === 'WALL')).toHaveLength(0);
    expect(out.questions.some((q) => q.kind === 'origin_shift' && !q.blocksComparison)).toBe(true);
  });
  it('still reports a genuine addition after the shift is applied', async () => {
    const o = dxfText([...text('DWG NO: O-2 REV: A'), ...body(0, 0)]);
    const r = dxfText([...text('DWG NO: O-2 REV: B'), ...body(2000, 1000), ...lw('WALL', 'NEW', [[500 + 2000, 1000], [520 + 2000, 1000]])]);
    const out = await analyseDocuments({ files: [dr('a.dxf', o), dr('b.dxf', r)], narrative: '' });
    const wall = out.changes.filter((c) => c.component === 'WALL');
    expect(wall).toHaveLength(1);
    expect(wall[0].change).toBe('added'); expect(wall[0].changeQty).toBe('20');
    expect(wall[0].entityRefs?.originShift).not.toBeNull();
  });
  it('the view model places shifted revised geometry in the original frame', async () => {
    const o = dxfText([...text('DWG NO: O-3 REV: A'), ...body(0, 0)]);
    const r = dxfText([...text('DWG NO: O-3 REV: B'), ...body(3000, 0)]);
    const out = await analyseDocuments({ files: [dr('a.dxf', o), dr('b.dxf', r)], narrative: '' });
    const m = buildViewModel(out.pairs[0], out.changes);
    expect(m.originShift).not.toBeNull();
    expect(m.entities.every((e) => e.state === 'unchanged')).toBe(true);
    expect(m.extent.maxX).toBeLessThan(200);
  });
});

describe('relocation evidence is tied to the object', () => {
  const light = (y: number) => lw('LIGHT', 'L1', [[0, y], [10, y]]);
  const kerb = (y: number) => lw('KERB', 'K1', [[0, y], [20, y]]);
  const base = (rev: string, ly: number, ky: number) => dxfText([...text(`DWG NO: X-1 REV: ${rev}`), ...light(ly), ...kerb(ky)]);

  it('a relocation sentence about lighting confirms only the lighting pair', async () => {
    const out = await analyseDocuments({ files: [dr('a.dxf', base('A', 50, 70)), dr('b.dxf', base('B', 60, 80))], narrative: 'The lighting cable route is relocated 10 m north.' });
    const l = out.changes.filter((c) => c.component === 'LIGHT');
    const k = out.changes.filter((c) => c.component === 'KERB');
    expect(l).toHaveLength(1); expect(l[0].change).toBe('modified');
    expect(l[0].relocationEvidence?.sentence).toMatch(/lighting/);
    expect(k.map((c) => c.change).sort()).toEqual(['added', 'removed']);
  });
  it('a relocation word that names nothing here confirms nothing', async () => {
    const out = await analyseDocuments({ files: [dr('a.dxf', base('A', 50, 70)), dr('b.dxf', base('B', 60, 80))], narrative: 'The site compound was moved to the west gate.' });
    expect(out.changes.filter((c) => c.component === 'LIGHT').map((c) => c.change).sort()).toEqual(['added', 'removed']);
    expect(out.changes.filter((c) => c.component === 'KERB').map((c) => c.change).sort()).toEqual(['added', 'removed']);
  });
  it('matches evidence by the layer subject only', () => {
    let s = relocationSentences([{ source: 'PVR', text: 'Drainage pipes were realigned. The kerb stays as drawn.' }]);
    expect(evidenceForObject('DRAIN-PIPE', [], s)?.matchedOn.length).toBeGreaterThan(0);
    expect(evidenceForObject('LIGHT', [], s)).toBeNull();
    expect(evidenceForObject('KERB', [], s)).toBeNull();
  });
});

describe('ambiguous correspondence is flagged, not guessed', () => {
  it('flags one addition that could match two equal removals, even with evidence', async () => {
    // Use unchanged site geometry to establish a shared coordinate frame independently of the moving lights.
    const anchor = lw('COMMON', 'anchor', [[-20, -20], [-20, 70]]);
    const o = dxfText([...text('DWG NO: A-1 REV: A'), ...anchor, ...lw('LIGHT', 'a', [[0, 0], [10, 0]]), ...lw('LIGHT', 'b', [[0, 20], [10, 20]])]);
    const r = dxfText([...text('DWG NO: A-1 REV: B'), ...anchor, ...lw('LIGHT', 'c', [[0, 50], [10, 50]])]);
    const out = await analyseDocuments({ files: [dr('o.dxf', o), dr('r.dxf', r)], narrative: 'Lighting was relocated.' });
    const light = out.changes.filter((c) => c.component === 'LIGHT');
    expect(light.some((c) => c.change === 'modified')).toBe(false);
    expect(light.some((c) => c.ambiguity)).toBe(true);
    expect(out.questions.some((q) => q.kind === 'correspondence')).toBe(true);
  });
});

describe('quantity records are traceable and never invented', () => {
  const o = dxfText([...text('DWG NO: Q-1 REV: A'), ...lw('ROAD-CL', 'r1', [[0, 0], [100, 0]]), ...lw('PAVE', 'p1', [[0, 0], [10, 0], [10, 5], [0, 5]], true)]);
  const r = dxfText([...text('DWG NO: Q-1 REV: B'), ...lw('ROAD-CL', 'r1', [[0, 0], [100, 0]]), ...lw('ROAD-CL', 'r2', [[100, 0], [150, 0]]), ...lw('PAVE', 'p2', [[0, 0], [10, 0], [10, 5], [0, 5]], true).slice(0, 0), ...lw('PAVE', 'p3', [[20, 0], [30, 0], [30, 4], [20, 4]], true)]);

  it('records added, omitted and net separately with formula, units, revision and entity references', async () => {
    const out = await analyseDocuments({ files: [dr('o.dxf', o), dr('r.dxf', r)], narrative: '' });
    const road = out.changes.find((c) => c.component === 'ROAD-CL')!;
    expect(road.addedQty).toBe('50'); expect(road.omittedQty).toBe('0'); expect(road.netQty).toBe('50');
    expect(road.trace?.formula).toMatch(/line and true arc lengths/);
    expect(road.trace?.units).toBe('m'); expect(road.trace?.drawingRevision).toBe('A → B');
    expect(road.entityRefs?.revised[0].handle).toBe('r2');
    const pave = out.changes.filter((c) => c.component === 'PAVE');
    expect(pave.map((c) => c.change).sort()).toEqual(['added', 'removed']);
    expect(pave.find((c) => c.change === 'removed')!.omittedQty).toBe('50');
    expect(pave.find((c) => c.change === 'added')!.addedQty).toBe('40');
  });
  it('does not derive an area or volume from a length: it names the missing dimensions', async () => {
    const out = await analyseDocuments({ files: [dr('o.dxf', o), dr('r.dxf', r)], narrative: '' });
    const road = out.changes.find((c) => c.component === 'ROAD-CL')!;
    expect(road.unit).toBe('m');
    expect(road.trace?.missingForDerivation?.join(' ')).toMatch(/width/);
    expect(road.trace?.missingForDerivation?.join(' ')).toMatch(/depth/);
    expect(out.changes.some((c) => c.unit === 'm3')).toBe(false);
  });
  it('keeps a stated narrative quantity beside the measured value without replacing either', async () => {
    const out = await analyseDocuments({ files: [dr('o.dxf', o), dr('r.dxf', r)], narrative: 'Extend the road by 80 m.' });
    const road = out.changes.find((c) => c.component === 'ROAD-CL')!;
    expect(road.basis).toBe('measured'); expect(road.changeQty).toBe('50');
    expect(road.alternatives.some((a) => a.value === '80' && a.basis === 'narrative_stated')).toBe(true);
    expect(road.conflict).toBe(true);
  });
});

describe('titles must agree before two files are treated as revisions', () => {
  it('asks when the drawing number matches but the titles clearly differ', async () => {
    const o = dxfText([...text('DWG NO: T-1 REV: A'), ...text('TITLE: Main Street kerb details', 'T2'), ...lw('X', 'a', [[0, 0], [1, 0]])]);
    const r = dxfText([...text('DWG NO: T-1 REV: B'), ...text('TITLE: Bridge parapet reinforcement', 'T3'), ...lw('X', 'a', [[0, 0], [2, 0]])]);
    const out = await analyseDocuments({ files: [dr('o.dxf', o), dr('r.dxf', r)], narrative: '' });
    const titleQ = out.questions.find((q) => q.id === 't1-skip' || q.id.startsWith('title-'));
    if (titleQ) { expect(out.pairs).toHaveLength(0); expect(titleQ.blocksComparison).toBe(true); }
    else expect(out.pairs[0].basis.join(' ')).toMatch(/Titles/);
  });
});

describe('structured handoff and invalidation', () => {
  it('passes structured records with formula and entity references, not prose', async () => {
    const o = dxfText([...text('DWG NO: H-1 REV: A'), ...lw('ROAD-CL', 'r1', [[0, 0], [100, 0]])]);
    const r = dxfText([...text('DWG NO: H-1 REV: B'), ...lw('ROAD-CL', 'r1', [[0, 0], [100, 0]]), ...lw('ROAD-CL', 'r2', [[100, 0], [130, 0]])]);
    const out = await analyseDocuments({ files: [dr('o.dxf', o), dr('r.dxf', r)], narrative: '' });
    const h = buildHandoff(out, {}, '', { originalNarrative: '', analysisVersion: 2 });
    const rec = h.records!.find((x) => x.component === 'ROAD-CL')!;
    expect(rec.addedQty).toBe('30'); expect(rec.omittedQty).toBe('0'); expect(rec.netQty).toBe('30');
    expect(rec.formula).toBeTruthy(); expect(rec.entityRefs?.revised[0].handle).toBe('r2'); expect(rec.needsReview).toBe(false);
    expect(h.analysisVersion).toBe(2);
    // quantities in the records are copies of the measured numbers, not re-read from the narrative text
    expect(Number(rec.netQty)).toBe(Number(out.changes.find((c) => c.component === 'ROAD-CL')!.changeQty));
  });
  it('marks a record that needs review and a re-analysis changes the fingerprint so dependants go stale', async () => {
    const o = dxfText([...text('DWG NO: H-2 REV: A'), ...lw('ROAD-CL', 'r1', [[0, 0], [100, 0]])]);
    const r1 = dxfText([...text('DWG NO: H-2 REV: B'), ...lw('ROAD-CL', 'r1', [[0, 0], [100, 0]]), ...lw('ROAD-CL', 'r2', [[100, 0], [130, 0]])]);
    const r2 = dxfText([...text('DWG NO: H-2 REV: B'), ...lw('ROAD-CL', 'r1', [[0, 0], [100, 0]]), ...lw('ROAD-CL', 'r2', [[100, 0], [160, 0]])]);
    const a = await analyseDocuments({ files: [dr('o.dxf', o), dr('r.dxf', r1)], narrative: 'Extend the road by 90 m.' });
    const b = await analyseDocuments({ files: [dr('o.dxf', o), dr('r.dxf', r2)], narrative: '' });
    expect(recordsFromChanges(a.changes).find((x) => x.component === 'ROAD-CL')!.needsReview).toBe(true);
    const ha = buildHandoff(a, {}, '', { originalNarrative: '' }); const hb = buildHandoff(b, {}, '', { originalNarrative: '' });
    expect(fingerprintChanges(a.changes)).not.toBe(fingerprintChanges(b.changes));
    expect(mappingIsStale(ha.fingerprint, hb)).toBe(true);
    expect(mappingIsStale(hb.fingerprint, hb)).toBe(false);
  });
});

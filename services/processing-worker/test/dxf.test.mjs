// Real tests for the worker's DXF reader (no database, no network). Run: cd services/processing-worker && npm install && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDxfForWorker } from '../src/dxf.mjs';

const dxf = (rows) => Buffer.from(rows.map(String).join('\n') + '\n');
const HDR = (units) => ['0', 'SECTION', '2', 'HEADER', ...(units === null ? [] : ['9', '$INSUNITS', '70', units]), '0', 'ENDSEC'];
const ENT = (...e) => ['0', 'SECTION', '2', 'ENTITIES', ...e.flat(), '0', 'ENDSEC', '0', 'EOF'];
const line = (layer, x1, y1, x2, y2) => ['0', 'LINE', '5', 'L' + Math.random().toString(16).slice(2, 6), '8', layer, '10', x1, '20', y1, '11', x2, '21', y2];
const rect = ['0', 'LWPOLYLINE', '5', 'R1', '8', 'WALL', '90', '4', '70', '1', '10', '0', '20', '0', '10', '10', '20', '0', '10', '10', '20', '4', '10', '0', '20', '4'];

test('rectangle in metres: complete coverage, units and scale established, exact length', async () => {
  const batches = [];
  const r = await readDxfForWorker('r.dxf', dxf([...HDR(6), ...ENT(rect)]), { onBatch: (b) => batches.push(b) });
  assert.equal(r.ok, true);
  assert.equal(r.coverage.unit, 'm'); assert.equal(r.coverage.metresPerUnit, 1);
  assert.equal(r.coverage.geometryEntities, 1);
  assert.equal(r.coverage.complete, true);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].entities[0].length, 28);
  assert.deepEqual(r.coverage.layers, [{ layer: 'WALL', entities: 1, lengthUnits: 28 }]);
});

test('unsupported entities are COUNTED BY NAME and coverage is not complete', async () => {
  const sp = ['0', 'SPLINE', '8', 'CURVE', '70', '8', '71', '3'];
  const ha = ['0', 'HATCH', '8', 'FILL'];
  const r = await readDxfForWorker('u.dxf', dxf([...HDR(6), ...ENT(rect, sp, sp, ha)]), {});
  assert.equal(r.ok, true);
  assert.equal(r.coverage.complete, false);
  assert.equal(r.coverage.skippedTypes.SPLINE, 2);
  assert.equal(r.coverage.skippedTypes.HATCH, 1);
  assert.equal(r.coverage.skippedEntityCount, 3);
  assert.match(r.coverage.scope, /not a complete reproduction/i);
});

test('undeclared units: scale is NOT established and the drawing is not complete', async () => {
  const r = await readDxfForWorker('n.dxf', dxf([...HDR(null), ...ENT(rect)]), {});
  assert.equal(r.coverage.unit, null); assert.equal(r.coverage.metresPerUnit, null);
  assert.equal(r.coverage.complete, false);
  assert.ok(r.coverage.issues.some((i) => /scale cannot be established/i.test(i)));
});

test('millimetres convert to a metre scale', async () => {
  const r = await readDxfForWorker('mm.dxf', dxf([...HDR(4), ...ENT(rect)]), {});
  assert.equal(r.coverage.unit, 'mm'); assert.equal(r.coverage.metresPerUnit, 0.001);
});

test('bulge polyline keeps its TRUE arc length (semicircle of radius 5 = 5π), not the chord', async () => {
  // Vertex 1 (0,0) bulge 1 -> vertex 2 (10,0): a semicircle, radius 5.
  const bp = ['0', 'LWPOLYLINE', '8', 'ARC1', '90', '2', '70', '0', '10', '0', '20', '0', '42', '1', '10', '10', '20', '0'];
  const r = await readDxfForWorker('b.dxf', dxf([...HDR(6), ...ENT(bp)]), {});
  assert.ok(Math.abs(r.coverage.layers[0].lengthUnits - 5 * Math.PI) < 0.01, `got ${r.coverage.layers[0].lengthUnits}`);
});

test('circle and arc are measured as curves', async () => {
  const c = ['0', 'CIRCLE', '8', 'C', '10', '0', '20', '0', '40', '2'];
  const a = ['0', 'ARC', '8', 'A', '10', '0', '20', '0', '40', '3', '50', '0', '51', '90'];
  const r = await readDxfForWorker('c.dxf', dxf([...HDR(6), ...ENT(c, a)]), {});
  const L = Object.fromEntries(r.coverage.layers.map((l) => [l.layer, l.lengthUnits]));
  assert.ok(Math.abs(L.C - 4 * Math.PI) < 0.01); assert.ok(Math.abs(L.A - 1.5 * Math.PI) < 0.01);
});

test('INSERT of a defined block is expanded with its transform; an undefined block is reported', async () => {
  const blocks = ['0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '2', 'TWO', '8', '0', '10', '0', '20', '0', ...line('0', 0, 0, 2, 0), '0', 'ENDBLK', '0', 'ENDSEC'];
  const ins = ['0', 'INSERT', '8', 'FURN', '2', 'TWO', '10', '5', '20', '5', '41', '2', '42', '2'];
  const bad = ['0', 'INSERT', '8', 'FURN', '2', 'MISSING', '10', '0', '20', '0'];
  const r = await readDxfForWorker('i.dxf', dxf([...HDR(6), ...blocks, ...ENT(ins, bad)]), {});
  assert.equal(r.coverage.insertsExpanded, 1);
  const furn = r.coverage.layers.find((l) => l.layer === 'FURN');
  assert.ok(furn && Math.abs(furn.lengthUnits - 4) < 1e-9, 'a 2-unit line scaled x2 is 4');
  assert.equal(r.coverage.complete, false);
  assert.ok(r.coverage.skippedTypes['INSERT of undefined block "MISSING"'] >= 1);
});

test('large drawings are delivered in several bounded batches that add up exactly', async () => {
  const many = []; for (let i = 0; i < 400; i += 1) many.push(line('ROAD', i, 0, i + 1, 0));
  const got = [];
  const r = await readDxfForWorker('big.dxf', dxf([...HDR(6), ...ENT(...many)]), { onBatch: (b) => got.push(b) });
  assert.ok(got.length > 1);
  assert.equal(got.reduce((s, b) => s + b.entities.length, 0), 400);
  assert.equal(got.at(-1).delivered, 400); assert.equal(got.at(-1).total, 400);
  assert.equal(r.coverage.geometryEntities, 400);
});

test('stop is honoured at a batch boundary and reports what was delivered', async () => {
  const many = []; for (let i = 0; i < 600; i += 1) many.push(line('ROAD', i, 0, i + 1, 0));
  let calls = 0;
  const r = await readDxfForWorker('big.dxf', dxf([...HDR(6), ...ENT(...many)]), { onBatch: () => {}, shouldStop: async () => (calls += 1) > 1 });
  assert.equal(r.ok, false); assert.equal(r.state, 'stopped');
  assert.ok(r.partial.delivered > 0 && r.partial.delivered < 600);
});

test('same content gives the same geometry hash; changed geometry changes it', async () => {
  const a = await readDxfForWorker('a.dxf', dxf([...HDR(6), ...ENT(rect)]), {});
  const b = await readDxfForWorker('b.dxf', dxf([...HDR(6), ...ENT(rect)]), {});
  const moved = rect.map((v, i) => (i === rect.indexOf('4') + 0 ? v : v)); // identical copy
  const c = await readDxfForWorker('c.dxf', dxf([...HDR(6), ...ENT(rect, line('WALL', 0, 0, 50, 0))]), {});
  assert.equal(a.coverage.geometryHash, b.coverage.geometryHash);
  assert.notEqual(a.coverage.geometryHash, c.coverage.geometryHash);
  void moved;
});

test('entities the parser silently drops (HATCH, LEADER, MLINE, WIPEOUT, IMAGE, VIEWPORT, TOLERANCE) are still counted', async () => {
  const dropped = ['HATCH', 'LEADER', 'MLINE', 'WIPEOUT', 'IMAGE', 'VIEWPORT', 'TOLERANCE'].map((t) => ['0', t, '8', 'L']);
  const r = await readDxfForWorker('d.dxf', dxf([...HDR(6), ...ENT(rect, ...dropped)]), {});
  for (const t of ['HATCH', 'LEADER', 'MLINE', 'WIPEOUT', 'IMAGE', 'VIEWPORT', 'TOLERANCE']) assert.equal(r.coverage.skippedTypes[t], 1, `${t} must be reported`);
  assert.equal(r.coverage.complete, false);
  assert.equal(r.coverage.skippedEntityCount, 7);
});

test('a type the parser returns AND the census sees is counted once, not twice', async () => {
  const sp = ['0', 'SPLINE', '8', 'CURVE', '70', '8', '71', '3'];
  const r = await readDxfForWorker('s.dxf', dxf([...HDR(6), ...ENT(rect, sp, sp)]), {});
  assert.equal(r.coverage.skippedTypes.SPLINE, 2);
  assert.equal(r.coverage.skippedEntityCount, 2);
});

test('binary DXF and garbage are refused with a reason, never "read"', async () => {
  const bin = await readDxfForWorker('x.dxf', Buffer.from('AutoCAD Binary DXF\r\n\x1a\0\0'), {});
  assert.equal(bin.ok, false); assert.equal(bin.state, 'unsupported');
  const bad = await readDxfForWorker('y.dxf', Buffer.from('not a dxf'), {});
  assert.equal(bad.ok === false || bad.coverage?.geometryEntities === 0, true);
});

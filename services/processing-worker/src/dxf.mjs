/**
 * Worker-side DXF reader. Produces:
 *   - a drawing "coverage" record (units, scale, layers, entity types processed, skipped/unsupported types, XREFs)
 *   - geometry batches per layer (real parsed geometry, capped per batch) for the live preview
 *   - a stable geometry hash so a result is tied to the exact content
 * Supported geometry: LINE, LWPOLYLINE/POLYLINE (with bulges), CIRCLE, ARC, INSERT (expanded, rotation/scale/array).
 * Everything else is COUNTED BY NAME as unsupported. Nothing is silently dropped and no "complete" claim is made
 * when unsupported content or XREFs exist.
 */
import { inventoryLargeDxf } from './largeDxf.mjs';
import { createHash } from 'node:crypto';

const INSUNITS = { 4: { unit: 'mm', metres: 0.001 }, 5: { unit: 'cm', metres: 0.01 }, 6: { unit: 'm', metres: 1 } };
const TWO_PI = Math.PI * 2;
const MAX_DEPTH = 8;
export const BATCH_ENTITIES = Number(process.env.GEOMETRY_BATCH_ENTITIES || 150);
/** Preview-only cap on vertices per entity. Measured lengths always use the full-resolution path; only the DRAWN polyline is thinned. */
const PREVIEW_MAX_POINTS = Number(process.env.PREVIEW_MAX_POINTS || 120);
const thin = (g) => {
  if (g.points.length <= PREVIEW_MAX_POINTS) return g;
  const step = Math.ceil(g.points.length / PREVIEW_MAX_POINTS);
  const pts = g.points.filter((_, i) => i % step === 0);
  const last = g.points[g.points.length - 1];
  if (pts[pts.length - 1] !== last) pts.push(last);
  return { ...g, points: pts, previewThinned: true };
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isPt = (v) => !!v && typeof v === 'object' && num(v.x) !== null && num(v.y) !== null;
const apply = (m, p) => ({ x: m.a * p.x + m.c * p.y + m.tx, y: m.b * p.x + m.d * p.y + m.ty });
const mul = (p, q) => ({ a: p.a * q.a + p.c * q.b, b: p.b * q.a + p.d * q.b, c: p.a * q.c + p.c * q.d, d: p.b * q.c + p.d * q.d, tx: p.a * q.tx + p.c * q.ty + p.tx, ty: p.b * q.tx + p.d * q.ty + p.ty });
const ID = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
const detScale = (m) => Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
const uniform = (m) => Math.abs(Math.hypot(m.a, m.b) - Math.hypot(m.c, m.d)) < 1e-9 * Math.max(1, Math.hypot(m.a, m.b));

/** Arc through two vertices with a DXF bulge, returned as a polyline of points (for preview) plus its true length. */
function bulgePoints(p1, p2, bulge) {
  const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (!(Math.abs(bulge) > 1e-12) || chord < 1e-12) return { pts: [p1, p2], length: chord };
  const sweep = 4 * Math.atan(bulge);
  const r = chord / (2 * Math.sin(Math.abs(sweep) / 2));
  const mx = (p1.x + p2.x) / 2; const my = (p1.y + p2.y) / 2;
  const h = r * Math.cos(Math.abs(sweep) / 2);
  const nx = -(p2.y - p1.y) / chord; const ny = (p2.x - p1.x) / chord;
  const side = bulge > 0 ? 1 : -1;
  const cx = mx + nx * h * side; const cy = my + ny * h * side;
  const a0 = Math.atan2(p1.y - cy, p1.x - cx);
  const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
  const pts = [];
  for (let i = 0; i <= steps; i += 1) { const a = a0 + (sweep * i) / steps; pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); }
  return { pts, length: Math.abs(sweep) * r };
}

function arcPoints(cx, cy, r, s, e) {
  let sw = e - s; while (sw <= 0) sw += TWO_PI;
  const steps = Math.max(6, Math.ceil(sw / (Math.PI / 18)));
  const pts = [];
  for (let i = 0; i <= steps; i += 1) { const a = s + (sw * i) / steps; pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); }
  return { pts, length: sw * r };
}

const round = (n) => Math.round(n * 1000) / 1000;

function toGeometry(e, m, layer, skipped) {
  const kind = String(e.type ?? '');
  if (kind === 'LINE' || kind === 'LWPOLYLINE' || kind === 'POLYLINE') {
    const pts = (Array.isArray(e.vertices) ? e.vertices : []).filter(isPt);
    if (pts.length < 2) return null;
    const closed = e.shape === true || e.closed === true;
    const n = closed ? pts.length : pts.length - 1;
    const path = []; let length = 0;
    for (let i = 0; i < n; i += 1) {
      const a = pts[i]; const b = pts[(i + 1) % pts.length];
      const seg = bulgePoints({ x: a.x, y: a.y }, { x: b.x, y: b.y }, num(a.bulge) ?? 0);
      const w = seg.pts.map((p) => apply(m, p));
      if (!path.length) path.push(...w); else path.push(...w.slice(1));
      length += seg.length * detScale(m);
    }
    return { kind, layer, closed, points: path.map((p) => [round(p.x), round(p.y)]), length: round(length) };
  }
  if (kind === 'CIRCLE') {
    const c = e.center; const r = num(e.radius);
    if (!isPt(c) || r === null) return null;
    if (!uniform(m)) { skipped['CIRCLE (non-uniform block scale)'] = (skipped['CIRCLE (non-uniform block scale)'] ?? 0) + 1; return null; }
    const wc = apply(m, c); const wr = r * detScale(m);
    const ap = arcPoints(wc.x, wc.y, wr, 0, TWO_PI - 1e-9);
    return { kind, layer, closed: true, points: ap.pts.map((p) => [round(p.x), round(p.y)]), length: round(TWO_PI * wr) };
  }
  if (kind === 'ARC') {
    const c = e.center; const r = num(e.radius); const s = num(e.startAngle); const en = num(e.endAngle);
    if (!isPt(c) || r === null || s === null || en === null) return null;
    if (!uniform(m)) { skipped['ARC (non-uniform block scale)'] = (skipped['ARC (non-uniform block scale)'] ?? 0) + 1; return null; }
    const rot = Math.atan2(m.b, m.a); const k = detScale(m); const wc = apply(m, c);
    const ap = arcPoints(wc.x, wc.y, r * k, s + rot, en + rot);
    return { kind, layer, closed: false, points: ap.pts.map((p) => [round(p.x), round(p.y)]), length: round(ap.length) };
  }
  return null;
}

function expandInsert(e, m, blocks, depth, emit, skipped, state) {
  const name = String(e.name ?? ''); const def = blocks[name]; const pos = isPt(e.position) ? e.position : null;
  if (!def || !Array.isArray(def.entities) || !pos) return false;
  if (depth >= MAX_DEPTH) { skipped['INSERT (nesting deeper than 8)'] = (skipped['INSERT (nesting deeper than 8)'] ?? 0) + 1; return true; }
  const sx = num(e.xScale) ?? 1; const sy = num(e.yScale) ?? sx; const rot = ((num(e.rotation) ?? 0) * Math.PI) / 180;
  const cols = Math.max(1, Math.floor(num(e.columnCount) ?? 1)); const rows = Math.max(1, Math.floor(num(e.rowCount) ?? 1));
  const cs = num(e.columnSpacing) ?? 0; const rs = num(e.rowSpacing) ?? 0;
  const base = def.position && isPt(def.position) ? def.position : { x: 0, y: 0 };
  const cos = Math.cos(rot); const sin = Math.sin(rot);
  for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) {
    const local = { a: cos * sx, b: sin * sx, c: -sin * sy, d: cos * sy, tx: pos.x + cos * c * cs - sin * r * rs, ty: pos.y + sin * c * cs + cos * r * rs };
    const full = mul(m, mul(local, { a: 1, b: 0, c: 0, d: 1, tx: -base.x, ty: -base.y }));
    state.expanded += 1;
    for (const be of def.entities) {
      if (be.type === 'INSERT') { if (!expandInsert(be, full, blocks, depth + 1, emit, skipped, state)) skipped[`INSERT of undefined block "${String(be.name ?? '')}"`] = (skipped[`INSERT of undefined block "${String(be.name ?? '')}"`] ?? 0) + 1; continue; }
      if (['TEXT', 'MTEXT', 'ATTRIB', 'ATTDEF'].includes(be.type)) { state.textEntities += 1; continue; }
      const layer = String(be.layer ?? '0') === '0' ? String(e.layer ?? '0') : String(be.layer ?? '0');
      const g = toGeometry(be, full, layer, skipped);
      if (g) { g.fromBlock = name; emit(g); } else bump(skipped, String(be.type ?? 'unknown'));
    }
  }
  return true;
}
const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };

/**
 * Independent census of entity types straight from the DXF text, in the ENTITIES section and in block definitions.
 * dxf-parser silently DROPS some types (observed: HATCH, LEADER, MLINE, WIPEOUT, IMAGE, VIEWPORT, TOLERANCE), so
 * relying on the parser alone would let a drawing with hatches be reported as fully read. Pairs are (group code, value).
 */
export function censusEntityTypes(text) {
  const lines = text.split(/\r?\n/);
  const top = {}; const inBlocks = {};
  let section = ''; let inBlock = false;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim(); const val = lines[i + 1].trim();
    if (code !== '0') {
      if (code === '2' && lines[i - 2]?.trim() === '0' && lines[i - 1]?.trim() === 'SECTION') section = val;
      continue;
    }
    if (val === 'SECTION') continue;
    if (val === 'ENDSEC') { section = ''; continue; }
    if (section === 'BLOCKS') {
      if (val === 'BLOCK') { inBlock = true; continue; }
      if (val === 'ENDBLK') { inBlock = false; continue; }
      if (inBlock) bump(inBlocks, val);
    } else if (section === 'ENTITIES') {
      if (val === 'SEQEND' || val === 'VERTEX' || val === 'ATTRIB') continue; // sub-records of POLYLINE / INSERT
      bump(top, val);
    }
  }
  return { top, inBlocks };
}
/** Types this reader turns into measurable geometry, or deliberately reads as text. */
const HANDLED = new Set(['LINE', 'LWPOLYLINE', 'POLYLINE', 'CIRCLE', 'ARC', 'INSERT', 'TEXT', 'MTEXT', 'ATTDEF']);

/**
 * Read a DXF. `onBatch` receives real geometry batches in layer order; `shouldStop` is polled between batches so a
 * cancel request ends work at the next safe boundary. Returns the coverage record (never claims completeness it
 * cannot support).
 */
export async function readDxfForWorker(fileName, bytes, { onBatch, shouldStop, parserLoader } = {}) {
  if (bytes.byteLength > 480 * 1024 * 1024) return inventoryLargeDxf(bytes);
  const text = Buffer.from(bytes).toString('utf8');
  if (/^\s*AutoCAD Binary DXF/.test(text.slice(0, 40))) {
    return { ok: false, state: 'unsupported', error: 'Binary DXF is not supported. Export an ASCII DXF.' };
  }
  let parsed;
  try {
    const mod = parserLoader ? await parserLoader() : await import('dxf-parser');
    const Ctor = mod.default ?? mod.DxfParser;
    parsed = new Ctor().parseSync(text);
  } catch (e) { return { ok: false, state: 'failed', error: `The DXF could not be parsed: ${String(e?.message ?? e)}` }; }
  if (!parsed || typeof parsed !== 'object') return { ok: false, state: 'failed', error: 'The DXF contained no readable data.' };

  const header = parsed.header ?? {}; const blocks = parsed.blocks ?? {};
  const raw = Array.isArray(parsed.entities) ? parsed.entities : [];
  const skipped = {}; const processedTypes = {}; const layerGeo = new Map();
  const state = { expanded: 0, textEntities: 0 };
  const emit = (g) => { if (!layerGeo.has(g.layer)) layerGeo.set(g.layer, []); layerGeo.get(g.layer).push(g); bump(processedTypes, g.kind); };
  let inserts = 0; const texts = [];
  for (const e of raw) {
    if (['TEXT', 'MTEXT', 'ATTRIB', 'ATTDEF'].includes(e.type)) { state.textEntities += 1; const t = String(e.text ?? e.string ?? '').trim(); if (t && texts.length < 200) texts.push(t.slice(0, 200)); continue; }
    if (e.type === 'INSERT') { inserts += 1; if (!expandInsert(e, ID, blocks, 0, emit, skipped, state)) bump(skipped, `INSERT of undefined block "${String(e.name ?? '')}"`); continue; }
    const g = toGeometry(e, ID, String(e.layer ?? '0'), skipped);
    if (g) emit(g); else bump(skipped, String(e.type ?? 'unknown'));
  }

  const skippedTotal0 = Object.values(skipped).reduce((s, n) => s + n, 0);
  // Reconcile with the raw census: any unhandled type present in the file but missing from the parser's output was
  // dropped by the parser. Count it by name so it appears as unsupported content instead of vanishing.
  const census = censusEntityTypes(text);
  const dropped = {};
  for (const [t, n] of Object.entries(census.top)) {
    if (HANDLED.has(t)) continue;
    const accounted = skipped[t] ?? 0;
    if (n > accounted) dropped[t] = n - accounted;
  }
  for (const [t, n] of Object.entries(census.inBlocks)) {
    if (HANDLED.has(t)) continue;
    // Block content is only drawn when inserted; report what exists so the limitation is visible either way.
    dropped[`${t} (inside block definitions)`] = (dropped[`${t} (inside block definitions)`] ?? 0) + n;
  }
  for (const [t, n] of Object.entries(dropped)) skipped[t] = (skipped[t] ?? 0) + n;
  void skippedTotal0;

  const code = num(header.$INSUNITS);
  const issues = [];
  let unit = null; let metresPerUnit = null;
  if (code !== null && INSUNITS[code]) { unit = INSUNITS[code].unit; metresPerUnit = INSUNITS[code].metres; }
  else issues.push(code === null || code === 0 ? 'No drawing units declared ($INSUNITS missing or unitless): scale cannot be established.' : `$INSUNITS code ${code} is not mm/cm/m: scale cannot be established.`);

  const xrefs = Object.entries(blocks).filter(([, b]) => b && (b.xref || b.xrefPath)).map(([n]) => n);
  if (xrefs.length) issues.push(`${xrefs.length} external reference(s) are not resolved: ${xrefs.slice(0, 5).join(', ')}.`);

  const hash = createHash('sha256');
  let ext = null; let delivered = 0; let batchCount = 0;
  const layerNames = [...layerGeo.keys()];
  const total = [...layerGeo.values()].reduce((s, a) => s + a.length, 0);
  const layerStats = [];
  for (const layer of layerNames) {
    const geos = layerGeo.get(layer);
    let ls = 0;
    for (let i = 0; i < geos.length; i += BATCH_ENTITIES) {
      if (shouldStop && (await shouldStop())) return { ok: false, state: 'stopped', error: 'Stopped at a batch boundary; geometry delivered so far is kept.', partial: { delivered, total } };
      const slice = geos.slice(i, i + BATCH_ENTITIES);
      for (const g of slice) { for (const [x, y] of g.points) { ext = ext ? { minX: Math.min(ext.minX, x), minY: Math.min(ext.minY, y), maxX: Math.max(ext.maxX, x), maxY: Math.max(ext.maxY, y) } : { minX: x, minY: y, maxX: x, maxY: y }; } hash.update(`${g.kind}|${g.layer}|${g.points.length}|${g.length}|${g.points[0]}\n`); ls += g.length; }
      delivered += slice.length; batchCount += 1;
      if (onBatch) await onBatch({ layer, batchIndex: Math.floor(i / BATCH_ENTITIES), entities: slice.map(thin), delivered, total, extents: ext, metresPerUnit, unit });
    }
    layerStats.push({ layer, entities: geos.length, lengthUnits: round(ls) });
  }

  const skippedTotal = Object.values(skipped).reduce((s, n) => s + n, 0);
  const complete = issues.length === 0 && skippedTotal === 0 && xrefs.length === 0 && total > 0;
  return {
    ok: true,
    state: complete ? 'read' : 'read_with_limits',
    coverage: {
      complete,
      scope: complete ? 'All entities in this file were of supported types and were processed.' : 'Only the supported geometry types below were processed. This is not a complete reproduction of the CAD content.',
      unit, metresPerUnit, extents: ext, issues,
      layers: layerStats, processedTypes, skippedTypes: skipped, skippedEntityCount: skippedTotal,
      supportedEntityTypes: ['LINE', 'LWPOLYLINE', 'POLYLINE', 'CIRCLE', 'ARC', 'INSERT (expanded)'],
      geometryEntities: total, textEntities: state.textEntities, insertsExpanded: state.expanded, topLevelInserts: inserts,
      unresolvedXrefs: xrefs, batches: batchCount, geometryHash: hash.digest('hex'),
    },
    texts,
  };
}

import type { DrawingEntity, DrawingFile, PathSegment } from './types';
import { extractTitleBlock } from './titleblock';

/** $INSUNITS codes that can be converted to metres. Anything else is reported rather than guessed. */
const INSUNITS: Record<number, { unit: 'mm' | 'cm' | 'm'; metres: number }> = {
  4: { unit: 'mm', metres: 0.001 },
  5: { unit: 'cm', metres: 0.01 },
  6: { unit: 'm', metres: 1 },
};

type Pt = { x: number; y: number };
type Raw = Record<string, unknown>;
type Xf = { a: number; b: number; c: number; d: number; tx: number; ty: number };

const IDENTITY: Xf = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isPt = (v: unknown): v is Pt => !!v && typeof v === 'object' && num((v as Raw).x) !== null && num((v as Raw).y) !== null;
const TWO_PI = Math.PI * 2;
const MAX_BLOCK_DEPTH = 8;

const apply = (m: Xf, p: Pt): Pt => ({ x: m.a * p.x + m.c * p.y + m.tx, y: m.b * p.x + m.d * p.y + m.ty });
const mul = (p: Xf, q: Xf): Xf => ({ a: p.a * q.a + p.c * q.b, b: p.b * q.a + p.d * q.b, c: p.a * q.c + p.c * q.d, d: p.b * q.c + p.d * q.d, tx: p.a * q.tx + p.c * q.ty + p.tx, ty: p.b * q.tx + p.d * q.ty + p.ty });
/** Uniform scale magnitude of a transform, valid for similarity transforms (rotation + uniform scale + translation). */
const detScale = (m: Xf) => Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
const isUniform = (m: Xf) => Math.abs(Math.hypot(m.a, m.b) - Math.hypot(m.c, m.d)) < 1e-9 * Math.max(1, Math.hypot(m.a, m.b));
const isMirrored = (m: Xf) => m.a * m.d - m.b * m.c < 0;

/** Arc through two vertices with a DXF bulge (tan(sweep/4)). Positive bulge = counter-clockwise. */
function bulgeSegment(p1: Pt, p2: Pt, bulge: number): PathSegment {
  const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (!(Math.abs(bulge) > 1e-12) || chord < 1e-12) return { type: 'line', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
  const sweep = 4 * Math.atan(bulge);
  let r = chord / (2 * Math.sin(Math.abs(sweep) / 2));
  const mx = (p1.x + p2.x) / 2; const my = (p1.y + p2.y) / 2;
  const h = r * Math.cos(Math.abs(sweep) / 2);
  const nx = -(p2.y - p1.y) / chord; const ny = (p2.x - p1.x) / chord;
  // h is negative for major arcs (|sweep| > 180°), which moves the centre to the correct side of the chord.
  const side = bulge > 0 ? 1 : -1;
  const cx = mx + nx * h * side;
  const cy = my + ny * h * side;
  return { type: 'arc', cx, cy, r, startAngle: Math.atan2(p1.y - cy, p1.x - cx), endAngle: Math.atan2(p2.y - cy, p2.x - cx), ccw: bulge > 0 };
}

const arcSweep = (s: Extract<PathSegment, { type: 'arc' }>): number => {
  let sw = s.ccw ? s.endAngle - s.startAngle : s.startAngle - s.endAngle;
  while (sw <= 0) sw += TWO_PI;
  while (sw > TWO_PI + 1e-12) sw -= TWO_PI;
  return sw;
};

const segLength = (s: PathSegment): number => (s.type === 'line' ? Math.hypot(s.x2 - s.x1, s.y2 - s.y1) : s.r * arcSweep(s));

/**
 * Shoelace term of a segment (twice the signed area swept from the origin) for its chord, plus twice the circular
 * segment between chord and arc: r²(θ − sin θ), positive when the arc bulges to the left of travel (ccw).
 */
function segCross(s: PathSegment): number {
  if (s.type === 'line') return s.x1 * s.y2 - s.x2 * s.y1;
  let sw = arcSweep(s);
  const dir = s.ccw ? 1 : -1;
  const a1 = s.startAngle + dir * sw;
  const p1 = { x: s.cx + s.r * Math.cos(s.startAngle), y: s.cy + s.r * Math.sin(s.startAngle) };
  const p2 = { x: s.cx + s.r * Math.cos(a1), y: s.cy + s.r * Math.sin(a1) };
  const chordCross = p1.x * p2.y - p2.x * p1.y;
  return chordCross + dir * s.r * s.r * (sw - Math.sin(sw));
}

/** Area of a closed path, including any arcs. */
function pathArea(segs: PathSegment[]): number {
  let total = 0;
  for (const s of segs) total += segCross(s);
  return Math.abs(total) / 2;
}

function arcMid(s: Extract<PathSegment, { type: 'arc' }>): Pt {
  const dir = s.ccw ? 1 : -1; const a = s.startAngle + dir * arcSweep(s) / 2;
  return { x: s.cx + s.r * Math.cos(a), y: s.cy + s.r * Math.sin(a) };
}

function transformSeg(s: PathSegment, m: Xf): PathSegment {
  if (s.type === 'line') { const a = apply(m, { x: s.x1, y: s.y1 }); let b = apply(m, { x: s.x2, y: s.y2 }); return { type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y }; }
  let c = apply(m, { x: s.cx, y: s.cy });
  const rot = Math.atan2(m.b, m.a);
  let k = detScale(m);
  const mirrored = isMirrored(m);
  return { type: 'arc', cx: c.x, cy: c.y, r: s.r * k, startAngle: mirrored ? Math.PI - s.startAngle + rot : s.startAngle + rot, endAngle: mirrored ? Math.PI - s.endAngle + rot : s.endAngle + rot, ccw: mirrored ? !s.ccw : s.ccw };
}

function makeEntity(kind: string, layer: string, handle: string, segs: PathSegment[], vertices: Pt[], closed: boolean, extra: Partial<DrawingEntity> = {}): DrawingEntity {
  const length = segs.reduce((s, x) => s + segLength(x), 0);
  const curved = segs.some((s) => s.type === 'arc');
  return { kind, layer, handle, vertices, closed, length, area: closed && segs.length >= (curved ? 1 : 3) ? pathArea(segs) : 0, segments: segs, curved, ...extra };
}

/** Convert one parsed entity (already in its final coordinate frame via `m`) into measurable entities. Null = unsupported. */
function toEntities(e: Raw, m: Xf, fromBlock: string | undefined, skipped: Record<string, number>, layerOverride?: string): DrawingEntity[] | null {
  const kind = String(e.type ?? '');
  const layer = layerOverride ?? String(e.layer ?? '0');
  const handle = String(e.handle ?? '');
  const extra: Partial<DrawingEntity> = fromBlock ? { fromBlock } : {};
  if (kind === 'LINE' || kind === 'LWPOLYLINE' || kind === 'POLYLINE') {
    const raw = Array.isArray(e.vertices) ? (e.vertices as Raw[]) : [];
    const pts = raw.filter(isPt) as unknown as (Pt & { bulge?: number })[];
    if (pts.length < 2) return null;
    const closed = e.shape === true || e.closed === true;
    const world = pts.map((p) => apply(m, p));
    const segs: PathSegment[] = [];
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i += 1) {
      const a = pts[i]; let b = pts[(i + 1) % pts.length];
      const bulge = num((a as unknown as Raw).bulge) ?? 0;
      const local = bulgeSegment({ x: a.x, y: a.y }, { x: b.x, y: b.y }, bulge);
      segs.push(transformSeg(local, m));
    }
    return [makeEntity(kind, layer, handle, segs, world, closed, extra)];
  }
  if (kind === 'CIRCLE') {
    let c = e.center; let r = num(e.radius);
    if (!isPt(c) || r === null) return null;
    if (!isUniform(m)) { skipped['CIRCLE (non-uniform block scale → ellipse)'] = (skipped['CIRCLE (non-uniform block scale → ellipse)'] ?? 0) + 1; return null; }
    const wc = apply(m, c); const wr = r * detScale(m);
    // A full circle is two half arcs so area/length use the same path code as everything else.
    const segs: PathSegment[] = [
      { type: 'arc', cx: wc.x, cy: wc.y, r: wr, startAngle: 0, endAngle: Math.PI, ccw: true },
      { type: 'arc', cx: wc.x, cy: wc.y, r: wr, startAngle: Math.PI, endAngle: TWO_PI, ccw: true },
    ];
    return [{ kind, layer, handle, vertices: [wc], closed: true, length: TWO_PI * wr, area: Math.PI * wr * wr, segments: segs, radius: wr, curved: true, ...extra }];
  }
  if (kind === 'ARC') {
    let c = e.center; let r = num(e.radius); const s = num(e.startAngle); const en = num(e.endAngle);
    if (!isPt(c) || r === null || s === null || en === null) return null;
    if (!isUniform(m)) { skipped['ARC (non-uniform block scale → elliptical arc)'] = (skipped['ARC (non-uniform block scale → elliptical arc)'] ?? 0) + 1; return null; }
    const seg = transformSeg({ type: 'arc', cx: c.x, cy: c.y, r, startAngle: s, endAngle: en, ccw: true }, m);
    return [{ kind, layer, handle, vertices: [apply(m, c)], closed: false, length: segLength(seg), area: 0, segments: [seg], radius: r * detScale(m), curved: true, ...extra }];
  }
  return null;
}

type Blocks = Record<string, { entities?: Raw[]; position?: Pt }>;

/**
 * Expand an INSERT into real geometry using the block definition, insertion point, rotation, X/Y scale and array
 * repeat. Nested inserts are followed to a fixed depth; anything beyond is reported rather than silently dropped.
 */
function expandInsert(e: Raw, m: Xf, blocks: Blocks, depth: number, out: DrawingEntity[], skipped: Record<string, number>, counter: { n: number }): boolean {
  const name = String(e.name ?? '');
  const def = blocks[name];
  const pos = isPt(e.position) ? e.position : null;
  if (!def || !Array.isArray(def.entities) || !pos) return false;
  if (depth >= MAX_BLOCK_DEPTH) { skipped['INSERT (nesting deeper than 8)'] = (skipped['INSERT (nesting deeper than 8)'] ?? 0) + 1; return true; }
  const sx = num(e.xScale) ?? 1; const sy = num(e.yScale) ?? sx; const rot = ((num(e.rotation) ?? 0) * Math.PI) / 180;
  const cols = Math.max(1, Math.floor(num(e.columnCount) ?? 1)); const rows = Math.max(1, Math.floor(num(e.rowCount) ?? 1));
  const cs = num(e.columnSpacing) ?? 0; const rs = num(e.rowSpacing) ?? 0;
  const base = def.position && isPt(def.position) ? def.position : { x: 0, y: 0 };
  const cos = Math.cos(rot); const sin = Math.sin(rot);
  for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) {
    const local: Xf = { a: cos * sx, b: sin * sx, c: -sin * sy, d: cos * sy, tx: pos.x + cos * c * cs - sin * r * rs, ty: pos.y + sin * c * cs + cos * r * rs };
    const shift: Xf = { a: 1, b: 0, c: 0, d: 1, tx: -base.x, ty: -base.y };
    const full = mul(m, mul(local, shift));
    counter.n += 1;
    for (const be of def.entities) {
      if (be.type === 'INSERT') { if (!expandInsert(be, full, blocks, depth + 1, out, skipped, counter)) skipped[`INSERT of undefined block "${String(be.name ?? '')}"`] = (skipped[`INSERT of undefined block "${String(be.name ?? '')}"`] ?? 0) + 1; continue; }
      if (be.type === 'TEXT' || be.type === 'MTEXT' || be.type === 'ATTRIB' || be.type === 'ATTDEF') continue;
      const ents = toEntities(be, full, name, skipped, String(be.layer ?? '0') === '0' ? String(e.layer ?? '0') : undefined);
      if (ents) { for (let k = 0; k < ents.length; k += 1) out.push(ents[k]); } else skipped[String(be.type ?? 'unknown')] = (skipped[String(be.type ?? 'unknown')] ?? 0) + 1;
    }
  }
  return true;
}

function textOf(e: Raw): string {
  const t = e.text ?? e.string ?? '';
  return typeof t === 'string' ? t.replace(/\\P/g, '\n').replace(/\{?\\[A-Za-z][^;]*;/g, '').replace(/[{}]/g, '') : '';
}

export interface DxfBatchInfo {
  layer: string;
  batchIndex: number;
  entities: DrawingEntity[];
  entityIds: string[];
  extents: { minX: number; minY: number; maxX: number; maxY: number } | null;
  delivered: number;
  total: number;
  metresPerUnit: number | null;
  unit: 'mm' | 'cm' | 'm' | null;
}

export interface DxfProgress {
  (stage: 'parsing' | 'geometry' | 'layer', info: { layer?: string; count?: number; total?: number; detail: string }): void;
}

/** Entities per delivered batch. Large enough to keep message count low, small enough to render progressively. */
export const BATCH_SIZE = 400;

/** Stable id for an entity inside one file: its handle when it has one, otherwise its position in the parse order. */
export const entityId = (e: DrawingEntity, index: number): string => (e.handle ? `h:${e.handle}${e.fromBlock ? `@${e.fromBlock}` : ''}:${index}` : `i:${index}`);

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export interface ReadDxfOptions {
  /** Called with each real batch of parsed geometry. */
  onBatch?: (b: DxfBatchInfo) => void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * Read a real ASCII DXF. Curves keep their true parameters (bulges, arcs, circles), INSERTs are expanded with their
 * transforms, and every entity type that cannot be measured is counted by name so nothing is silently dropped.
 * `onProgress` is called as each stage really completes (used by the live analysis preview). `options.onBatch`
 * receives the parsed geometry in batches. The underlying text parser is synchronous and indivisible, so batches are
 * delivered after parsing returns; the parsing stage is reported as such, not disguised as progressive reading.
 */
export async function readDxf(fileName: string, bytes: Uint8Array, onProgress?: DxfProgress, options: ReadDxfOptions = {}): Promise<DrawingFile> {
  const base: DrawingFile = { fileName, format: 'dxf', state: 'uploaded', limitation: '', titleBlock: null, texts: [], unit: null, unitSource: '', entities: [], layers: [], extents: null, validationIssues: [], metresPerUnit: null };
  const text = new TextDecoder('utf-8').decode(bytes);
  if (/^\s*AutoCAD Binary DXF/.test(text.slice(0, 40)) || text.slice(0, 22) === 'AutoCAD Binary DXF\r\n\u001a') {
    return { ...base, state: 'unsupported', limitation: 'Binary DXF is not supported. Export an ASCII DXF.' };
  }
  let parsed: Raw;
  onProgress?.('parsing', { detail: `Parsing ${(bytes.byteLength / 1024).toFixed(0)} KB of DXF text` });
  try {
    const mod = (await import('dxf-parser')) as unknown as { default?: new () => { parseSync: (s: string) => Raw }; DxfParser?: new () => { parseSync: (s: string) => Raw } };
    const Ctor = mod.default ?? mod.DxfParser;
    if (!Ctor) return { ...base, state: 'failed', limitation: 'The DXF parser could not be loaded.' };
    parsed = new Ctor().parseSync(text);
  } catch (err) {
    return { ...base, state: 'failed', limitation: `The DXF could not be parsed: ${err instanceof Error ? err.message : 'unknown error'}.` };
  }
  if (!parsed || typeof parsed !== 'object') return { ...base, state: 'failed', limitation: 'The DXF contained no readable data.' };

  const header = (parsed.header ?? {}) as Raw;
  const blocks = (parsed.blocks ?? {}) as Blocks;
  const rawEntities = Array.isArray(parsed.entities) ? (parsed.entities as Raw[]) : [];
  const entities: DrawingEntity[] = [];
  const texts: string[] = [];
  const skipped: Record<string, number> = {};
  const counter = { n: 0 };
  for (const e of rawEntities) {
    if (e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'ATTRIB' || e.type === 'ATTDEF') { const t = textOf(e); if (t.trim()) texts.push(t); continue; }
    if (e.type === 'INSERT') {
      const before = entities.length;
      const ok = expandInsert(e, IDENTITY, blocks, 0, entities, skipped, counter);
      const p = e.position;
      // Always keep one countable INSERT marker so block counts (nr) remain exact even when the block has geometry.
      if (isPt(p)) entities.push({ kind: 'INSERT', layer: String(e.layer ?? '0'), handle: String(e.handle ?? ''), vertices: [{ x: p.x, y: p.y }], closed: false, length: 0, area: 0, blockName: String(e.name ?? '') });
      if (!ok) skipped[`INSERT of undefined block "${String(e.name ?? '')}" (counted, no geometry)`] = (skipped[`INSERT of undefined block "${String(e.name ?? '')}" (counted, no geometry)`] ?? 0) + 1;
      void before;
      continue;
    }
    const ents = toEntities(e, IDENTITY, undefined, skipped);
    if (ents) { for (let k = 0; k < ents.length; k += 1) entities.push(ents[k]); } else skipped[String(e.type ?? 'unknown')] = (skipped[String(e.type ?? 'unknown')] ?? 0) + 1;
  }
  // Block-expanded geometry is drawing geometry, but only the explicit marker counts as one block instance.
  const layerCounts: Record<string, number> = {};
  for (const en of entities) layerCounts[en.layer] = (layerCounts[en.layer] ?? 0) + 1;

  const code = num(header.$INSUNITS);
  let unit: DrawingFile['unit'] = null; let unitSource = ''; let metres: number | null = null;
  const issues: string[] = [];
  if (code !== null && INSUNITS[code]) { unit = INSUNITS[code].unit; metres = INSUNITS[code].metres; unitSource = `Drawing header $INSUNITS = ${code} (${unit})`; }
  else if (code !== null && code !== 0) issues.push(`Drawing units code ${code} is not millimetres, centimetres or metres, so lengths cannot be converted to metres.`);
  else issues.push('The drawing does not declare its units ($INSUNITS missing or unitless). Scale cannot be established from the file.');

  // Deliver the real geometry in batches, layer by layer, so a viewer can draw it as it arrives.
  if (options.onBatch) {
    const byLayer = new Map<string, number[]>();
    for (let i = 0; i < entities.length; i += 1) { const l = entities[i].layer; const arr = byLayer.get(l); if (arr) arr.push(i); else byLayer.set(l, [i]); }
    const layerNames = Array.from(byLayer.keys()).sort((a, b) => a.localeCompare(b));
    let delivered = 0;
    for (const layer of layerNames) {
      const idx = byLayer.get(layer) ?? [];
      for (let start = 0, b = 0; start < idx.length; start += BATCH_SIZE, b += 1) {
        if (options.signal?.aborted) return { ...base, state: 'failed', limitation: 'Cancelled.' };
        const slice = idx.slice(start, start + BATCH_SIZE);
        const list = slice.map((i) => entities[i]);
        const pts: Pt[] = [];
        for (const en of list) { const src = en.segments?.length ? curveExtentPoints(en.segments) : en.vertices; for (let k = 0; k < src.length; k += 1) pts.push(src[k]); }
        delivered += list.length;
        await options.onBatch({ layer, batchIndex: b, entities: list, entityIds: slice.map((i) => entityId(entities[i], i)), extents: boundsOf(pts), delivered, total: entities.length, metresPerUnit: metres, unit });
        onProgress?.('layer', { layer, count: Math.min(idx.length, start + BATCH_SIZE), total: idx.length, detail: `Layer ${layer}: ${Math.min(idx.length, start + BATCH_SIZE)} of ${idx.length} entities delivered` });
        await yieldToEventLoop();
      }
    }
  } else {
    Object.entries(layerCounts).sort(([a], [b]) => a.localeCompare(b)).forEach(([layer, count]) => onProgress?.('layer', { layer, count, detail: `Layer ${layer}: ${count} entities available` }));
  }

  if (entities.length === 0) issues.push('No measurable geometry (lines, polylines, circles, arcs or blocks) was found in model space.');
  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
  if (skippedTotal > 0) issues.push(`${skippedTotal} entity(ies) were not measured: ${Object.entries(skipped).map(([k, v]) => `${v} × ${k}`).join(', ')}.`);

  // External references: an XREF block holds geometry that lives in another file. It cannot be measured from this
  // file, so it is a coverage gap and must be visible, not silent.
  const xrefBlocks = Object.entries(blocks).filter(([, b]) => {
    const blk = b as { xrefPath?: string; xref?: string; type?: number };
    return !!(blk.xrefPath || blk.xref || ((blk.type ?? 0) & 4));
  }).map(([n]) => n);
  const unresolvedXrefs = xrefBlocks.filter((n) => !(Array.isArray(blocks[n]?.entities) && (blocks[n]?.entities?.length ?? 0) > 0));
  if (unresolvedXrefs.length) {
    for (const n of unresolvedXrefs) skipped[`XREF "${n}" (external file not supplied)`] = 1;
    issues.push(`${unresolvedXrefs.length} external reference(s) are not resolved: ${unresolvedXrefs.slice(0, 10).join(', ')}. Geometry held in those files is NOT included; upload them or bind the references before exporting.`);
  }
  // Unsupported-but-geometric entity types are a coverage limit, not just a note.
  const GEOMETRIC_UNSUPPORTED = ['SPLINE', 'ELLIPSE', 'HATCH', 'SOLID', '3DFACE', 'MESH', 'DIMENSION', 'LEADER', 'REGION', '3DSOLID', 'BODY', 'IMAGE', 'WIPEOUT'];
  const unsupportedGeometry = Object.entries(skipped).filter(([k]) => GEOMETRIC_UNSUPPORTED.some((g) => k.startsWith(g)));
  const coverageLimited = unresolvedXrefs.length > 0 || unsupportedGeometry.length > 0;
  if (unsupportedGeometry.length) issues.push(`Coverage is limited: ${unsupportedGeometry.map(([k, v]) => `${v} × ${k}`).join(', ')} could not be measured, so quantities from layers containing them may be understated.`);
  if (entities.some((e) => e.curved)) issues.push(`${entities.filter((e) => e.curved).length} curved entity(ies) (arcs, circles, polyline bulges) are measured with their true arc geometry, not as straight chords.`);

  const pts = entities.flatMap((e) => (e.segments?.length ? curveExtentPoints(e.segments) : e.vertices));
  const extents = boundsOf(pts);
  const layers = Array.from(new Set(entities.map((e) => e.layer))).sort();
  const titleBlock = extractTitleBlock(fileName, texts);
  onProgress?.('geometry', { count: entities.length, total: entities.length, detail: `${entities.length} entities on ${layers.length} layer(s) available for drawing` });

  const state = entities.length > 0 ? 'read' : 'failed';
  const hasInvalid = issues.some((i) => /units/i.test(i));
  void hasInvalid;
  return { ...base, state, limitation: state === 'failed' ? issues[issues.length - 1] ?? 'No geometry.' : '', titleBlock, texts, unit, unitSource, entities, layers, extents, validationIssues: issues, metresPerUnit: metres, layerCounts, skippedTypes: skipped, expandedBlocks: counter.n, coverageLimited, unresolvedXrefs };
}

/** Bounds by iteration. `Math.min(...array)` throws RangeError on very large arrays (stack/argument limit). */
export function boundsOf(pts: Pt[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!pts.length) return null;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (let i = 0; i < pts.length; i += 1) {
    const { x, y } = pts[i];
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Extent sample points that include arc cardinal points, so curved extents are not understated. */
function curveExtentPoints(segs: PathSegment[]): Pt[] {
  const out: Pt[] = [];
  for (const s of segs) {
    if (s.type === 'line') { out.push({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }); continue; }
    out.push({ x: s.cx + s.r * Math.cos(s.startAngle), y: s.cy + s.r * Math.sin(s.startAngle) }, { x: s.cx + s.r * Math.cos(s.endAngle), y: s.cy + s.r * Math.sin(s.endAngle) }, arcMid(s));
    for (let k = 0; k < 4; k += 1) {
      const a = (k * Math.PI) / 2; const dir = s.ccw ? 1 : -1; let sw = arcSweep(s);
      let rel = dir * (a - s.startAngle); while (rel < 0) rel += TWO_PI; while (rel >= TWO_PI) rel -= TWO_PI;
      if (rel <= sw) out.push({ x: s.cx + s.r * Math.cos(a), y: s.cy + s.r * Math.sin(a) });
    }
  }
  return out;
}

export { bulgeSegment, pathArea, segLength, arcSweep, curveExtentPoints };

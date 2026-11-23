import { diffEntities, type RelocationInput } from './compare';
import type { ChangeEntityRefs, DrawingEntity, DrawingFile, DrawingPair, PathSegment, ReconciledChange } from './types';
import type { LiveFileGeometry } from './runState';

export type DiffState = 'added' | 'removed' | 'modified' | 'unchanged';
export type Side = 'original' | 'revised';

export interface ViewEntity {
  /** Unique key across both drawings: `side:index`. */
  key: string;
  side: Side;
  handle: string;
  kind: string;
  layer: string;
  state: DiffState;
  /** SVG path data in metres, y already flipped (SVG y goes down). Empty for pure point markers. */
  d: string;
  /** Marker position for INSERT / point entities, metres, y flipped. */
  point: { x: number; y: number } | null;
  /** Bounding box in metres, y flipped. */
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  /** Translation (metres, y already flipped) to apply to `d` so a revised drawing sits in the original's frame. */
  offset?: { x: number; y: number } | null;
  length: number;
  area: number;
  closed: boolean;
  blockName?: string;
  fromBlock?: string;
  curved: boolean;
  /** Ids of the changes that reference this entity (for "select entity → open its change"). */
  changeIds: string[];
}

export interface ViewModel {
  drawingNumber: string;
  originalRevision: string;
  revisedRevision: string;
  originalFile: string;
  revisedFile: string;
  unitSource: string;
  entities: ViewEntity[];
  layers: { name: string; total: number; added: number; removed: number; unchanged: number }[];
  /** Union extent in metres (y flipped). */
  extent: { minX: number; minY: number; maxX: number; maxY: number };
  /** Aspect ratio width/height of the true extent. Very elongated drawings should use detail views. */
  aspect: number;
  elongated: boolean;
  alignmentOk: boolean;
  alignmentNote: string;
  /** Origin shift (metres) applied to the revised drawing, if one was found. */
  originShift: { dx: number; dy: number } | null;
  /** Units, size and coverage of what is drawn, for the status strip. */
  info: { originalUnit: string; revisedUnit: string; originalEntities: number; revisedEntities: number; coverageNotes: string[] };
}

const f = (n: number) => (Math.abs(n) < 1e-9 ? 0 : Number(n.toFixed(4)));

function segPath(s: PathSegment, m: number, first: boolean): string {
  if (s.type === 'line') return `${first ? `M${f(s.x1 * m)} ${f(-s.y1 * m)}` : ''}L${f(s.x2 * m)} ${f(-s.y2 * m)}`;
  const dir = s.ccw ? 1 : -1;
  let sw = s.ccw ? s.endAngle - s.startAngle : s.startAngle - s.endAngle;
  while (sw <= 0) sw += Math.PI * 2;
  const p1 = { x: s.cx + s.r * Math.cos(s.startAngle), y: s.cy + s.r * Math.sin(s.startAngle) };
  const a1 = s.startAngle + dir * sw;
  const p2 = { x: s.cx + s.r * Math.cos(a1), y: s.cy + s.r * Math.sin(a1) };
  const large = sw > Math.PI ? 1 : 0;
  // y is flipped for SVG, so a counter-clockwise arc in drawing space becomes sweep-flag 0.
  const sweepFlag = s.ccw ? 0 : 1;
  return `${first ? `M${f(p1.x * m)} ${f(-p1.y * m)}` : ''}A${f(s.r * m)} ${f(s.r * m)} 0 ${large} ${sweepFlag} ${f(p2.x * m)} ${f(-p2.y * m)}`;
}

function entityPath(e: DrawingEntity, m: number): string {
  if (e.kind === 'INSERT') return '';
  if (e.segments?.length) {
    let d = ''; let prevEnd: { x: number; y: number } | null = null;
    e.segments.forEach((s, i) => {
      const start = s.type === 'line' ? { x: s.x1, y: s.y1 } : { x: s.cx + s.r * Math.cos(s.startAngle), y: s.cy + s.r * Math.sin(s.startAngle) };
      const contiguous = prevEnd && Math.hypot(prevEnd.x - start.x, prevEnd.y - start.y) < 1e-6 * Math.max(1, Math.abs(start.x));
      d += segPath(s, m, i === 0 || !contiguous);
      if (s.type === 'line') prevEnd = { x: s.x2, y: s.y2 };
      else { const dir = s.ccw ? 1 : -1; let sw = s.ccw ? s.endAngle - s.startAngle : s.startAngle - s.endAngle; while (sw <= 0) sw += Math.PI * 2; const a1 = s.startAngle + dir * sw; prevEnd = { x: s.cx + s.r * Math.cos(a1), y: s.cy + s.r * Math.sin(a1) }; }
    });
    return e.closed && e.kind !== 'CIRCLE' ? `${d}Z` : d;
  }
  return e.vertices.length >= 2 ? `M${e.vertices.map((v) => `${f(v.x * m)} ${f(-v.y * m)}`).join('L')}${e.closed ? 'Z' : ''}` : '';
}

function bboxOf(e: DrawingEntity, m: number) {
  let xs: number[] = []; let ys: number[] = [];
  if (e.segments?.length) {
    for (const s of e.segments) {
      if (s.type === 'line') { xs.push(s.x1, s.x2); ys.push(s.y1, s.y2); }
      else {
        // Sample the arc so curved extents are not understated.
        const dir = s.ccw ? 1 : -1; let sw = s.ccw ? s.endAngle - s.startAngle : s.startAngle - s.endAngle; while (sw <= 0) sw += Math.PI * 2;
        for (let k = 0; k <= 16; k += 1) { const a = s.startAngle + dir * sw * (k / 16); xs.push(s.cx + s.r * Math.cos(a)); ys.push(s.cy + s.r * Math.sin(a)); }
      }
    }
  } else { xs = e.vertices.map((v) => v.x); ys = e.vertices.map((v) => v.y); }
  if (!xs.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (let i = 0; i < xs.length; i += 1) { if (xs[i] < minX) minX = xs[i]; if (xs[i] > maxX) maxX = xs[i]; if (ys[i] < minY) minY = ys[i]; if (ys[i] > maxY) maxY = ys[i]; }
  return { minX: minX * m, maxX: maxX * m, minY: -maxY * m, maxY: -minY * m };
}

/**
 * Build the view model from the actual parsed drawings. Added/removed/unchanged states come from the same
 * entity-level comparison that produced the quantities, so the picture can never disagree with the numbers.
 */
export function buildViewModel(pair: DrawingPair, changes: ReconciledChange[], relocationEvidence: RelocationInput = false): ViewModel {
  const mo = pair.original.metresPerUnit ?? 1; const mr = pair.revised.metresPerUnit ?? 1;
  const shift = pair.originShift ? { dx: pair.originShift.dx, dy: pair.originShift.dy } : null;
  const diffs = diffEntities(pair.original, pair.revised, 0.01, relocationEvidence, { shift });
  const addedSet = new Set<DrawingEntity>(); const removedSet = new Set<DrawingEntity>(); const movedSet = new Set<DrawingEntity>();
  for (let d of diffs) {
    d.added.forEach((e) => addedSet.add(e)); d.removed.forEach((e) => removedSet.add(e));
    d.relocated.forEach((p) => { movedSet.add(p.from); movedSet.add(p.to); });
    d.candidatePairs.forEach((p) => { addedSet.add(p.to); removedSet.add(p.from); });
  }
  const refIndex = new Map<string, string[]>();
  for (const c of changes) {
    const r: ChangeEntityRefs | undefined = c.entityRefs;
    if (!r) continue;
    for (const ref of r.original) refIndex.set(`original:${r.layer}:${ref.handle}`, [...(refIndex.get(`original:${r.layer}:${ref.handle}`) ?? []), c.id]);
    for (const ref of r.revised) refIndex.set(`revised:${r.layer}:${ref.handle}`, [...(refIndex.get(`revised:${r.layer}:${ref.handle}`) ?? []), c.id]);
  }
  const entities: ViewEntity[] = [];
  const push = (file: DrawingFile, side: Side, m: number, sh: { dx: number; dy: number } | null) => {
    // SVG y points down, so a shift of +dy in drawing space is -dy on screen.
    const ox = sh?.dx ?? 0; const oy = sh ? -sh.dy : 0;
    file.entities.forEach((e, i) => {
      const state: DiffState = side === 'revised' ? (addedSet.has(e) ? 'added' : movedSet.has(e) ? 'modified' : 'unchanged') : (removedSet.has(e) ? 'removed' : movedSet.has(e) ? 'modified' : 'unchanged');
      const p = e.kind === 'INSERT' ? { x: f(e.vertices[0].x * m + ox), y: f(-(e.vertices[0].y * m) + oy) } : null;
      const bb = p ? { minX: p.x, maxX: p.x, minY: p.y, maxY: p.y } : bboxOf(e, m);
      entities.push({
        key: `${side}:${i}`, side, handle: e.handle, kind: e.kind, layer: e.layer, state, d: entityPath(e, m), point: p,
        bbox: p ? bb : { minX: bb.minX + ox, maxX: bb.maxX + ox, minY: bb.minY + oy, maxY: bb.maxY + oy },
        offset: p ? null : sh ? { x: ox, y: oy } : null,
        length: e.length * m, area: e.area * m * m, closed: e.closed, blockName: e.blockName, fromBlock: e.fromBlock, curved: !!e.curved,
        changeIds: refIndex.get(`${side}:${e.layer}:${e.handle}`) ?? [],
      });
    });
  };
  push(pair.original, 'original', mo, null); push(pair.revised, 'revised', mr, shift);
  const layerMap = new Map<string, { total: number; added: number; removed: number; unchanged: number }>();
  for (const e of entities) {
    const l = layerMap.get(e.layer) ?? { total: 0, added: 0, removed: 0, unchanged: 0 };
    if (e.side === 'revised') { l.total += 1; if (e.state === 'added') l.added += 1; else if (e.state === 'unchanged') l.unchanged += 1; }
    else if (e.state === 'removed') { l.removed += 1; l.total += 1; }
    layerMap.set(e.layer, l);
  }
  const extent = entitiesBox(entities) ?? { minX: 0, maxX: 1, minY: 0, maxY: 1 };
  let w = Math.max(extent.maxX - extent.minX, 1e-6); let h = Math.max(extent.maxY - extent.minY, 1e-6);
  const aspect = w / h;
  const coverageNotes = [pair.original, pair.revised].flatMap((f) => (f.coverageLimited ? [`${f.fileName}: ${f.validationIssues.filter((i) => /external reference|Coverage is limited/.test(i)).join(' ') || 'coverage limited'}`] : []));
  return {
    drawingNumber: pair.revised.titleBlock?.drawingNumber ?? '', originalRevision: pair.original.titleBlock?.revision ?? '', revisedRevision: pair.revised.titleBlock?.revision ?? '',
    originalFile: pair.original.fileName, revisedFile: pair.revised.fileName, unitSource: pair.revised.unitSource,
    entities, layers: Array.from(layerMap.entries()).map(([name, v]) => ({ name, ...v })).sort((a, b) => a.name.localeCompare(b.name)),
    extent, aspect, elongated: aspect > 8 || aspect < 1 / 8,
    alignmentOk: pair.validated, alignmentNote: pair.validated ? (shift ? `Aligned after correcting a drawing-origin shift of (${shift.dx.toFixed(3)} m, ${shift.dy.toFixed(3)} m); units and shared layers validated before measuring.` : 'Units, alignment and shared layers validated before measuring.') : `Alignment unresolved: ${pair.blockers.join(' ')}`,
    originShift: shift,
    info: { originalUnit: pair.original.unit ?? 'unknown', revisedUnit: pair.revised.unit ?? 'unknown', originalEntities: pair.original.entities.length, revisedEntities: pair.revised.entities.length, coverageNotes },
  };
}

/** A light model of geometry received so far in a live run: every entity is shown as "unchanged" (nothing is compared yet). */
export interface LiveModel {
  files: { fileName: string; unit: string; delivered: number; total: number; layers: { name: string; count: number }[]; extent: { minX: number; minY: number; maxX: number; maxY: number } | null; entities: ViewEntity[] }[];
}

export function buildLiveModel(live: Record<string, LiveFileGeometry>): LiveModel {
  const files = Object.values(live).map((f) => {
    const m = f.metresPerUnit ?? 1;
    const entities: ViewEntity[] = [];
    let i = 0;
    for (const layer of f.layerOrder) {
      for (const e of f.layers[layer].entities) {
        const p = e.kind === 'INSERT' ? { x: Number((e.vertices[0].x * m).toFixed(4)), y: Number((-e.vertices[0].y * m).toFixed(4)) } : null;
        entities.push({ key: `live:${f.fileName}:${i}`, side: 'revised', handle: e.handle, kind: e.kind, layer: e.layer, state: 'unchanged', d: entityPath(e, m), point: p, bbox: p ? { minX: p.x, maxX: p.x, minY: p.y, maxY: p.y } : bboxOf(e, m), length: e.length * m, area: e.area * m * m, closed: e.closed, blockName: e.blockName, fromBlock: e.fromBlock, curved: !!e.curved, changeIds: [] });
        i += 1;
      }
    }
    return { fileName: f.fileName, unit: f.unit ?? 'units not yet known', delivered: f.delivered, total: f.total, layers: f.layerOrder.map((n) => ({ name: n, count: f.layers[n].entities.length })), extent: f.extents ? { minX: f.extents.minX * m, maxX: f.extents.maxX * m, minY: -f.extents.maxY * m, maxY: -f.extents.minY * m } : null, entities };
  });
  return { files };
}

export interface Viewport { x: number; y: number; w: number; h: number }

/** A viewport that fits `box` into a canvas of the given pixel size while keeping the true aspect ratio. */
export function fitViewport(box: { minX: number; minY: number; maxX: number; maxY: number }, canvasW: number, canvasH: number, padFrac = 0.06): Viewport {
  const bw = Math.max(box.maxX - box.minX, 1e-6); const bh = Math.max(box.maxY - box.minY, 1e-6);
  const padX = bw * padFrac; const padY = bh * padFrac;
  const needW = bw + padX * 2; const needH = bh + padY * 2;
  const ca = canvasW / Math.max(canvasH, 1);
  let w = needW; let h = needH;
  if (needW / needH > ca) h = needW / ca; else w = needH * ca;
  const cx = (box.minX + box.maxX) / 2; const cy = (box.minY + box.maxY) / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/**
 * Pixel → world transform for an SVG that uses `preserveAspectRatio="xMidYMid meet"`. The drawn area is letterboxed,
 * so the scale is the LARGER of the two ratios and the viewport is centred inside the element.
 */
export function pixelToWorld(vp: Viewport, rect: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number): { x: number; y: number; scale: number } {
  const scale = Math.max(vp.w / Math.max(rect.width, 1e-9), vp.h / Math.max(rect.height, 1e-9));
  const drawnW = vp.w / scale; const drawnH = vp.h / scale;
  const offX = (rect.width - drawnW) / 2; const offY = (rect.height - drawnH) / 2;
  return { x: vp.x + (clientX - rect.left - offX) * scale, y: vp.y + (clientY - rect.top - offY) * scale, scale };
}

/** Zoom about a point given in viewport (world) coordinates. factor > 1 zooms in. */
export function zoomAt(v: Viewport, wx: number, wy: number, factor: number): Viewport {
  let w = v.w / factor; let h = v.h / factor;
  return { x: wx - (wx - v.x) / factor, y: wy - (wy - v.y) / factor, w, h };
}

export function entitiesBox(list: { bbox: { minX: number; minY: number; maxX: number; maxY: number } }[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!list.length) return null;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const e of list) { if (e.bbox.minX < minX) minX = e.bbox.minX; if (e.bbox.maxX > maxX) maxX = e.bbox.maxX; if (e.bbox.minY < minY) minY = e.bbox.minY; if (e.bbox.maxY > maxY) maxY = e.bbox.maxY; }
  return { minX, maxX, minY, maxY };
}

/** Detail windows along the long axis of an elongated drawing, each with a usable aspect ratio and true geometry. */
export function detailWindows(extent: ViewModel['extent'], targetAspect = 3): { label: string; box: ViewModel['extent'] }[] {
  let w = extent.maxX - extent.minX; let h = extent.maxY - extent.minY;
  const horizontal = w >= h;
  const long = horizontal ? w : h; const short = Math.max(horizontal ? h : w, long / 400);
  const n = Math.min(12, Math.max(2, Math.ceil(long / (short * targetAspect))));
  const step = long / n;
  return Array.from({ length: n }, (_, i) => {
    const a = (horizontal ? extent.minX : extent.minY) + i * step; const b = a + step;
    return { label: `Section ${i + 1} of ${n}`, box: horizontal ? { minX: a, maxX: b, minY: extent.minY, maxY: extent.maxY } : { minX: extent.minX, maxX: extent.maxX, minY: a, maxY: b } };
  });
}

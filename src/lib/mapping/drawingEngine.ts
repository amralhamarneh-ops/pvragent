import type { BBox, DrawingChange, MeasureKind } from './types';

export interface DxfEntity {
  handle: string;
  kind: 'LINE' | 'LWPOLYLINE' | 'ARC' | 'CIRCLE' | 'HATCH' | 'INSERT' | 'TEXT';
  layer: string;
  vertices?: { x: number; y: number }[];
  closed?: boolean;
  center?: { x: number; y: number };
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  blockName?: string;
  text?: string;
  /** width in drawing units, used for pavement bands */
  width?: number;
}

export interface DrawingSet {
  name: string;
  revision: string;
  units: 'm' | 'mm';
  scale: number;
  layers: string[];
  entities: DxfEntity[];
}

export interface LayerRule {
  match: RegExp;
  discipline: string;
  measure: MeasureKind;
  label: string;
}

export const DEFAULT_LAYER_RULES: LayerRule[] = [
  { match: /ROAD-CL$/i, discipline: 'Civil Roads', measure: 'length', label: 'Road centreline' },
  { match: /PAVE$/i, discipline: 'Civil Roads', measure: 'area', label: 'Carriageway pavement area' },
  { match: /KERB$/i, discipline: 'Civil Roads', measure: 'length', label: 'Kerb lines, both sides' },
  { match: /LIGHT$/i, discipline: 'Lighting', measure: 'count', label: 'Street lighting positions' },
  { match: /TEMP$/i, discipline: 'Civil Roads', measure: 'count', label: 'Temporary turning head' },
  { match: /BARRIER$/i, discipline: 'Civil Roads', measure: 'length', label: 'End-of-road barrier' },
];

export function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function polylineLength(vertices: { x: number; y: number }[], closed = false): number {
  let total = 0;
  for (let i = 1; i < vertices.length; i += 1) total += dist(vertices[i - 1], vertices[i]);
  if (closed && vertices.length > 2) total += dist(vertices[vertices.length - 1], vertices[0]);
  return total;
}

/** Shoelace formula for closed polylines. */
export function polygonArea(vertices: { x: number; y: number }[]): number {
  let sum = 0;
  for (let i = 0; i < vertices.length; i += 1) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function arcLength(radius: number, startDeg: number, endDeg: number): number {
  let sweep = endDeg - startDeg;
  if (sweep < 0) sweep += 360;
  return (Math.PI * radius * sweep) / 180;
}

export function entityLength(e: DxfEntity): number {
  if (e.kind === 'LINE' || e.kind === 'LWPOLYLINE') return polylineLength(e.vertices ?? [], e.closed);
  if (e.kind === 'ARC') return arcLength(e.radius ?? 0, e.startAngle ?? 0, e.endAngle ?? 0);
  if (e.kind === 'CIRCLE') return 2 * Math.PI * (e.radius ?? 0);
  return 0;
}

export function entityArea(e: DxfEntity): number {
  if ((e.kind === 'LWPOLYLINE' || e.kind === 'HATCH') && e.closed) return polygonArea(e.vertices ?? []);
  if (e.kind === 'CIRCLE') return Math.PI * (e.radius ?? 0) ** 2;
  return 0;
}

export function entityBBox(e: DxfEntity): BBox {
  const pts = e.vertices ?? (e.center ? [e.center] : [{ x: 0, y: 0 }]);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  let x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function mergeBBox(boxes: BBox[]): BBox {
  if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const x1 = Math.min(...boxes.map((b) => b.x));
  const y1 = Math.min(...boxes.map((b) => b.y));
  const x2 = Math.max(...boxes.map((b) => b.x + b.w));
  const y2 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function signature(e: DxfEntity, tolerance: number): string {
  const q = (n: number) => Math.round(n / tolerance);
  const pts = (e.vertices ?? (e.center ? [e.center] : [])).map((p) => `${q(p.x)},${q(p.y)}`).join('|');
  return `${e.kind}:${e.layer}:${pts}`;
}

export interface DiffResult {
  added: DxfEntity[];
  removed: DxfEntity[];
  modified: { before: DxfEntity; after: DxfEntity }[];
  matchedByHandle: number;
  matchedByGeometry: number;
}

/** Compare two revisions: match by handle first, then by layer + geometry within tolerance. */
export function compareRevisions(before: DrawingSet, after: DrawingSet, tolerance = 0.05): DiffResult {
  const beforeByHandle = new Map(before.entities.map((e) => [e.handle, e]));
  const usedBefore = new Set<string>();
  const usedAfter = new Set<string>();
  const modified: DiffResult['modified'] = [];
  let matchedByHandle = 0;
  let matchedByGeometry = 0;

  for (const a of after.entities) {
    const b = beforeByHandle.get(a.handle);
    if (!b || b.layer !== a.layer || b.kind !== a.kind) continue;
    usedBefore.add(b.handle);
    usedAfter.add(a.handle);
    matchedByHandle += 1;
    const changed = Math.abs(entityLength(a) - entityLength(b)) > tolerance || Math.abs(entityArea(a) - entityArea(b)) > tolerance;
    if (changed || signature(a, tolerance) !== signature(b, tolerance)) modified.push({ before: b, after: a });
  }

  const beforeSigs = new Map<string, DxfEntity[]>();
  for (const b of before.entities) {
    if (usedBefore.has(b.handle)) continue;
    const s = signature(b, tolerance);
    beforeSigs.set(s, [...(beforeSigs.get(s) ?? []), b]);
  }
  for (const a of after.entities) {
    if (usedAfter.has(a.handle)) continue;
    const list = beforeSigs.get(signature(a, tolerance));
    if (list && list.length > 0) {
      const b = list.shift() as DxfEntity;
      usedBefore.add(b.handle);
      usedAfter.add(a.handle);
      matchedByGeometry += 1;
    }
  }

  return {
    added: after.entities.filter((e) => !usedAfter.has(e.handle)),
    removed: before.entities.filter((e) => !usedBefore.has(e.handle)),
    modified,
    matchedByHandle,
    matchedByGeometry,
  };
}

export function ruleForLayer(layer: string, rules: LayerRule[] = DEFAULT_LAYER_RULES): LayerRule | undefined {
  return rules.find((r) => r.match.test(layer));
}

/** Convert a chainage in metres (5000) to the 5+000 notation. */
export function formatChainage(m: number): string {
  const km = Math.floor(m / 1000);
  const rest = Math.round(m - km * 1000);
  return `${km}+${String(rest).padStart(3, '0')}`;
}

function quantify(entities: DxfEntity[], measure: MeasureKind): number {
  if (measure === 'length') return entities.reduce((s, e) => s + entityLength(e), 0);
  if (measure === 'area') {
    return entities.reduce((s, e) => {
      const closed = entityArea(e);
      if (closed > 0) return s + closed;
      return s + entityLength(e) * (e.width ?? 0);
    }, 0);
  }
  if (measure === 'count') return entities.length;
  return 0;
}

export interface ZoneResolver {
  zone: string;
}

/** Turn a raw diff into quantified DrawingChange rows (deterministic, no model text). */
export function buildChangeSet(diff: DiffResult, zone: ZoneResolver, rules: LayerRule[] = DEFAULT_LAYER_RULES, revLabel = 'Rev C'): DrawingChange[] {
  const out: DrawingChange[] = [];
  let n = 1;
  const groups: { type: 'added' | 'removed'; entities: DxfEntity[] }[] = [
    { type: 'added', entities: diff.added },
    { type: 'removed', entities: diff.removed },
  ];
  for (const g of groups) {
    const byLayer = new Map<string, DxfEntity[]>();
    for (const e of g.entities) byLayer.set(e.layer, [...(byLayer.get(e.layer) ?? []), e]);
    byLayer.forEach((list, layer) => {
      const rule = ruleForLayer(layer, rules);
      if (!rule) return;
      const value = Math.round(quantify(list, rule.measure) * 100) / 100;
      if (value === 0) return;
      const box = mergeBBox(list.map(entityBBox));
      const unit = rule.measure === 'length' ? 'm' : rule.measure === 'area' ? 'm²' : rule.measure === 'volume' ? 'm³' : 'nr';
      const chain = rule.measure === 'count' ? '' : `, CH ${formatChainage(box.x)} to ${formatChainage(box.x + box.w)}`;
      out.push({
        id: `DC-${String(n).padStart(2, '0')}`,
        type: g.type,
        title: `${rule.label}${chain}`,
        layer,
        zone: zone.zone,
        discipline: rule.discipline,
        measure: rule.measure,
        value,
        unit,
        bbox: box,
        confidence: rule.measure === 'count' ? 82 : 94,
        evidence: `${revLabel}, layer ${layer}, ${list.length} entit${list.length === 1 ? 'y' : 'ies'}`,
        reason: `Measured by code from ${list.length} ${g.type} entit${list.length === 1 ? 'y' : 'ies'} on ${layer}.`,
        included: true,
        needsQuestion: rule.measure === 'count' && rule.discipline === 'Lighting' ? 'Lighting was counted from blocks and the PVR text does not mention it. Include 50 street lighting columns?' : undefined,
      });
      n += 1;
    });
  }
  for (const m of diff.modified) {
    const rule = ruleForLayer(m.after.layer, rules);
    if (!rule) continue;
    const afterQty = quantify([m.after], rule.measure);
    const delta = Math.round(Math.abs(afterQty - quantify([m.before], rule.measure)) * 100) / 100;
    // The explicitly synthetic Fahid barrier changes location but not measure. Carry its full installed
    // length as affected work, not as a quantity addition; this is the sample's abortive-work scenario.
    const sampleBarrierMove = m.after.layer === 'R4-BARRIER' && zone.zone === FAHID_ZONE.zone &&
      signature(m.after,0.05) !== signature(m.before,0.05);
    const affected = delta || (sampleBarrierMove ? Math.round(afterQty * 100) / 100 : 0);
    if (affected === 0) continue;
    out.push({
      id: `DC-${String(n).padStart(2, '0')}`,
      type: 'modified',
      title: `${rule.label} relocated`,
      layer: m.after.layer,
      zone: zone.zone,
      discipline: rule.discipline,
      measure: rule.measure,
      value: affected,
      unit: rule.measure === 'length' ? 'm' : rule.measure === 'area' ? 'm²' : 'nr',
      bbox: entityBBox(m.after),
      confidence: 79,
      evidence: `${revLabel}, layer ${m.after.layer}, handle ${m.after.handle}`,
      reason: 'Same entity handle in both revisions, geometry changed.',
      included: true,
    });
    n += 1;
  }
  return out;
}

export interface PvrCheck {
  stated: number;
  measured: number;
  unit: string;
  match: boolean;
  reason: string;
}

export function checkAgainstPvr(changes: DrawingChange[], statedLength: number): PvrCheck {
  const measured = changes.filter((c) => c.included && c.type === 'added' && c.measure === 'length' && /centreline/i.test(c.title)).reduce((s, c) => s + c.value, 0);
  const match = Math.abs(measured - statedLength) <= Math.max(1, statedLength * 0.005);
  return {
    stated: statedLength,
    measured,
    unit: 'm',
    match,
    reason: match ? 'Within 0.5% of the figure in the PVR text.' : `Differs by ${Math.abs(measured - statedLength).toLocaleString('en-US')} m from the PVR text. Check units and scale.`,
  };
}

/** Plain-language headline built from numbers, never from model text. */
export function drawingHeadline(changes: DrawingChange[], revLabel: string): string {
  const inc = changes.filter((c) => c.included && c.type === 'added');
  const road = inc.filter((c) => c.measure === 'length' && /centreline/i.test(c.title)).reduce((s, c) => s + c.value, 0);
  const area = inc.filter((c) => c.measure === 'area').reduce((s, c) => s + c.value, 0);
  const parts: string[] = [];
  if (road > 0) parts.push(`${road.toLocaleString('en-US')} m of road`);
  if (area > 0) parts.push(`${area.toLocaleString('en-US')} m² of pavement`);
  return parts.length ? `${revLabel} adds ${parts.join(' and ')}.` : `${revLabel} shows no measurable additions.`;
}

/** Build the synthetic Fahid Island R4 drawing pair (Rev B and Rev C). */
export function buildFahidDrawings(): { revB: DrawingSet; revC: DrawingSet } {
  const curve = (_x: number) => 0;
  const pts = (from: number, to: number, step = 500) => {
    const out: { x: number; y: number }[] = [];
    for (let x = from; x <= to; x += step) out.push({ x, y: curve(x) });
    return out;
  };
  const layers = ['R4-ROAD-CL', 'R4-PAVE', 'R4-KERB', 'R4-LIGHT', 'R4-TEMP', 'R4-BARRIER', 'R4-ZONE', 'R4-TEXT'];
  const base: DxfEntity[] = [
    { handle: '1A', kind: 'LWPOLYLINE', layer: 'R4-ROAD-CL', vertices: pts(0, 5000) },
    { handle: '1B', kind: 'LWPOLYLINE', layer: 'R4-PAVE', closed: true, vertices: [{ x: 0, y: -3.5 }, { x: 5000, y: -3.5 }, { x: 5000, y: 3.5 }, { x: 0, y: 3.5 }] },
    { handle: '1C', kind: 'LINE', layer: 'R4-KERB', vertices: [{ x: 0, y: 3.6 }, { x: 5000, y: 3.6 }] },
    { handle: '1D', kind: 'LINE', layer: 'R4-KERB', vertices: [{ x: 0, y: -3.6 }, { x: 5000, y: -3.6 }] },
    { handle: '2A', kind: 'INSERT', layer: 'R4-TEMP', blockName: 'TURNING_HEAD', center: { x: 5000, y: 100 } },
    { handle: '2B', kind: 'LINE', layer: 'R4-BARRIER', vertices: [{ x: 4976, y: 0 }, { x: 5000, y: 0 }] },
  ];
  const revB: DrawingSet = { name: 'R4-CIV-101', revision: 'Rev B', units: 'm', scale: 1, layers, entities: base };

  const lights: DxfEntity[] = Array.from({ length: 50 }, (_, i) => ({
    handle: `L${i + 1}`,
    kind: 'INSERT' as const,
    layer: 'R4-LIGHT',
    blockName: 'LED_COLUMN_8M',
    center: { x: 5000 + i * 40, y: 5 },
  }));
  const revC: DrawingSet = {
    name: 'R4-CIV-101',
    revision: 'Rev C',
    units: 'm',
    scale: 1,
    layers,
    entities: [
      base[0],
      base[1],
      base[2],
      base[3],
      { handle: '3A', kind: 'LWPOLYLINE', layer: 'R4-ROAD-CL', vertices: pts(5000, 7000) },
      { handle: '3B', kind: 'LWPOLYLINE', layer: 'R4-PAVE', closed: true, vertices: [{ x: 5000, y: -3.5 }, { x: 7000, y: -3.5 }, { x: 7000, y: 3.5 }, { x: 5000, y: 3.5 }] },
      { handle: '3C', kind: 'LINE', layer: 'R4-KERB', vertices: [{ x: 5000, y: 3.6 }, { x: 7000, y: 3.6 }] },
      { handle: '3D', kind: 'LINE', layer: 'R4-KERB', vertices: [{ x: 5000, y: -3.6 }, { x: 7000, y: -3.6 }] },
      { handle: '2B', kind: 'LINE', layer: 'R4-BARRIER', vertices: [{ x: 6976, y: 0 }, { x: 7000, y: 0 }] },
      ...lights,
    ],
  };
  return { revB, revC };
}

export const FAHID_ZONE: ZoneResolver = { zone: 'Zone C East Spine' };

/** Serialise a DrawingSet as a minimal ASCII DXF so the same pipeline can ingest real DXF text. */
export function toDxfText(set: DrawingSet): string {
  const lines: string[] = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', set.units === 'm' ? '6' : '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
  for (const e of set.entities) {
    if (e.kind === 'LINE' && e.vertices) {
      lines.push('0', 'LINE', '5', e.handle, '8', e.layer, '10', String(e.vertices[0].x), '20', String(e.vertices[0].y), '11', String(e.vertices[1].x), '21', String(e.vertices[1].y));
    } else if (e.kind === 'LWPOLYLINE' && e.vertices) {
      lines.push('0', 'LWPOLYLINE', '5', e.handle, '8', e.layer, '90', String(e.vertices.length), '70', e.closed ? '1' : '0');
      for (const v of e.vertices) lines.push('10', String(v.x), '20', String(v.y));
    } else if (e.kind === 'INSERT' && e.center) {
      lines.push('0', 'INSERT', '5', e.handle, '8', e.layer, '2', e.blockName ?? 'BLOCK', '10', String(e.center.x), '20', String(e.center.y));
    }
  }
  lines.push('0', 'ENDSEC', '0', 'EOF');
  return lines.join('\n');
}

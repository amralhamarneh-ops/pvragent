import { compareRevisions } from './titleblock';
import type { AnalysisQuestion, DrawingEntity, DrawingFile, DrawingPair, MeasuredChange, RelocationEvidence } from './types';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Exclude explicit presentation layers, not physical layers merely containing a word such as "detail". */
export function isPresentationLayer(layer: string): boolean {
  const parts = layer.split(/[|$]/).map(norm);
  return parts.some((p) => /(?:^| )(?:anno(?:tation)?s?|title ?block|viewport|legend|sheet border|drawing frame)(?: |$)/.test(p));
}

/** A typical detail documents configuration, not installation extents. Use the sheet title, not an incidental note. */
export function isDetailOnlyTitle(rawTitle: string): boolean {
  const title = norm(rawTitle);
  return /\btypical (?:detail|details|section|sections|assembly|assemblies)\b|\b(?:front|side|sectional) (?:view|elevation)\b/.test(title)
    && !/\b(?:alignment|chainage|layout(?: plan)?|site plan|location plan|setting out)\b/.test(title);
}

export function isDetailOnlyDrawing(file: DrawingFile): boolean {
  return !!file.detailOnlyEvidence || isDetailOnlyTitle(file.titleBlock?.title ?? '');
}

function unboundedLimits(drawing: DrawingFile): string[] {
  return (drawing.unboundedCoverageGaps ?? []).filter(({ layer }) => !isPresentationLayer(layer)).map(({ layer, reason }) => `${reason} on layer ${layer}`);
}

function titleSimilarity(a: string, b: string): number {
  const x = new Set(norm(a).split(' ').filter((w) => w.length > 2));
  const y = new Set(norm(b).split(' ').filter((w) => w.length > 2));
  if (x.size === 0 || y.size === 0) return 0;
  let hit = 0; x.forEach((w) => { if (y.has(w)) hit += 1; });
  return hit / Math.max(x.size, y.size);
}

export interface PairingOutcome {
  pairs: DrawingPair[];
  questions: AnalysisQuestion[];
  /** Drawings that could not be paired, with the reason. */
  unpaired: { fileName: string; reason: string }[];
}

/**
 * Pair drawings by content. Two files form a pair only when they carry the same drawing number (read from the
 * drawing text, or the file name when the text has none) and different revisions. Anything else is a question,
 * never an assumption.
 */
export function pairDrawings(files: DrawingFile[]): PairingOutcome {
  const usable = files.filter((f) => f.state === 'read' || f.state === 'validated');
  const pairs: DrawingPair[] = [];
  const questions: AnalysisQuestion[] = [];
  const unpaired: PairingOutcome['unpaired'] = [];
  const groups = new Map<string, DrawingFile[]>();
  const noNumber: DrawingFile[] = [];
  for (const f of usable) {
    const n = f.titleBlock?.drawingNumber ?? '';
    if (!n) { noNumber.push(f); continue; }
    const key = n.toUpperCase().replace(/_/g, '-');
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }

  groups.forEach((list, number) => {
    if (list.length === 1) { unpaired.push({ fileName: list[0].fileName, reason: `Only one file carries drawing number ${number}. Add its other revision to compare.` }); return; }
    const withRev = list.filter((f) => f.titleBlock?.revision);
    if (list.length > 2) {
      questions.push({ id: `pair-${number}`, kind: 'pairing', blocksComparison: true, title: `Which two revisions of ${number} should be compared?`, issue: `${list.length} files carry drawing number ${number}.`, evidence: list.map((f) => `${f.fileName}: revision ${f.titleBlock?.revision || 'not found'}`), proposal: 'Choose the original and the revised file.', options: list.map((f) => ({ id: f.fileName, label: f.fileName })) });
      list.forEach((f) => unpaired.push({ fileName: f.fileName, reason: `More than two files share drawing number ${number}.` }));
      return;
    }
    const [a, b] = list;
    const basis = [`Same drawing number ${number} read from ${a.titleBlock?.provenance.drawingNumber.startsWith('Drawing text') ? 'the drawing text' : 'the file name'}.`];
    if (withRev.length < 2) {
      questions.push({ id: `rev-${number}`, kind: 'revision_order', blocksComparison: true, title: `Which of these is the original and which is the revision?`, issue: `A revision label could not be read from ${withRev.length === 0 ? 'either' : 'one'} of the two files for drawing ${number}.`, evidence: [a, b].map((f) => `${f.fileName}: revision ${f.titleBlock?.revision || 'not found'}`), proposal: 'Order cannot be established from the contents.', options: [{ id: `${a.fileName}|${b.fileName}`, label: `Original: ${a.fileName}` }, { id: `${b.fileName}|${a.fileName}`, label: `Original: ${b.fileName}` }] });
      unpaired.push({ fileName: a.fileName, reason: 'Revision order unresolved.' }, { fileName: b.fileName, reason: 'Revision order unresolved.' });
      return;
    }
    const order = compareRevisions(a.titleBlock!.revision, b.titleBlock!.revision);
    if (order === 0 || order === null) {
      questions.push({ id: `rev-${number}`, kind: 'revision_order', blocksComparison: true, title: `Which of these is the original and which is the revision?`, issue: order === 0 ? `Both files are revision ${a.titleBlock!.revision} of ${number}.` : `Revisions ${a.titleBlock!.revision} and ${b.titleBlock!.revision} cannot be put in order automatically.`, evidence: [a, b].map((f) => `${f.fileName}: revision ${f.titleBlock?.revision}`), proposal: 'Choose which is later.', options: [{ id: `${a.fileName}|${b.fileName}`, label: `Original: ${a.fileName}` }, { id: `${b.fileName}|${a.fileName}`, label: `Original: ${b.fileName}` }] });
      unpaired.push({ fileName: a.fileName, reason: 'Revision order unresolved.' }, { fileName: b.fileName, reason: 'Revision order unresolved.' });
      return;
    }
    const [original, revised] = order === 1 ? [b, a] : [a, b];
    basis.push(`Revision ${original.titleBlock!.revision} → ${revised.titleBlock!.revision} (${original.titleBlock!.provenance.revision.startsWith('Drawing text') && revised.titleBlock!.provenance.revision.startsWith('Drawing text') ? 'read from the drawing text' : 'at least one read from the file name'}).`);
    const sim = titleSimilarity(original.titleBlock!.title, revised.titleBlock!.title);
    if (original.titleBlock!.title && revised.titleBlock!.title) basis.push(`Titles ${sim >= 0.5 ? 'agree' : 'differ'}: “${original.titleBlock!.title}” / “${revised.titleBlock!.title}”.`);
    // Same number but clearly different titles: the contents do not support calling these revisions of one drawing.
    if (original.titleBlock!.title && revised.titleBlock!.title && sim < 0.2) {
      questions.push({ id: `title-${number}`, kind: 'pairing', blocksComparison: true, title: `Are these two revisions of the same drawing?`, issue: `Both files carry drawing number ${number} but their titles differ: “${original.titleBlock!.title}” and “${revised.titleBlock!.title}”.`, evidence: [`${original.fileName}: revision ${original.titleBlock!.revision}`, `${revised.fileName}: revision ${revised.titleBlock!.revision}`], proposal: 'Confirm the pairing before any difference is measured.', options: [{ id: `${original.fileName}|${revised.fileName}`, label: `Yes, original ${original.fileName} → revised ${revised.fileName}` }, { id: `${revised.fileName}|${original.fileName}`, label: `Yes, but the order is reversed` }] });
      unpaired.push({ fileName: original.fileName, reason: 'Titles differ; pairing needs confirmation.' }, { fileName: revised.fileName, reason: 'Titles differ; pairing needs confirmation.' });
      return;
    }
    pairs.push(validatePair({ original, revised, basis, validated: false, blockers: [] }));
  });

  for (const f of noNumber) {
    unpaired.push({ fileName: f.fileName, reason: 'No drawing number could be read from the drawing text or file name, so it cannot be paired.' });
  }
  if (noNumber.length >= 2) {
    questions.push({ id: 'pair-unnumbered', kind: 'pairing', blocksComparison: true, title: 'Which drawings belong together?', issue: 'No drawing number could be read from these drawings, so the contents cannot establish which is a revision of which.', evidence: noNumber.map((f) => f.fileName), proposal: 'Name the original and the revised drawing.', options: noNumber.flatMap((a) => noNumber.filter((b) => b !== a).map((b) => ({ id: `${a.fileName}|${b.fileName}`, label: `Original ${a.fileName} → Revised ${b.fileName}` }))) });
  }
  return { pairs, questions, unpaired };
}

/** Validate units, scale, alignment and coverage before any measuring. Blockers stop measurement. */
export function validatePair(p: DrawingPair): DrawingPair {
  const blockers: string[] = [];
  const { original: o, revised: r } = p;
  for (const f of [o, r]) {
    if (isDetailOnlyDrawing(f)) blockers.push(`${f.fileName}: typical detail/elevation layout shows configuration, not installed extent. Supply an alignment/layout or chainage schedule.`);
    const gaps = unboundedLimits(f);
    if (gaps.length) blockers.push(`${f.fileName}: coverage incomplete; ${gaps.slice(0, 5).join('; ')}${gaps.length > 5 ? ` and ${gaps.length - 5} more` : ''}. Bind or supply the referenced model geometry and re-export.`);
    if (f.metresPerUnit === null) blockers.push(`${f.fileName}: ${f.validationIssues.find((i) => /units/i.test(i)) ?? 'units are not established'}`);
  }
  if (o.metresPerUnit !== null && r.metresPerUnit !== null && o.metresPerUnit !== r.metresPerUnit) blockers.push(`The two drawings use different units (${o.unit} and ${r.unit}), so they are not directly comparable until the units are confirmed.`);
  let originShift: OriginShift | null = null;
  if (o.extents && r.extents && o.metresPerUnit !== null && r.metresPerUnit !== null) {
    // Alignment: the shared geometry must overlap in the same coordinate frame.
    const ox = (o.extents.maxX - o.extents.minX) * o.metresPerUnit; const oy = (o.extents.maxY - o.extents.minY) * o.metresPerUnit;
    const rx = (r.extents.maxX - r.extents.minX) * r.metresPerUnit; const ry = (r.extents.maxY - r.extents.minY) * r.metresPerUnit;
    const overlapX = Math.min(o.extents.maxX * o.metresPerUnit, r.extents.maxX * r.metresPerUnit) - Math.max(o.extents.minX * o.metresPerUnit, r.extents.minX * r.metresPerUnit);
    const overlapY = Math.min(o.extents.maxY * o.metresPerUnit, r.extents.maxY * r.metresPerUnit) - Math.max(o.extents.minY * o.metresPerUnit, r.extents.minY * r.metresPerUnit);
    const minW = Math.max(Math.min(ox, rx), 1e-9); const minH = Math.max(Math.min(oy, ry), 1e-9);
    const poorOverlap = overlapX < 0 || overlapY < 0 || (overlapX < 0.2 * minW && overlapY < 0.2 * minH);
    // Before treating a poor overlap as "not the same drawing", test whether the content is the same but translated.
    originShift = estimateOriginShift(o, r);
    if (poorOverlap && !originShift?.accepted) blockers.push('The two drawings do not overlap in the same coordinate frame, so they are not aligned. Differences would be meaningless.');
  } else originShift = estimateOriginShift(o, r);
  const oLayers = new Set(o.layers); const shared = r.layers.filter((l) => oLayers.has(l));
  if (shared.length === 0) blockers.push('The two drawings share no layers, so corresponding content cannot be identified.');
  return { ...p, blockers, validated: blockers.length === 0, originShift: originShift?.accepted ? { dx: originShift.dx, dy: originShift.dy, matched: originShift.matched, of: originShift.of } : null };
}

export interface OriginShift { dx: number; dy: number; matched: number; of: number; accepted: boolean }

/**
 * Detect a pure translation between the two drawings (a changed drawing origin). Candidate offsets are voted from the
 * vertices of distinct anchor elements; an offset is accepted only if it makes a clear majority of the original's
 * elements coincide with revised elements. The offset is in metres, applied to the revised drawing.
 */
export function estimateOriginShift(o: DrawingFile, r: DrawingFile, tolM = 0.01): OriginShift | null {
  const mo = o.metresPerUnit; const mr = r.metresPerUnit;
  if (mo === null || mr === null || !o.entities.length || !r.entities.length) return null;
  const anchor = (e: DrawingEntity, m: number) => (e.vertices[0] ? { x: e.vertices[0].x * m, y: e.vertices[0].y * m } : null);
  const key = (e: DrawingEntity) => `${e.layer}|${e.kind}|${e.blockName ?? ''}|${e.vertices.length}|${Math.round(sizeOf(e) * (e.area > 0 ? mo * mo : mo) * 100)}`;
  const byKey = new Map<string, DrawingEntity[]>();
  for (const e of r.entities) { const k = `${e.layer}|${e.kind}|${e.blockName ?? ''}|${e.vertices.length}|${Math.round(sizeOf(e) * (e.area > 0 ? mr * mr : mr) * 100)}`; const a = byKey.get(k); if (a) a.push(e); else byKey.set(k, [e]); }
  const votes = new Map<string, { dx: number; dy: number; n: number }>();
  const sample = o.entities.length > 400 ? o.entities.filter((_, i) => i % Math.ceil(o.entities.length / 400) === 0) : o.entities;
  for (const e of sample) {
    const cands = byKey.get(key(e)); const a = anchor(e, mo);
    if (!cands || !a || cands.length > 6) continue;
    for (const c of cands) {
      const b = anchor(c, mr); if (!b) continue;
      const dx = a.x - b.x; const dy = a.y - b.y;
      const k = `${Math.round(dx / tolM)}|${Math.round(dy / tolM)}`;
      const v = votes.get(k); if (v) v.n += 1; else votes.set(k, { dx, dy, n: 1 });
    }
  }
  let best: { dx: number; dy: number; n: number } | null = null;
  votes.forEach((v) => { if (!best || v.n > best.n) best = v; });
  if (!best) return null;
  const b: { dx: number; dy: number; n: number } = best;
  if (Math.abs(b.dx) < tolM && Math.abs(b.dy) < tolM) return { dx: 0, dy: 0, matched: b.n, of: sample.length, accepted: false };
  // Verify the offset: count sampled original elements that coincide with a revised element once the revised
  // drawing is moved by (dx, dy) into the original's frame.
  const rs = new Set<string>();
  for (const e of r.entities) rs.add(entitySig(e, mr, tolM, b.dx, b.dy));
  let matched = 0;
  for (const e of sample) if (rs.has(entitySig(e, mo, tolM, 0, 0))) matched += 1;
  const accepted = matched >= Math.max(3, Math.ceil(0.6 * sample.length));
  return { dx: b.dx, dy: b.dy, matched, of: sample.length, accepted };
}

function entitySig(e: DrawingEntity, mpu: number, tolM: number, sx: number, sy: number): string {
  const q = (n: number, s: number) => Math.round((n * mpu + s) / tolM);
  const pts = e.vertices.map((v) => `${q(v.x, sx)},${q(v.y, sy)}`);
  const fwd = pts.join(';'); const rev = [...pts].reverse().join(';');
  return `${e.layer}|${e.kind}|${e.blockName ?? ''}|${e.closed ? 'c' : 'o'}|${fwd < rev ? fwd : rev}`;
}

const round = (n: number, dp = 3) => Number(n.toFixed(dp));
const fmt = (n: number) => String(round(n));

interface LayerTotals { length: number; area: number; count: number; entities: DrawingEntity[] }

function totals(f: DrawingFile): Map<string, LayerTotals> {
  const m = new Map<string, LayerTotals>();
  const mpu = f.metresPerUnit ?? 1;
  for (const e of f.entities) {
    const t = m.get(e.layer) ?? { length: 0, area: 0, count: 0, entities: [] };
    t.length += e.length * mpu; t.area += e.area * mpu * mpu;
    if (e.kind === 'INSERT') t.count += 1;
    t.entities.push(e);
    m.set(e.layer, t);
  }
  return m;
}

/**
 * Layer name → the quantity kind that is meaningful for it. INSERT markers give a block count (nr). Geometry that
 * only exists because a block was expanded is not additionally measured as length/area on a layer that is a block
 * count layer, so the same block is never reported twice.
 */
function kindFor(t: LayerTotals): 'nr' | 'm2' | 'm' | null {
  const inserts = t.entities.filter((e) => e.kind === 'INSERT').length;
  const direct = t.entities.filter((e) => e.kind !== 'INSERT' && !e.fromBlock);
  if (inserts > 0 && direct.length === 0) return 'nr';
  const geom = t.entities.filter((e) => e.kind !== 'INSERT');
  const closed = geom.filter((e) => e.closed && e.area > 0).length;
  if (geom.length > 0 && closed === geom.length) return 'm2';
  if (t.length > 0) return 'm';
  return null;
}

function centroid(f: DrawingFile, layer: string): string {
  const pts = f.entities.filter((e) => e.layer === layer).flatMap((e) => e.vertices);
  if (!pts.length || f.metresPerUnit === null) return '';
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length * f.metresPerUnit;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length * f.metresPerUnit;
  return `near (${fmt(cx)} m, ${fmt(cy)} m) in drawing coordinates`;
}

export interface MeasureOutcome { changes: MeasuredChange[]; notes: string[] }

/** Entities are the same physical element when kind, layer and geometry agree within tolerance (in metres). `sx`/`sy` shift revised coordinates (metres) into the original's frame. */
function signature(e: DrawingEntity, mpu: number, tolM: number, sx = 0, sy = 0): string {
  const qx = (n: number) => Math.round((n * mpu + sx) / tolM);
  const qy = (n: number) => Math.round((n * mpu + sy) / tolM);
  const q = (n: number) => Math.round((n * mpu) / tolM);
  if (e.kind === 'INSERT') return `${e.layer}|INSERT|${e.blockName ?? ''}|${qx(e.vertices[0].x)},${qy(e.vertices[0].y)}`;
  // Curves are part of the identity: same end points but a different arc is a different element.
  if (e.segments?.length) {
    const parts = e.segments.map((s) => (s.type === 'line' ? `L${qx(s.x1)},${qy(s.y1)}>${qx(s.x2)},${qy(s.y2)}` : `A${qx(s.cx)},${qy(s.cy)}r${q(s.r)}a${Math.round(s.startAngle * 1000)}:${Math.round(s.endAngle * 1000)}${s.ccw ? '+' : '-'}`));
    if (e.kind === 'CIRCLE') return `${e.layer}|CIRCLE|${qx(e.vertices[0].x)},${qy(e.vertices[0].y)}r${q(e.radius ?? 0)}`;
    if (e.segments.every((s) => s.type === 'line')) {
      const pts = e.vertices.map((v) => `${qx(v.x)},${qy(v.y)}`);
      const fwd = pts.join(';'); const rev = [...pts].reverse().join(';');
      return `${e.layer}|${e.kind}|${e.closed ? 'c' : 'o'}|${fwd < rev ? fwd : rev}`;
    }
    return `${e.layer}|${e.kind}|${e.closed ? 'c' : 'o'}|${parts.join(';')}`;
  }
  const pts = e.vertices.map((v) => `${qx(v.x)},${qy(v.y)}`);
  const fwd = pts.join(';'); const rev = [...pts].reverse().join(';');
  return `${e.layer}|${e.kind}|${e.closed ? 'c' : 'o'}|${fwd < rev ? fwd : rev}`;
}

export interface EntityDiff {
  layer: string;
  added: DrawingEntity[];
  removed: DrawingEntity[];
  /**
   * Same kind and layer and equal size. A size match alone is NOT evidence of relocation: these are held as
   * candidates and reported as unconfirmed pairings (an addition and an omission) until correspondence evidence
   * (instruction text naming a relocation) confirms them.
   */
  candidatePairs: { from: DrawingEntity; to: DrawingEntity }[];
  /** Pairs confirmed as relocations by correspondence/PVR evidence. Empty unless `relocationEvidence` is supplied. */
  relocated: { from: DrawingEntity; to: DrawingEntity }[];
  /** For each confirmed relocation, the statement that named this object. Present only for per-object evidence. */
  relocationEvidence?: RelocationEvidence | null;
  /** Candidates where more than one removed element could correspond to one added element (or the reverse). */
  ambiguous?: { added: number; removed: number; reason: string }[];
}

const sizeOf = (e: DrawingEntity) => (e.area > 0 ? e.area : e.length);
const RELOCATION_WORDS = /\b(reloca\w*|re-?align\w*|re-?rout\w*|shift\w*|moved?|diver\w+|re-?position\w*)\b/i;

/** True when a document or narrative statement explicitly describes relocation or realignment. */
export function hasRelocationEvidence(corpus: string[]): boolean {
  return corpus.some((t) => RELOCATION_WORDS.test(t));
}

/** A sentence from the narrative or a document that mentions relocation, with where it came from. */
export interface RelocationSentence { source: string; sentence: string }

/** Split text into sentences and keep only those that contain relocation wording. */
export function relocationSentences(corpus: { source: string; text: string }[]): RelocationSentence[] {
  const out: RelocationSentence[] = [];
  for (const c of corpus) {
    for (const s of c.text.split(/(?<=[.!?])\s+|\n+/)) {
      const t = s.trim();
      if (t && RELOCATION_WORDS.test(t)) out.push({ source: c.source, sentence: t.slice(0, 300) });
    }
  }
  return out;
}

const SUBJECT_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'new', 'old', 'line', 'lines', 'layer', 'area', 'to', 'of', 'in', 'on', 'north', 'south', 'east', 'west']);
const SUBJECT_SYNONYMS: Record<string, string[]> = {
  light: ['lighting', 'light', 'lights', 'lamp', 'lamps', 'luminaire', 'columns', 'cable'],
  kerb: ['kerb', 'kerbs', 'curb', 'kerbing'],
  pave: ['pavement', 'asphalt', 'carriageway', 'surfacing', 'paving'],
  drain: ['drain', 'drains', 'drainage', 'culvert', 'pipe', 'pipes'],
  cl: ['road', 'centreline', 'centerline', 'alignment'],
  barrier: ['barrier', 'barriers', 'guardrail'],
};

/** Words that identify what a layer is, from its name and the usual vocabulary for that name. */
export function subjectWords(layer: string): string[] {
  const parts = layer.toLowerCase().split(/[^a-z0-9]+/).filter((p) => p.length > 1 && !SUBJECT_STOP.has(p));
  const words = new Set<string>(parts);
  for (const p of parts) for (const [k, v] of Object.entries(SUBJECT_SYNONYMS)) if (p === k || p.startsWith(k)) v.forEach((w) => words.add(w));
  return Array.from(words);
}

/**
 * Find a relocation statement that is about THIS object: the sentence must name the layer's subject (or an explicit
 * handle/block). A relocation keyword elsewhere in the narrative does not confirm anything.
 */
export function evidenceForObject(layer: string, extra: string[], sentences: RelocationSentence[]): RelocationEvidence | null {
  const words = [...subjectWords(layer), ...extra.map((x) => x.toLowerCase()).filter(Boolean)];
  for (const s of sentences) {
    const tokens = new Set(s.sentence.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean));
    let hit = words.filter((w) => tokens.has(w) || tokens.has(`${w}s`));
    if (hit.length) return { source: s.source, sentence: s.sentence, matchedOn: Array.from(new Set(hit)) };
  }
  return null;
}

/** `relocationEvidence` is either a flag (legacy: applies to every pair) or a per-layer resolver (preferred). */
export type RelocationInput = boolean | ((layer: string, pair: { from: DrawingEntity; to: DrawingEntity }) => RelocationEvidence | null);

/** Lookup for the exact legacy size predicate, retaining original order for the first match.
 * The range tree counts only active candidates (confirmed relocations consume an original). */
class SizeRange {
  private readonly offsets = new Map<number, number>();
  private readonly size: number;
  private readonly count: Int32Array;
  private readonly first: Float64Array;
  private readonly entries: { length: number; index: number }[];

  constructor(entries: { length: number; index: number }[]) {
    this.entries = entries;
    entries.sort((a, b) => a.length - b.length || a.index - b.index);
    this.size = 2 ** Math.ceil(Math.log2(entries.length));
    this.count = new Int32Array(this.size * 2);
    this.first = new Float64Array(this.size * 2).fill(Infinity);
    entries.forEach(({index}, i) => {
      const leaf = this.size + i;
      this.offsets.set(index, leaf);
      this.count[leaf] = 1;
      this.first[leaf] = index;
    });
    for (let i = this.size - 1; i > 0; i -= 1) this.pull(i);
  }

  private pull(i: number) {
    this.count[i] = this.count[2 * i] + this.count[2 * i + 1];
    this.first[i] = Math.min(this.first[2 * i], this.first[2 * i + 1]);
  }

  remove(index: number) {
    let i = this.offsets.get(index);
    if (i === undefined) return;
    this.count[i] = 0; this.first[i] = Infinity;
    for (i = Math.floor(i / 2); i > 0; i = Math.floor(i / 2)) this.pull(i);
  }

  match(target: number, tolerance: number): { count: number; first: number } {
    const boundary = (before: (value: number) => boolean) => {
      let l = 0; let r = this.entries.length;
      while (l < r) {
        const mid = l + Math.floor((r - l) / 2);
        if (before(this.entries[mid].length)) l = mid + 1; else r = mid;
      }
      return l;
    };
    // Subtract before comparing, as the original predicate does. Precomputed target ± tolerance can round differently.
    let l = this.size + boundary((x) => x - target < -tolerance);
    let r = this.size + boundary((x) => x - target <= tolerance);
    let count = 0; let first = Infinity;
    for (; l < r; l = Math.floor(l / 2), r = Math.floor(r / 2)) {
      if (l % 2) { count += this.count[l]; first = Math.min(first, this.first[l]); l += 1; }
      if (r % 2) { r -= 1; count += this.count[r]; first = Math.min(first, this.first[r]); }
    }
    return { count, first };
  }
}

export interface DiffOptions {
  /** Metres to add to revised coordinates so they sit in the original's frame (origin shift). */
  shift?: { dx: number; dy: number } | null;
}

/**
 * Entity-level comparison. Elements present only in the revised drawing are additions; elements present only in the
 * original are removals. They are NEVER netted against each other. A removed and an added element of equal size is a
 * candidate pairing; it only becomes a relocation when evidence names that object. Otherwise it stays an addition
 * and an omission and is flagged for review.
 */
export function diffEntities(o: DrawingFile, r: DrawingFile, tolM = 0.01, relocationEvidence: RelocationInput = false, options: DiffOptions = {}): EntityDiff[] {
  const mo = o.metresPerUnit ?? 1; const mr = r.metresPerUnit ?? 1;
  const sx = options.shift?.dx ?? 0; const sy = options.shift?.dy ?? 0;
  const byLayer = new Map<string, { o: DrawingEntity[]; r: DrawingEntity[] }>();
  for (const e of o.entities) { const g = byLayer.get(e.layer) ?? { o: [], r: [] }; g.o.push(e); byLayer.set(e.layer, g); }
  for (const e of r.entities) { const g = byLayer.get(e.layer) ?? { o: [], r: [] }; g.r.push(e); byLayer.set(e.layer, g); }
  const out: EntityDiff[] = [];
  byLayer.forEach((g, layer) => {
    const remaining = new Map<string, DrawingEntity[]>();
    for (const e of g.o) {
      const k = signature(e, mo, tolM); const bucket = remaining.get(k);
      if (bucket) bucket.push(e); else remaining.set(k, [e]);
    }
    const added: DrawingEntity[] = [];
    for (const e of g.r) {
      const k = signature(e, mr, tolM, sx, sy);
      const bucket = remaining.get(k);
      if (bucket && bucket.length) bucket.pop(); else added.push(e);
    }
    const removed: DrawingEntity[] = [];
    remaining.forEach((list) => { for (const e of list) removed.push(e); });
    const candidatePairs: EntityDiff['candidatePairs'] = [];
    const relocated: EntityDiff['relocated'] = [];
    const ambiguous: NonNullable<EntityDiff['ambiguous']> = [];
    let evidence: RelocationEvidence | null = null;
    const consumed = new Set<number>();
    const kept: DrawingEntity[] = [];
    const keyFor = (e: DrawingEntity) => e.kind + '|' + (e.blockName === undefined ? '0' : '1' + e.blockName);
    const sourceGroups = new Map<string, { length: number; index: number }[]>();
    if (added.length) removed.forEach((e, index) => {
      const length = sizeOf(e) * mo;
      if (!Number.isFinite(length)) return;
      const key = keyFor(e); const group = sourceGroups.get(key);
      if (group) group.push({ length, index }); else sourceGroups.set(key, [{ length, index }]);
    });
    const ranges = new Map<string, SizeRange>();
    for (const a of added) {
      let n = 0; let i = Infinity; let range: SizeRange | undefined;
      const target = sizeOf(a) * mr;
      const tolerance = 0.01 * Math.max(target, 1e-9);
      if (removed.length && sizeOf(a) > 0) {
        const key = keyFor(a);
        if (Number.isFinite(target)) {
          const entries = sourceGroups.get(key);
          if (entries) {
            range = ranges.get(key);
            if (!range) { range = new SizeRange(entries); ranges.set(key, range); }
            ({ count: n, first: i } = range.match(target, tolerance));
          }
        } else {
          // Preserve the existing predicate for invalid or unbounded numeric input as well.
          removed.forEach((x, j) => {
            if (!consumed.has(j) && x.kind === a.kind && x.blockName === a.blockName && Math.abs(sizeOf(x) * mo - target) <= tolerance) {
              n += 1; i = Math.min(i, j);
            }
          });
        }
      }
      // A prior non-finite lookup can consume a finite original. Keep the grouped index in sync even then.
      if (n === 0) { kept.push(a); continue; }
      const pair = { from: removed[i], to: a };
      if (n > 1) ambiguous.push({ added: 1, removed: n, reason: `One added ${a.kind} could correspond to any of ${n} removed elements of the same size on layer ${layer}.` });
      const ev = typeof relocationEvidence === 'function' ? relocationEvidence(layer, pair) : relocationEvidence ? ({ source: 'Narrative', sentence: '', matchedOn: [] } as RelocationEvidence) : null;
      if (ev && n === 1) {
        relocated.push(pair); consumed.add(i); evidence = evidence ?? ev;
        const key = keyFor(removed[i]);
        range = range ?? ranges.get(key);
        if (!range && sourceGroups.has(key)) { range = new SizeRange(sourceGroups.get(key)!); ranges.set(key, range); }
        range?.remove(i);
      } else { candidatePairs.push(pair); kept.push(a); }
    }
    const unmatched = consumed.size ? removed.filter((_, i) => !consumed.has(i)) : removed;
    if (kept.length || unmatched.length || relocated.length) out.push({ layer, added: kept, removed: unmatched, relocated, candidatePairs, relocationEvidence: evidence, ambiguous });
  });
  return out.sort((a, b) => a.layer.localeCompare(b.layer));
}

/** Texts (annotations, attributes) that differ. A specification change with unchanged geometry shows up here. */
export function diffTexts(o: DrawingFile, r: DrawingFile): { added: string[]; removed: string[] } {
  const norm1 = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const a = new Set(o.texts.map(norm1).filter(Boolean)); const b = new Set(r.texts.map(norm1).filter(Boolean));
  return { added: Array.from(b).filter((t) => !a.has(t)), removed: Array.from(a).filter((t) => !b.has(t)) };
}

const measureOf = (list: DrawingEntity[], kind: 'nr' | 'm2' | 'm', mpu: number) => list.reduce((s, e) => s + (kind === 'nr' ? (e.kind === 'INSERT' ? 1 : 0) : kind === 'm2' ? e.area * mpu * mpu : e.length * mpu), 0);

/** Stable reference to an entity so the viewer can focus it and an entity can open its change. */
export const entityKey = (file: string, e: DrawingEntity, index?: number): string => `${file}#${e.handle || `i${index ?? 0}`}`;
const refOf = (e: DrawingEntity): { handle: string; kind: string; layer: string; fromBlock?: string } => ({ handle: e.handle, kind: e.kind, layer: e.layer, ...(e.fromBlock ? { fromBlock: e.fromBlock } : {}) });

/**
 * Measure changes for a validated pair. Per layer, entity matching separates additions, removals and relocations;
 * each is reported as its own change with its geometry references. Layers whose total is equal but whose elements
 * differ are NOT dismissed. Specification text that changed is reported even when quantities are unchanged.
 * Nothing here estimates a volume or an area from a length.
 */
export function measurePair(pair: DrawingPair, tolerance = 0.01, relocationEvidence: RelocationInput = false): MeasureOutcome {
  const notes: string[] = [];
  if (!pair.validated) return { changes: [], notes: ['Pair is not validated, so nothing was measured.'] };
  const detailFiles = [pair.original, pair.revised].filter(isDetailOnlyDrawing).map((f) => f.fileName);
  if (detailFiles.length) return {
    changes: [],
    notes: [`Typical detail/elevation sheet(s) ${detailFiles.join(', ')} show configuration, not the installed extent. A corresponding plan/chainage drawing or a referenced quantity schedule is needed for a takeoff.`],
  };
  if ([pair.original, pair.revised].some((file) => unboundedLimits(file).length)) {
    return { changes: [], notes: ['Placed unresolved references or unread block trees can contain geometry on other layers. No exact takeoff was issued.'] };
  }
  if (!pair.original.metresPerUnit || !pair.revised.metresPerUnit) {
    return {changes: [], notes: ['Both drawing units must be established before measuring.']};
  }
  const mpuO = pair.original.metresPerUnit ?? 1; const mpuR = pair.revised.metresPerUnit ?? 1;
  const a = totals(pair.original); const b = totals(pair.revised);
  const shift = pair.originShift ? { dx: pair.originShift.dx, dy: pair.originShift.dy } : null;
  if (shift) notes.push(`Drawing origin shift of (${fmt(shift.dx)} m, ${fmt(shift.dy)} m) detected from ${pair.originShift!.matched} of ${pair.originShift!.of} sampled elements and applied to the revised drawing before comparison, so the whole drawing is not reported as changed.`);
  const diffs = diffEntities(pair.original, pair.revised, 0.01, relocationEvidence, { shift });
  const changes: MeasuredChange[] = [];
  const srcOf = (f: DrawingFile, layer: string) => `${f.fileName} · layer ${layer}`;
  for (const d of diffs) {
    if (isPresentationLayer(d.layer)) {
      notes.push(`Layer ${d.layer}: annotation/frame/legend geometry was excluded from quantities.`);
      continue;
    }
    const limited = [pair.original, pair.revised].flatMap((f) =>
      Object.entries(f.coverageGapsByLayer ?? {}).filter(([layer]) => layer.toLowerCase() === d.layer.toLowerCase())
        .map(([, kinds]) => `${f.fileName} (${kinds.join(', ')})`));
    if (limited.length) {
      if (d.added.length || d.removed.length || d.relocated.length) notes.push(`Coverage incomplete on layer ${d.layer}: unread geometry in ${limited.join('; ')}. The layer was withheld from the takeoff.`);
      continue;
    }
    const ta = a.get(d.layer); const tb = b.get(d.layer);
    const kind = kindFor(tb ?? ta!) ?? kindFor(ta ?? tb!);
    if (!kind) { notes.push(`Layer ${d.layer}: no measurable geometry.`); continue; }
    if (ta && tb && kindFor(ta) !== kindFor(tb)) { notes.push(`Layer ${d.layer}: geometry type differs between revisions (${kindFor(ta)} vs ${kindFor(tb)}), so it was not measured.`); continue; }
    const unitWord = kind === 'nr' ? 'nr' : kind === 'm2' ? 'm²' : 'm';
    const geometry = kind === 'nr' ? 'block count' : kind === 'm2' ? 'closed-polyline area (shoelace)' : 'summed polyline/line/arc length';
    const formula = kind === 'nr' ? 'count of INSERT markers' : kind === 'm2' ? 'Σ shoelace area of closed paths (incl. bulge segments) × (m/unit)²' : 'Σ line and true arc lengths × (m/unit)';
    const basisText = `entity-level match (${geometry}), coordinates compared to 10 mm in metres via ${pair.revised.unitSource || 'declared drawing units'}`;
    const locate = (list: DrawingEntity[], f: DrawingFile) => {
      const pts: { x: number; y: number }[] = [];
      for (const e of list) for (const v of e.vertices) pts.push(v);
      if (!pts.length) return '';
      const m = f.metresPerUnit ?? 1;
      let sxs = 0; let sys = 0; for (const p of pts) { sxs += p.x; sys += p.y; }
      return `near (${fmt(sxs / pts.length * m)} m, ${fmt(sys / pts.length * m)} m); handles ${list.slice(0, 6).map((e) => e.handle || '·').join(', ')}${list.length > 6 ? '…' : ''}`;
    };
    const ambiguity = d.ambiguous && d.ambiguous.length ? { reason: d.ambiguous.map((x) => x.reason).join(' '), candidates: d.ambiguous.reduce((s, x) => s + x.removed, 0) } : undefined;
    const trace = (origN: number, revN: number): MeasuredChange['trace'] => ({
      formula, measurementBasis: kind === 'nr' ? 'count' : kind === 'm2' ? 'area' : 'length', units: unitWord,
      drawingRevision: `${pair.original.titleBlock?.revision || '?'} → ${pair.revised.titleBlock?.revision || '?'}`,
      originalFile: pair.original.fileName, revisedFile: pair.revised.fileName, entityCount: { original: origN, revised: revN }, toleranceM: 0.01,
      // A length or area never becomes a volume or area here: the missing dimension is named instead of invented.
      missingForDerivation: kind === 'm' ? ['width (for area)', 'depth or thickness (for volume)'] : kind === 'm2' ? ['depth or thickness (for volume)'] : undefined,
    });
    const push = (change: MeasuredChange['change'], suffix: string, qty: number, orig: number, rev: number, loc: string, refs: string, refsOriginal: DrawingEntity[], refsRevised: DrawingEntity[], extra: Partial<MeasuredChange> = {}) => {
      if (Math.abs(qty) <= tolerance) return;
      const addedQ = change === 'added' ? Math.abs(qty) : 0; const omitQ = change === 'removed' ? Math.abs(qty) : 0;
      changes.push({
        id: `m-${d.layer}-${suffix}`, component: d.layer, change, unit: kind,
        description: `${d.layer}: ${change === 'added' ? 'added' : change === 'removed' ? 'removed' : 'relocated'} ${fmt(Math.abs(qty))} ${unitWord}`,
        location: loc, originalQty: fmt(orig), revisedQty: fmt(rev), changeQty: fmt(qty),
        addedQty: fmt(addedQ), omittedQty: fmt(omitQ), netQty: fmt(qty),
        basis: 'measured', measurementBasis: `${basisText}; ${refs}`,
        trace: trace(refsOriginal.length, refsRevised.length),
        sources: [srcOf(pair.original, d.layer), srcOf(pair.revised, d.layer)],
        entityRefs: { layer: d.layer, original: refsOriginal.map(refOf), revised: refsRevised.map(refOf), drawingNumber: pair.revised.titleBlock?.drawingNumber ?? '', originalRevision: pair.original.titleBlock?.revision ?? '', revisedRevision: pair.revised.titleBlock?.revision ?? '', originShift: shift },
        ...extra,
      });
    };
    const addQ = measureOf(d.added, kind, mpuR); const remQ = measureOf(d.removed, kind, mpuO);
    const candidateTo = new Set(d.candidatePairs.map((x) => x.to)); const candidateFrom = new Set(d.candidatePairs.map((x) => x.from));
    const addAmb = ambiguity && d.added.some((e) => candidateTo.has(e)) ? ambiguity : undefined;
    const remAmb = ambiguity && d.removed.some((e) => candidateFrom.has(e)) ? ambiguity : undefined;
    if (d.added.length) push('added', 'add', addQ, 0, addQ, locate(d.added, pair.revised), `${d.added.length} element(s) only in ${pair.revised.fileName}`, [], d.added, addAmb ? { ambiguity: addAmb } : {});
    if (d.removed.length) push('removed', 'rem', -remQ, remQ, 0, locate(d.removed, pair.original), `${d.removed.length} element(s) only in ${pair.original.fileName}`, d.removed, [], remAmb ? { ambiguity: remAmb } : {});
    if (d.relocated.length) {
      const q = measureOf(d.relocated.map((x) => x.to), kind, mpuR);
      const ev = d.relocationEvidence ?? null;
      push('modified', 'move', q, q, q, locate(d.relocated.map((x) => x.to), pair.revised), `${d.relocated.length} element(s) moved, confirmed by ${ev && ev.sentence ? `“${ev.sentence}” (${ev.source})` : 'relocation wording in the PVR or correspondence'}; quantity unchanged but work is affected (remove and re-lay)`, d.relocated.map((x) => x.from), d.relocated.map((x) => x.to), { relocationEvidence: ev });
    }
    if (d.candidatePairs.length) {
      const q = measureOf(d.candidatePairs.map((x) => x.to), kind, mpuR);
      notes.push(`Layer ${d.layer}: ${d.candidatePairs.length} removed element(s) match ${d.candidatePairs.length} added element(s) in size (${fmt(q)} ${unitWord}). A matching size is not evidence of relocation, so they are kept as an omission and an addition. Confirm with a PVR or correspondence statement if they were moved.`);
    }
    for (const am of d.ambiguous ?? []) notes.push(`Layer ${d.layer}: ambiguous correspondence - ${am.reason} Flagged for review; kept as an omission and an addition.`);
    if (d.added.length && d.removed.length && Math.abs(addQ - remQ) <= tolerance) notes.push(`Layer ${d.layer}: additions and removals have equal totals (${fmt(addQ)} ${unitWord}) but are different elements, so both are kept and neither is dismissed.`);
  }
  const t = diffTexts(pair.original, pair.revised);
  if (t.added.length || t.removed.length) {
    changes.push({
      id: 'm-spec-text', component: 'Specification / annotation text', change: 'modified', unit: 'nr',
      description: `Annotation or specification text differs: ${t.removed.length} removed, ${t.added.length} added`,
      location: 'Drawing annotations', originalQty: '0', revisedQty: '0', changeQty: '0', basis: 'measured',
      measurementBasis: `text comparison. Removed: ${t.removed.slice(0, 4).map((x) => `“${x}”`).join(', ') || 'none'}. Added: ${t.added.slice(0, 4).map((x) => `“${x}”`).join(', ') || 'none'}. No quantity change is implied; a specification change may still affect rates.`,
      sources: [pair.original.fileName, pair.revised.fileName],
    });
  }
  if (changes.length === 0) notes.push('Entity-level comparison found no added, removed, relocated or re-specified elements within 10 mm. Only supported entity types (lines, polylines, arcs, circles, blocks) and text were compared; other entity types are not covered.');
  return { changes, notes };
}

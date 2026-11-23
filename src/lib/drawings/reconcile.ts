import type { MeasuredChange, QuantityBasis, ReconciledChange, StatedQuantity } from './types';

const UNIT_PATTERN = '(km|m2|m²|sqm|sq\\.?\\s*m|m3|m³|cum|mm|m|nr|no\\.?|nos|number|items?|lights?|units?)';
const QTY_RE = new RegExp(`(\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d+)?)\\s*${UNIT_PATTERN}\\b`, 'gi');

function canonUnit(u: string): { unit: string; factor: number } | null {
  const x = u.toLowerCase().replace(/\s+/g, '').replace(/\./g, '');
  if (x === 'km') return { unit: 'm', factor: 1000 };
  if (x === 'm') return { unit: 'm', factor: 1 };
  if (x === 'mm') return { unit: 'mm', factor: 1 };
  if (x === 'm2' || x === 'm²' || x === 'sqm' || x === 'sqm') return { unit: 'm2', factor: 1 };
  if (x === 'm3' || x === 'm³' || x === 'cum') return { unit: 'm3', factor: 1 };
  if (['nr', 'no', 'nos', 'number', 'item', 'items', 'light', 'lights', 'unit', 'units'].includes(x)) return { unit: 'nr', factor: 1 };
  return null;
}

/** Find quantities written in a document or narrative, with the words around them that say what they measure. */
export function extractStatedQuantities(text: string, source: string, basis: StatedQuantity['basis']): StatedQuantity[] {
  const out: StatedQuantity[] = [];
  for (const m of text.matchAll(QTY_RE)) {
    const canon = canonUnit(m[2]);
    if (!canon) continue;
    const value = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    const idx = m.index ?? 0;
    // A bare "m" directly after a digit that is part of a date/time is not a length.
    const around = text.slice(Math.max(0, idx - 70), idx + m[0].length + 50).replace(/\s+/g, ' ').trim();
    const before = text.slice(Math.max(0, idx - 50), idx).toLowerCase();
    const after = text.slice(idx + m[0].length, idx + m[0].length + 50).toLowerCase();
    out.push({ value: String(value * canon.factor), unit: canon.unit, basis, source, quote: around, subject: `${before} ${after}` });
  }
  return out;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'new', 'old', 'road', 'layer', 'line', 'lines', 'area', 'both', 'sides', 'side', 'of', 'to', 'in', 'on', 'a']);
const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 2 && !STOP.has(w));

/** Synonyms linking a drawing layer name to the words documents use. */
const LAYER_WORDS: Record<string, string[]> = {
  pave: ['pavement', 'asphalt', 'carriageway', 'surfacing', 'paving'],
  kerb: ['kerb', 'kerbs', 'curb', 'curbs', 'kerbing'],
  light: ['lighting', 'light', 'lights', 'lamp', 'luminaire', 'lamps', 'columns'],
  cl: ['road', 'extension', 'extend', 'centreline', 'centerline', 'length'],
  drain: ['drain', 'drainage', 'culvert', 'pipe'],
  barrier: ['barrier', 'barriers', 'guardrail'],
};

function layerWords(layer: string): string[] {
  const parts = layer.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const words = new Set<string>(parts);
  for (const p of parts) for (const [k, v] of Object.entries(LAYER_WORDS)) if (p === k || p.startsWith(k)) v.forEach((w) => words.add(w));
  return Array.from(words);
}

/** True when a stated quantity's surrounding words name the same thing as the layer, and the unit dimension matches. */
function statedMatchesLayer(s: StatedQuantity, layer: string, unit: string): boolean {
  if (s.unit !== unit) return false;
  const lw = layerWords(layer);
  const subj = new Set(tokens(s.subject));
  return lw.some((w) => subj.has(w));
}

const fmt = (n: number) => String(Number(n.toFixed(3)));

export interface ReconcileInput {
  measured: MeasuredChange[];
  stated: StatedQuantity[];
  userEntered?: { componentId: string; value: string; unit: string }[];
  tolerancePct?: number;
}

/**
 * One row per change component. Measured values lead; stated values are kept alongside as alternatives. A
 * disagreement beyond tolerance is flagged for review and never resolved by overwriting one source with another.
 * Stated quantities that match no drawing component become their own document/narrative rows.
 */
export function reconcile(input: ReconcileInput): ReconciledChange[] {
  const tol = (input.tolerancePct ?? 2) / 100;
  const used = new Set<StatedQuantity>();
  const rows: ReconciledChange[] = [];
  for (const m of input.measured) {
    const alts: ReconciledChange['alternatives'] = [];
    for (const s of input.stated) {
      if (statedMatchesLayer(s, m.component, m.unit)) { used.add(s); alts.push({ basis: s.basis, value: s.value, unit: s.unit, source: s.source, quote: s.quote }); }
    }
    for (const u of input.userEntered ?? []) {
      // The user names the component the way the table shows it (the layer / component name), or its id.
      const same = u.componentId === m.id || u.componentId.trim().toLowerCase() === m.component.toLowerCase();
      if (same && u.unit === m.unit) alts.push({ basis: 'user_entered', value: u.value, unit: u.unit, source: 'Entered by you', quote: '' });
    }
    const measuredAbs = Math.abs(Number(m.changeQty));
    const disagree = alts.filter((a) => {
      const v = Number(a.value);
      return Number.isFinite(v) && measuredAbs > 0 && Math.abs(v - measuredAbs) / measuredAbs > tol;
    });
    rows.push({
      id: m.id, component: m.component, description: m.description, location: m.location, unit: m.unit,
      originalQty: m.originalQty, revisedQty: m.revisedQty, changeQty: m.changeQty, basis: m.basis, measurementBasis: m.measurementBasis, sources: m.sources,
      addedQty: m.addedQty, omittedQty: m.omittedQty, netQty: m.netQty, trace: m.trace, ambiguity: m.ambiguity, relocationEvidence: m.relocationEvidence ?? null,
      alternatives: alts, conflict: disagree.length > 0,
      entityRefs: m.entityRefs, change: m.change,
      conflictNote: disagree.length ? `Drawings give ${fmt(measuredAbs)} ${m.unit}, but ${disagree.map((d) => `${d.source} states ${d.value} ${d.unit}`).join('; ')}. Neither was overwritten.` : '',
    });
  }
  // Stated quantities that did not match any measured component stay visible as their own evidence-only rows.
  let n = 0;
  for (const s of input.stated) {
    if (used.has(s)) continue;
    n += 1;
    rows.push({
      id: `s-${n}`, component: s.subject.trim().split(' ').slice(-4).join(' ') || 'Stated quantity', description: `Stated: ${s.value} ${s.unit}`, location: '', unit: s.unit,
      originalQty: '', revisedQty: '', changeQty: s.value, basis: s.basis, measurementBasis: 'Quantity as written in the document; not measured from drawings', sources: [s.source],
      alternatives: [{ basis: s.basis, value: s.value, unit: s.unit, source: s.source, quote: s.quote }], conflict: false, conflictNote: '',
    });
  }
  // A user-entered quantity for a component that nothing else covers is kept as its own row, labelled User-entered.
  for (const u of input.userEntered ?? []) {
    const covered = rows.some((r) => r.id === u.componentId || r.component.toLowerCase() === u.componentId.trim().toLowerCase());
    if (covered) continue;
    n += 1;
    rows.push({
      id: `u-${n}`, component: u.componentId.trim(), description: `Entered by you: ${u.value} ${u.unit}`, location: '', unit: u.unit,
      originalQty: '', revisedQty: '', changeQty: u.value, basis: 'user_entered', measurementBasis: 'Entered manually; no document or drawing evidence', sources: ['Entered by you'],
      alternatives: [], conflict: false, conflictNote: '',
    });
  }
  return rows;
}

export function basisOf(row: ReconciledChange): QuantityBasis { return row.basis; }

/** Plain-language lines for the BOQ agent. Only evidence-linked changes; each states its basis. */
export function narrativeFromChanges(changes: ReconciledChange[]): string {
  return changes
    .filter((c) => !c.conflict)
    .map((c) => {
      const q = Number(c.changeQty);
      const verb = c.basis === 'measured' || c.basis === 'derived' ? (q < 0 ? 'Omit' : 'Add') : 'Change';
      const unit = c.unit === 'm2' ? 'm²' : c.unit === 'm3' ? 'm³' : c.unit;
      const src = c.basis === 'measured' ? `measured from drawings (${c.sources[0] ?? ''})`
        : c.basis === 'user_entered' ? 'entered by the user'
        : `stated in ${c.sources[0] ?? 'the documents'}: “${c.alternatives[0]?.quote ?? ''}”`;
      return `${verb} ${c.component}: ${fmt(Math.abs(q))} ${unit} (${src}).`;
    })
    .join('\n');
}

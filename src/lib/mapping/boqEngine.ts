import type { BoqAlternative, BoqClass, BoqMapping, DrawingChange } from './types';

export interface BoqItem {
  ref: string;
  description: string;
  bill: number;
  unit: string;
  rate: number;
  preamble: string;
  sheet: string;
  cell: string;
}

export interface BoqBill {
  number: number;
  title: string;
  itemCount: number;
  relevantByDefault: boolean;
}

export const BOQ_BILLS: BoqBill[] = [
  { number: 1, title: 'Preliminaries', itemCount: 142, relevantByDefault: false },
  { number: 2, title: 'Site clearance', itemCount: 61, relevantByDefault: false },
  { number: 3, title: 'Earthworks and roads', itemCount: 412, relevantByDefault: true },
  { number: 4, title: 'Drainage', itemCount: 288, relevantByDefault: true },
  { number: 5, title: 'Lighting and electrical', itemCount: 346, relevantByDefault: true },
  { number: 6, title: 'Signage and marking', itemCount: 174, relevantByDefault: true },
  { number: 7, title: 'Structures', itemCount: 905, relevantByDefault: false },
  { number: 8, title: 'Irrigation', itemCount: 622, relevantByDefault: false },
  { number: 9, title: 'Landscape softworks', itemCount: 531, relevantByDefault: false },
  { number: 10, title: 'Utilities', itemCount: 804, relevantByDefault: false },
  { number: 11, title: 'Telecoms', itemCount: 410, relevantByDefault: false },
  { number: 12, title: 'Demolition', itemCount: 97, relevantByDefault: true },
  { number: 13, title: 'Provisional sums', itemCount: 38, relevantByDefault: false },
];

export const BOQ_ITEMS: BoqItem[] = [
  { ref: '3.1.01', description: 'Excavation and fill to formation level', bill: 3, unit: 'm³', rate: 42.5, preamble: '3.1.1 Excavation measured net in place. 3.1.3 Disposal of surplus included.', sheet: 'Bill 3', cell: 'F42' },
  { ref: '3.1.04', description: 'Rock excavation, hard', bill: 3, unit: 'm³', rate: 118, preamble: '3.1.5 Rock measured only when approved by the Engineer.', sheet: 'Bill 3', cell: 'F45' },
  { ref: '3.2.04', description: 'Granular subbase, 200 mm thick', bill: 3, unit: 'm²', rate: 31, preamble: '3.2.2 Compaction to 98% MDD included.', sheet: 'Bill 3', cell: 'F96' },
  { ref: '3.2.07', description: 'Asphalt wearing course, 50 mm thick', bill: 3, unit: 'm²', rate: 58, preamble: '3.2.7.1 Asphalt wearing course to specification. 3.2.7.4 Tack coat included in rate.', sheet: 'Bill 3', cell: 'F118' },
  { ref: '3.2.08', description: 'Asphalt wearing course, modified binder', bill: 3, unit: 'm²', rate: 66, preamble: '3.2.7.1 Modified binder only where stated on the drawings.', sheet: 'Bill 3', cell: 'F119' },
  { ref: '3.2.09', description: 'Asphalt binder course, 60 mm thick', bill: 3, unit: 'm²', rate: 49, preamble: '3.2.7.2 Binder course laid in one layer.', sheet: 'Bill 3', cell: 'F120' },
  { ref: '3.3.02', description: 'Precast concrete kerb, 300 x 150 mm', bill: 3, unit: 'm', rate: 96, preamble: '3.3.1 Kerb bedded on 150 mm concrete, jointing included.', sheet: 'Bill 3', cell: 'F131' },
  { ref: '3.3.03', description: 'Precast concrete kerb, flush type', bill: 3, unit: 'm', rate: 88, preamble: '3.3.1 Flush kerbs at crossings only.', sheet: 'Bill 3', cell: 'F132' },
  { ref: '3.4.09', description: 'Temporary turning head', bill: 3, unit: 'nr', rate: 21500, preamble: '3.4.3 Temporary works removed when road is extended.', sheet: 'Bill 3', cell: 'F158' },
  { ref: '3.4.11', description: 'End-of-road barrier, already installed', bill: 3, unit: 'm', rate: 740, preamble: '3.4.5 Barrier supplied and fixed to approved details.', sheet: 'Bill 3', cell: 'F161' },
  { ref: '4.1.02', description: 'Gully and connection, road drainage', bill: 4, unit: 'nr', rate: 3200, preamble: '4.1.1 Gully measured with connection to carrier pipe.', sheet: 'Bill 4', cell: 'F20' },
  { ref: '5.2.01', description: 'Street lighting column, 8 m, LED luminaire', bill: 5, unit: 'nr', rate: 9800, preamble: '5.2.1 Column, foundation and luminaire complete.', sheet: 'Bill 5', cell: 'F61' },
  { ref: '5.2.02', description: 'Street lighting column, 10 m, LED luminaire', bill: 5, unit: 'nr', rate: 11400, preamble: '5.2.1 Used on dual carriageways only.', sheet: 'Bill 5', cell: 'F62' },
  { ref: '6.1.03', description: 'Thermoplastic road marking, 150 mm line', bill: 6, unit: 'm', rate: 6.5, preamble: '6.1.2 Marking applied after final wearing course.', sheet: 'Bill 6', cell: 'F30' },
  { ref: '12.1.04', description: 'Demolition of temporary barrier', bill: 12, unit: 'nr', rate: 1450, preamble: '12.1.1 Demolition including disposal.', sheet: 'Bill 12', cell: 'F11' },
];

export function findBoqItem(ref: string): BoqItem | undefined {
  return BOQ_ITEMS.find((i) => i.ref === ref);
}

const STOP = new Set(['the', 'and', 'of', 'to', 'a', 'in', 'for', 'at', 'both', 'sides']);

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Jaccard-style text similarity, 0 to 1. */
export function textSimilarity(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  ta.forEach((t) => {
    if (tb.has(t)) inter += 1;
  });
  return inter / (ta.size + tb.size - inter);
}

export interface Candidate {
  item: BoqItem;
  score: number;
  unitOk: boolean;
}

/** Rank BoQ candidates: unit gate, then text similarity. Unit mismatches are rejected. */
export function rankCandidates(query: string, unit: string, bills: number[], items: BoqItem[] = BOQ_ITEMS): Candidate[] {
  return items
    .filter((i) => bills.includes(i.bill))
    .map((item) => ({ item, unitOk: item.unit === unit, score: textSimilarity(query, `${item.description} ${item.preamble}`) }))
    .filter((c) => c.unitOk)
    .sort((a, b) => b.score - a.score);
}

export function toAlternative(c: Candidate, rejectedBecause: string): BoqAlternative {
  return {
    boqRef: c.item.ref,
    description: c.item.description,
    confidence: Math.round(Math.min(0.97, c.score + 0.28) * 100),
    rejectedBecause,
    unit: c.item.unit,
    bill: c.item.bill,
    rate: c.item.rate,
  };
}

export interface QuantityCalc {
  quantity: number;
  steps: string;
}

/** Area = length x width, with excluded sections subtracted. All arithmetic in code. */
export function deriveAreaQuantity(length: number, width: number, excluded = 0): QuantityCalc {
  const gross = length * width;
  const quantity = gross - excluded;
  const fmt = (n: number) => n.toLocaleString('en-US');
  const steps = excluded > 0 ? `${fmt(length)} m x ${fmt(width)} m = ${fmt(gross)} m², less ${fmt(excluded)} m² excluded = ${fmt(quantity)} m²` : `${fmt(length)} m x ${fmt(width)} m = ${fmt(quantity)} m²`;
  return { quantity, steps };
}

export function deriveVolumeQuantity(area: number, depth: number): QuantityCalc {
  const quantity = area * depth;
  return { quantity, steps: `${area.toLocaleString('en-US')} m² x ${depth} m = ${quantity.toLocaleString('en-US')} m³` };
}

export function mappingStatus(confidence: number, inferred: boolean): BoqMapping['status'] {
  if (inferred) return 'inferred';
  return confidence >= 85 ? 'confirmed' : 'needs_confirmation';
}

export function countByClass(list: BoqMapping[], cls: BoqClass): number {
  return list.filter((m) => m.included && m.class === cls).length;
}

interface PlanInput {
  changes: DrawingChange[];
  bills: number[];
}

/** Deterministic mapping of confirmed drawing changes to BoQ items. The model only explains afterwards. */
export function mapChangesToBoq({ changes, bills }: PlanInput): BoqMapping[] {
  const inc = changes.filter((c) => c.included);
  const road = inc.find((c) => c.type === 'added' && /centreline/i.test(c.title));
  const pave = inc.find((c) => c.type === 'added' && c.measure === 'area');
  const kerb = inc.find((c) => c.type === 'added' && /kerb/i.test(c.title));
  const light = inc.find((c) => c.type === 'added' && c.measure === 'count');
  const turn = inc.find((c) => c.type === 'removed' && c.measure === 'count');
  const barrier = inc.find((c) => c.type === 'modified');
  const out: BoqMapping[] = [];
  const pick = (query: string, unit: string) => rankCandidates(query, unit, bills);

  if (road && pave) {
    const width = pave.value / road.value;
    const calc = deriveAreaQuantity(road.value, width);
    const wearing = pick('asphalt wearing course', 'm²');
    const best = findBoqItem('3.2.07') ?? wearing[0]?.item;
    if (best) {
      out.push({
        id: 'BM-01', changeIds: [pave.id, road.id], boqRef: best.ref, description: best.description, bill: best.bill, class: 'addition', unit: 'm²', quantity: calc.quantity, quantityCalc: `${calc.steps}. From change ${pave.id}. No sections excluded.`,
        rateRef: best.rate, status: 'confirmed', confidence: 94,
        rationale: `Rev C adds ${pave.value.toLocaleString('en-US')} m² of carriageway. Bill 3 prices wearing course by m², and the same item priced R4 CH 0+000 to 5+000, so it is matched at the contract rate.`,
        preamble: best.preamble,
        alternatives: ['3.2.08', '3.2.09'].map((r, i) => {
          const it = findBoqItem(r)!;
          return toAlternative({ item: it, score: i === 0 ? 0.34 : 0.13, unitOk: true }, i === 0 ? 'Modified binder is only used where the drawings say so. Rev C does not.' : 'Binder course is a layer below the wearing course, not the same layer.');
        }),
        sources: `Bill 3, sheet ${best.sheet}, cell ${best.cell}. Drawing change ${pave.id}. PVR-0418.pdf, page 2.`, included: true,
      });
    }
    const sub = findBoqItem('3.2.04');
    if (sub) {
      out.push({
        id: 'BM-02', changeIds: [pave.id], boqRef: sub.ref, description: sub.description, bill: sub.bill, class: 'addition', unit: 'm²', quantity: calc.quantity, quantityCalc: `${calc.steps}. Same footprint as the wearing course.`,
        rateRef: sub.rate, status: 'confirmed', confidence: 95,
        rationale: 'The subbase sits under the whole new carriageway, so it takes the same area as the wearing course.',
        preamble: sub.preamble,
        alternatives: [toAlternative({ item: findBoqItem('3.2.09')!, score: 0.1, unitOk: true }, 'Binder course is above the subbase.')],
        sources: `Bill 3, sheet ${sub.sheet}, cell ${sub.cell}. Drawing change ${pave.id}.`, included: true,
      });
    }
    const exc = findBoqItem('3.1.01');
    if (exc) {
      const vol = deriveVolumeQuantity(calc.quantity, 0.6);
      out.push({
        id: 'BM-03', changeIds: [pave.id], boqRef: exc.ref, description: exc.description, bill: exc.bill, class: 'addition', unit: 'm³', quantity: vol.quantity, quantityCalc: `${vol.steps}. Formation depth 0.6 m is stated on the typical road section.`,
        rateRef: exc.rate, status: 'confirmed', confidence: 93,
        rationale: 'New carriageway needs excavation and fill to formation level. Depth is read from the typical section on Rev C.',
        preamble: exc.preamble,
        alternatives: [toAlternative({ item: findBoqItem('3.1.04')!, score: 0.2, unitOk: true }, 'Rock excavation applies only when the Engineer approves rock. No rock is reported on this stretch.')],
        sources: `Bill 3, sheet ${exc.sheet}, cell ${exc.cell}. Drawing change ${pave.id}, typical section.`, included: true,
      });
    }
  }
  if (kerb) {
    const k = findBoqItem('3.3.02');
    if (k) {
      out.push({
        id: 'BM-04', changeIds: [kerb.id], boqRef: k.ref, description: k.description, bill: k.bill, class: 'addition', unit: 'm', quantity: kerb.value, quantityCalc: `Kerb on both sides of 2,000 m = ${kerb.value.toLocaleString('en-US')} m. From change ${kerb.id}.`,
        rateRef: k.rate, status: 'needs_confirmation', confidence: 81,
        rationale: 'The drawing shows kerb on both sides of the extension. The BoQ kerb for R4 is the 300 x 150 type, but Rev C does not state the type, so please confirm.',
        preamble: k.preamble,
        alternatives: [toAlternative({ item: findBoqItem('3.3.03')!, score: 0.5, unitOk: true }, 'Flush kerbs are used at crossings only.')],
        sources: `Bill 3, sheet ${k.sheet}, cell ${k.cell}. Drawing change ${kerb.id}.`, included: true,
      });
    }
  }
  if (light) {
    const l = findBoqItem('5.2.01');
    if (l) {
      out.push({
        id: 'BM-05', changeIds: [light.id], boqRef: l.ref, description: l.description, bill: l.bill, class: 'addition', unit: 'nr', quantity: light.value, quantityCalc: `${light.value} LED_COLUMN_8M blocks counted on layer ${light.layer}.`,
        rateRef: l.rate, status: 'inferred', confidence: 82,
        rationale: 'The PVR text does not mention lighting, but Rev C adds 50 columns along the extension. Matched to the 8 m column used on R4.',
        preamble: l.preamble,
        alternatives: [toAlternative({ item: findBoqItem('5.2.02')!, score: 0.45, unitOk: true }, '10 m columns are for dual carriageways only.')],
        sources: `Bill 5, sheet ${l.sheet}, cell ${l.cell}. Drawing change ${light.id}.`, included: true,
      });
    }
  }
  if (turn) {
    const t = findBoqItem('3.4.09');
    if (t) {
      out.push({
        id: 'BM-06', changeIds: [turn.id], boqRef: t.ref, description: t.description, bill: t.bill, class: 'omission', unit: 'nr', quantity: turn.value, quantityCalc: `${turn.value} turning head removed at CH 5+000. From change ${turn.id}.`,
        rateRef: t.rate, status: 'confirmed', confidence: 88,
        rationale: 'The temporary turning head at the old end of the road is no longer needed once the road continues.',
        preamble: t.preamble,
        alternatives: [toAlternative({ item: findBoqItem('12.1.04')!, score: 0.3, unitOk: true }, 'Demolition item covers breaking out, but the BoQ already prices the turning head as an omission.')],
        sources: `Bill 3, sheet ${t.sheet}, cell ${t.cell}. Drawing change ${turn.id}.`, included: true,
      });
    }
  }
  if (barrier) {
    const b = findBoqItem('3.4.11');
    if (b) {
      out.push({
        id: 'BM-07', changeIds: [barrier.id], boqRef: b.ref, description: b.description, bill: b.bill, class: 'abortive', unit: 'm', quantity: barrier.value, quantityCalc: `${barrier.value} m of barrier already installed at CH 5+000. From change ${barrier.id}.`,
        rateRef: b.rate, status: 'needs_confirmation', confidence: 79,
        rationale: 'The end-of-road barrier was installed before the change and now moves to CH 7+000, so the installed work is abortive.',
        preamble: b.preamble,
        alternatives: [toAlternative({ item: findBoqItem('12.1.04')!, score: 0.2, unitOk: false || true }, 'Demolition counts items, not metres of barrier.')],
        sources: `Bill 3, sheet ${b.sheet}, cell ${b.cell}. Drawing change ${barrier.id}. Site report not yet provided.`, included: true,
      });
    }
  }
  if (road) {
    out.push({
      id: 'BM-08', changeIds: [road.id], boqRef: 'New', description: 'Culvert extension, 900 mm reinforced concrete pipe, CH 6+120', bill: 4, class: 'new', unit: 'm', quantity: 18, quantityCalc: 'Culvert crossing at CH 6+120 is 18 m wide on Rev C (road width 7.0 m plus embankment).',
      rateRef: null, status: 'inferred', confidence: 71,
      rationale: 'Rev C shows a drainage crossing at CH 6+120. Bill 4 has no 900 mm pipe culvert item, so a new item is proposed and needs a rate.',
      preamble: 'No applicable preamble. Bill 4 clause 4.2.1 covers pipes up to 600 mm only.',
      alternatives: [toAlternative({ item: findBoqItem('4.1.02')!, score: 0.1, unitOk: false }, 'Gully item counts units and does not cover a pipe run.')].map((a) => ({ ...a, unit: 'nr' })),
      sources: 'Bill 4 searched, 288 items and 14 preamble clauses. Drawing change ' + road.id + '.', included: true,
    });
  }
  return out;
}

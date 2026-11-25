import { describe, expect, it } from 'vitest';
import {
  bundledPhrases, checkAggregation, checkItemDimension, classifyRate, componentKeyOf, detectValuationOverlaps, fingerprint, heldOutByOverlap, lineIdOf,
  makeFingerprint, sourceKeyOf, staleReasons, totalsFor, uniqueKeys, valueGroup, valueReplacement,
  type AggLine, type AggregationGroup, type OverlapLine, type TotalsLine,
} from './valuation';
import { buildSharedLinesDetailed } from '../mapping/sharedLines';
import { assemble, EMPTY_ANSWERS, sameWork, type BoqSet } from './matchEngine';
import { summariseCost, type SummaryLine } from './resolutions';
import { newItemDraftForTest } from './valuation.fixtures';
import type { BoqItemRecord } from './types';
import type { ChangeScope, ModelMatchResult, ScopeComponent } from './scope';

const row = ({ id, ref, unit, rate, description = ref, ...overrides }: Omit<Partial<BoqItemRecord>, 'rate'> & { id: string; ref: string; unit: string; rate: string }): BoqItemRecord => ({
  id, importId: 'imp1', caseId: 'case1', sheet: 'Bill 1', rowNumber: Number(id.split('!').pop() ?? 1), bill: 'Bill 1', ref, description, unit,
  rate: { state: 'value', value: rate, text: rate, cell: 'E1', explicitZero: false, formulaStatus: 'none' },
  quantity: { state: 'missing', text: '' }, cells: {}, sourceFile: 'roads.csv', sourceSha256: 'a'.repeat(64), currency: 'AED', ...overrides,
});

const comp = (p: Partial<ScopeComponent> & { id: string; name: string }): ScopeComponent => ({
  action: 'add', discipline: '', workType: '', material: '', specification: '', location: '', searchTerms: [], expectedUnit: '', quantity: null, missingInputs: [], potential: false, potentialReason: '', evidence: [], ...p,
});
const q = (value: string, unit: string) => ({ value, unit, origin: 'stated_in_document' as const, source: 'n', quote: `${value} ${unit}` });
const scopeOf = (components: ScopeComponent[]): ChangeScope => ({ summary: '', location: '', packageName: '', components, contradictions: [], missingInformation: [], limitations: [] });

function setOf(items: BoqItemRecord[]): BoqSet {
  return { items, context: new Map(), files: [] };
}
const shortlistAll = (set: BoqSet, scope: ChangeScope) => Object.fromEntries(scope.components.map((c) => [c.id, set.items.map((item) => ({ item, score: 2, reasons: [], unitCompat: 'same' as const, specConflict: null }))]));
const propose = (lines: [string, string, 'primary' | 'alternative'][]): ModelMatchResult => ({ lines: lines.map(([componentId, rowId, role]) => ({ componentId, rowId, role, why: '', preambleNote: '' })), potentiallyAffected: [], unmatched: [], overlaps: [] });

describe('shared-line identity', () => {
  it('two changes using the same BOQ row keep two distinct lines', () => {
    const r2 = row({ id: 'imp1:Bill 1!2', ref: 'R-02', unit: 'm2', rate: '85', description: 'Asphalt wearing course 50mm' });
    const set = setOf([r2]);
    const scope = scopeOf([
      comp({ id: 'c1', name: 'Asphalt', location: 'Road A', expectedUnit: 'm2', quantity: q('100', 'm2') }),
      comp({ id: 'c2', name: 'Asphalt', location: 'Road B', expectedUnit: 'm2', quantity: q('250', 'm2') }),
    ]);
    const out = assemble(set, scope, propose([['c1', r2.id, 'primary'], ['c2', r2.id, 'primary']]), shortlistAll(set, scope), EMPTY_ANSWERS);
    const { lines } = buildSharedLinesDetailed(scope, out, [], 'AED');
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((l) => l.lineId)).size).toBe(2);
    expect(lines[0].sourceKey).toBe(lines[1].sourceKey);
    expect(lines[0].sharesSourceWith).toEqual([lines[1].lineId]);
    expect(lines.map((l) => l.signedAmount)).toEqual(['8500', '21250']);
  });

  it('never drops a line when two changes would otherwise produce the same key', () => {
    expect(uniqueKeys(['a#x', 'a#x', 'b#y', 'a#x'])).toEqual(['a#x', 'a#x~2', 'b#y', 'a#x~3']);
  });

  it('a line id says WHAT changed and WHERE the price comes from', () => {
    const sk = sourceKeyOf({ importId: 'i1', sheet: 'S', rowNumber: 7 });
    const ck = componentKeyOf({ name: 'Asphalt', action: 'add', location: 'Road A' });
    expect(lineIdOf(sk, ck)).toBe('i1|S|7#asphalt~add~road-a');
    expect(componentKeyOf({ name: 'Asphalt', action: 'omit', location: 'Road A' })).not.toBe(ck);
  });

  it('identical work (same name, action, location) is recognised as one change', () => {
    expect(sameWork(comp({ id: 'a', name: 'Asphalt', location: 'Road B' }), comp({ id: 'b', name: 'asphalt ', location: 'road b' }))).toBe(true);
    expect(sameWork(comp({ id: 'a', name: 'Asphalt', location: 'Road A' }), comp({ id: 'b', name: 'Asphalt', location: 'Road B' }))).toBe(false);
    expect(sameWork(comp({ id: 'a', name: 'Asphalt', action: 'add' }), comp({ id: 'b', name: 'Asphalt', action: 'omit' }))).toBe(false);
  });
});

describe('explicit aggregation', () => {
  const l = (lineId: string, quantity: string | null, amount: string | null, over: Partial<AggLine> = {}): AggLine => ({ lineId, sourceKey: 's1', unit: 'm2', quantity, signedAmount: amount, ...over });

  it('combines lines from one row and unit into an exact decimal quantity', () => {
    const r = checkAggregation([l('a', '100.5', '8542.5'), l('b', '250.25', '21271.25')]);
    expect(r).toMatchObject({ ok: true, combinedQuantity: '350.75' });
  });

  it('refuses different rows, different units or an unknown quantity', () => {
    expect(checkAggregation([l('a', '1', '1'), l('b', '1', '1', { sourceKey: 's2' })]).ok).toBe(false);
    expect(checkAggregation([l('a', '1', '1'), l('b', '1', '1', { unit: 'm3' })]).ok).toBe(false);
    expect(checkAggregation([l('a', '1', '1'), l('b', null, null)]).ok).toBe(false);
    expect(checkAggregation([l('a', '1', '1')]).ok).toBe(false);
  });

  it('retains every member and values the group once', () => {
    const lines = new Map([l('a', '100', '8500'), l('b', '250', '21250')].map((x) => [x.lineId, x]));
    const g: AggregationGroup = { id: 'g1', memberLineIds: ['a', 'b'], reason: 'same pavement', by: 'u', at: '' };
    const v = valueGroup(g, lines);
    expect('error' in v).toBe(false);
    if (!('error' in v)) { expect(v.signedAmount).toBe('29750'); expect(v.memberLineIds).toEqual(['a', 'b']); }
    expect(lines.size).toBe(2);
  });

  it('a group whose member disappears needs review instead of silently pricing', () => {
    const v = valueGroup({ id: 'g', memberLineIds: ['a', 'gone'], reason: '', by: '', at: '' }, new Map([['a', l('a', '1', '1')]]));
    expect('error' in v).toBe(true);
  });
});

describe('composite-rate overlap', () => {
  it('detects a composite rate that already includes separately priced work', () => {
    expect(bundledPhrases('Asphalt wearing course including tack coat, and prime coat')).toEqual(['tack-coat', 'prime-coat']);
    const lines: OverlapLine[] = [
      { lineId: 'L1', componentKey: 'asphalt', sourceKey: 's1', description: 'Asphalt wearing course including tack coat', covers: ['asphalt'], origin: 'boq', included: true },
      { lineId: 'L2', componentKey: 'tack-coat', sourceKey: 's2', description: 'Tack coat', covers: ['tack-coat'], origin: 'boq', included: true },
    ];
    const issues = detectValuationOverlaps(lines);
    expect(issues.map((i) => i.kind)).toEqual(['composite_rate']);
    expect(heldOutByOverlap(issues)).toEqual(new Set(['L2']));
  });

  it('does not flag unrelated work or two changes that merely share a row', () => {
    const lines: OverlapLine[] = [
      { lineId: 'L1', componentKey: 'asphalt~a', sourceKey: 's1', description: 'Asphalt', covers: ['asphalt'], origin: 'boq', included: true },
      { lineId: 'L2', componentKey: 'asphalt~b', sourceKey: 's1', description: 'Asphalt', covers: ['asphalt'], origin: 'boq', included: true },
      { lineId: 'L3', componentKey: 'kerb', sourceKey: 's2', description: 'Kerb', covers: ['kerb'], origin: 'boq', included: true },
    ];
    expect(detectValuationOverlaps(lines)).toEqual([]);
  });

  it('flags one change priced twice from the same row, and an excluded line is ignored', () => {
    const base: OverlapLine = { lineId: 'L1', componentKey: 'asphalt', sourceKey: 's1', description: 'Asphalt', covers: ['asphalt'], origin: 'boq', included: true };
    expect(detectValuationOverlaps([base, { ...base, lineId: 'L2' }]).map((i) => i.kind)).toEqual(['same_source_same_work']);
    expect(detectValuationOverlaps([base, { ...base, lineId: 'L2', included: false }])).toEqual([]);
  });

  it('prevents duplicate valuation between a matched line and an added item linked to the same change', () => {
    const lines: OverlapLine[] = [
      { lineId: 'L1', componentKey: 'asphalt', sourceKey: 's1', description: 'Asphalt', covers: ['asphalt'], origin: 'boq', included: true },
      { lineId: 'N1', componentKey: 'item~n1', sourceKey: 'new|n1', description: 'Asphalt supply', covers: ['item~n1'], linkedComponentKey: 'asphalt', origin: 'new_item', included: true },
    ];
    const issues = detectValuationOverlaps(lines);
    expect(issues.map((i) => i.kind)).toEqual(['manual_linked_duplicate']);
    expect(heldOutByOverlap(issues)).toEqual(new Set(['N1']));
  });
});

describe('manual rate, blank vs zero, new item', () => {
  it('blank is unpriced, explicit zero needs a basis, a value is accepted', () => {
    expect(classifyRate('', '')).toEqual({ ok: true, rate: { state: 'unpriced' } });
    expect(classifyRate('0', '').ok).toBe(false);
    expect(classifyRate('0', 'free-issue by employer')).toMatchObject({ ok: true, rate: { state: 'zero' } });
    expect(classifyRate('12.5', '')).toEqual({ ok: true, rate: { state: 'value', value: '12.5' } });
    expect(classifyRate('-1', '').ok).toBe(false);
  });

  it('a new assessment item with no rate stays unpriced and with a zero basis stays distinct', () => {
    const unpriced = newItemDraftForTest({ unpriced: true });
    const zero = newItemDraftForTest({ rate: '0', zeroBasis: 'free-issue' });
    expect(unpriced.issues).toEqual([]);
    expect(unpriced.preview.state).toBe('unpriced');
    expect(zero.issues).toEqual([]);
    expect(zero.preview.signedAmount).toBe('0');
    expect(newItemDraftForTest({ rate: '0', zeroBasis: '' }).issues.map((i) => i.field)).toContain('zeroBasis');
  });

  it('an omission item is negated exactly once', () => {
    expect(newItemDraftForTest({ changeType: 'omission', quantity: '10', rate: '5' }).preview.signedAmount).toBe('-50');
  });
});

describe('dimensional compatibility', () => {
  it('rejects an incompatible unit and explains it', () => {
    const r = checkItemDimension('nr', 'm2');
    expect(r.ok).toBe(false);
  });

  it('same dimension converts exactly', () => {
    expect(checkItemDimension('mm', 'm')).toMatchObject({ ok: true, factor: '0.001' });
    expect(checkItemDimension('m2', 'm2')).toMatchObject({ ok: true, factor: '1' });
  });

  it('length to area needs a width WITH its evidence; area to volume needs a thickness WITH its evidence', () => {
    const noEv = checkItemDimension('m', 'm2');
    expect(noEv.ok).toBe(false);
    if (!noEv.ok) expect(noEv.required).toEqual(['width']);
    expect(checkItemDimension('m', 'm2', [{ name: 'width', value: '7', unit: 'm', evidence: '' }]).ok).toBe(false);
    expect(checkItemDimension('m', 'm2', [{ name: 'width', value: '7', unit: 'm', evidence: 'Typical section drawing R4-01' }]).ok).toBe(true);
    const vol = checkItemDimension('m2', 'm3');
    expect(vol.ok).toBe(false);
    if (!vol.ok) expect(vol.required).toEqual(['thickness']);
    expect(checkItemDimension('m2', 'm3', [{ name: 'thickness', value: '0.05', unit: 'm', evidence: 'Spec clause 4.2' }]).ok).toBe(true);
  });

  it('refuses a zero or negative supporting dimension', () => {
    expect(checkItemDimension('m', 'm2', [{ name: 'width', value: '0', unit: 'm', evidence: 'x' }]).ok).toBe(false);
  });
});

describe('replacement', () => {
  const by = new Map<string, { signedAmount: string | null }>([['rem', { signedAmount: '-12000' }], ['add', { signedAmount: '15500' }], ['un', { signedAmount: null }], ['bad', { signedAmount: '500' }]]);

  it('models removed and added work explicitly and states the net', () => {
    expect(valueReplacement({ kind: 'explicit', removedLineId: 'rem', addedLineId: 'add' }, by)).toMatchObject({ ok: true, signedAmount: '3500' });
  });

  it('is not a simple addition: a positive "removed" line or an unpriced side is rejected', () => {
    expect(valueReplacement({ kind: 'explicit', removedLineId: 'bad', addedLineId: 'add' }, by).ok).toBe(false);
    expect(valueReplacement({ kind: 'explicit', removedLineId: 'rem', addedLineId: 'un' }, by).ok).toBe(false);
    expect(valueReplacement({ kind: 'explicit', removedLineId: 'rem', addedLineId: 'missing' }, by).ok).toBe(false);
  });

  it('a rate-difference replacement needs evidence', () => {
    const base = { kind: 'rate_difference' as const, oldRate: '85', newRate: '120', unit: 'm2', quantity: '100', currency: 'AED' };
    expect(valueReplacement({ ...base, evidence: '' }, by).ok).toBe(false);
    expect(valueReplacement({ ...base, evidence: 'Same layer, thicker spec' }, by)).toMatchObject({ ok: true, signedAmount: '3500' });
  });
});

describe('totals: priced, unpriced, deferred, excluded, currencies', () => {
  const t = (over: Partial<TotalsLine> & { lineId: string }): TotalsLine => ({ currency: 'AED', signedAmount: null, disposition: 'unpriced', ...over });

  it('keeps priced, unpriced, deferred, excluded and held separate and never calls a partial total complete', () => {
    const s = totalsFor([
      t({ lineId: '1', signedAmount: '1000', disposition: 'priced' }), t({ lineId: '2', signedAmount: '-250', disposition: 'priced' }),
      t({ lineId: '3' }), t({ lineId: '4', disposition: 'deferred' }), t({ lineId: '5', signedAmount: '999', disposition: 'excluded', excludedScope: 'cost_only' }),
      t({ lineId: '6', signedAmount: '77', disposition: 'held_overlap' }),
    ]);
    expect(s.perCurrency).toHaveLength(1);
    expect(s.perCurrency[0]).toMatchObject({ pricedSubtotal: '750', pricedCount: 2, unpricedCount: 1, deferredCount: 1, excludedCount: 1, heldCount: 1, complete: false });
  });

  it('is complete only when nothing is unpriced, deferred or held', () => {
    expect(totalsFor([t({ lineId: '1', signedAmount: '5', disposition: 'priced' })]).perCurrency[0].complete).toBe(true);
  });

  it('never adds different currencies together', () => {
    const s = totalsFor([t({ lineId: '1', signedAmount: '100', disposition: 'priced' }), t({ lineId: '2', currency: 'USD', signedAmount: '40', disposition: 'priced' })]);
    expect(s.mixedCurrency).toBe(true);
    expect(s.perCurrency.map((c) => [c.currency, c.pricedSubtotal])).toEqual([['AED', '100'], ['USD', '40']]);
  });

  it('a cost-only exclusion and a deferral keep schedule scope; a scenario exclusion removes it', () => {
    const s = totalsFor([t({ lineId: '1', disposition: 'excluded', excludedScope: 'cost_only' }), t({ lineId: '2', disposition: 'deferred' }), t({ lineId: '3', disposition: 'excluded', excludedScope: 'scenario' })]);
    expect(s.scheduleScopeRetained).toBe(2);
    expect(s.scheduleScopeRemoved).toBe(1);
  });

  it('decimal arithmetic is exact', () => {
    const s = totalsFor([0.1, 0.2].map((v, i) => t({ lineId: String(i), signedAmount: String(v), disposition: 'priced' })));
    expect(s.perCurrency[0].pricedSubtotal).toBe('0.3');
  });
});

describe('deferral through the real assemble', () => {
  it('a deferred line carries no amount, stays in scope and makes the total partial', () => {
    const r2 = row({ id: 'imp1:Bill 1!2', ref: 'R-02', unit: 'm2', rate: '85' });
    const r4 = row({ id: 'imp1:Bill 1!4', ref: 'R-04', unit: 'm', rate: '95' });
    const set = setOf([r2, r4]);
    const scope = scopeOf([comp({ id: 'c1', name: 'Asphalt', expectedUnit: 'm2', quantity: q('100', 'm2') }), comp({ id: 'c2', name: 'Kerb', expectedUnit: 'm', quantity: q('10', 'm') })]);
    const proposal = propose([['c1', r2.id, 'primary'], ['c2', r4.id, 'primary']]);
    const out = assemble(set, scope, proposal, shortlistAll(set, scope), { ...EMPTY_ANSWERS, resolutions: { c2: { kind: 'deferred', reason: 'awaiting quote', by: 'u', at: 't' } } });
    expect(out.total).toBe('8500');
    expect(out.summary.deferredCount).toBe(1);
    expect(out.summary.fullyPriced).toBe(false);
    expect(out.lines.find((l) => l.componentId === 'c2')?.deferred?.reason).toBe('awaiting quote');
    // Restoring brings the value back.
    expect(assemble(set, scope, proposal, shortlistAll(set, scope), EMPTY_ANSWERS).total).toBe('9450');
  });

  it('a manual rate with an explicit zero needs a basis, and a blank stays unpriced', () => {
    const r2 = row({ id: 'imp1:Bill 1!2', ref: 'R-02', unit: 'm2', rate: '85' });
    const set = setOf([r2]);
    const scope = scopeOf([comp({ id: 'c1', name: 'Barrier', expectedUnit: 'm2', quantity: q('10', 'm2') })]);
    const manual = (value: string, zeroBasis?: string) => ({ ...EMPTY_ANSWERS, chosenRow: { c1: '__none__' }, resolutions: { c1: { kind: 'manual_rate' as const, manual: { value, currency: 'AED', unit: 'm2', reason: 'r', reference: '', attachmentName: '', inclusions: { labour: true, materials: true, plant: true, overheads: true, profit: true }, zeroBasis, enteredBy: 'u', enteredAt: 't', status: 'proposed' as const } } } });
    expect(assemble(set, scope, propose([]), shortlistAll(set, scope), manual('0')).total).toBeNull();
    expect(assemble(set, scope, propose([]), shortlistAll(set, scope), manual('0', 'free-issue')).total).toBe('0');
    expect(assemble(set, scope, propose([]), shortlistAll(set, scope), manual('12')).total).toBe('120');
  });

  it('omission and addition from the same row are valued with opposite signs', () => {
    const r2 = row({ id: 'imp1:Bill 1!2', ref: 'R-02', unit: 'm2', rate: '85' });
    const set = setOf([r2]);
    const scope = scopeOf([
      comp({ id: 'c1', name: 'Asphalt', action: 'omit', location: 'Road A', expectedUnit: 'm2', quantity: q('100', 'm2') }),
      comp({ id: 'c2', name: 'Asphalt', action: 'add', location: 'Road B', expectedUnit: 'm2', quantity: q('140', 'm2') }),
    ]);
    const out = assemble(set, scope, propose([['c1', r2.id, 'primary'], ['c2', r2.id, 'primary']]), shortlistAll(set, scope), EMPTY_ANSWERS);
    expect(out.lines.map((l) => (l.calc && l.calc.ok ? l.calc.signedAmount : null))).toEqual(['-8500', '11900']);
    expect(out.total).toBe('3400');
  });

  it('an incompatible unit never produces a price', () => {
    const r1 = row({ id: 'imp1:Bill 1!1', ref: 'R-01', unit: 'nr', rate: '3500' });
    const set = setOf([r1]);
    const scope = scopeOf([comp({ id: 'c1', name: 'Pavement', expectedUnit: 'm2', quantity: q('100', 'm2') })]);
    const out = assemble(set, scope, propose([['c1', r1.id, 'primary']]), shortlistAll(set, scope), EMPTY_ANSWERS);
    expect(out.total).toBeNull();
  });
});

describe('summariseCost deferral', () => {
  it('counts deferred scope separately and keeps the subtotal partial', () => {
    const l = (o: Partial<SummaryLine>): SummaryLine => ({ key: 'k', componentId: 'c', included: true, signedAmount: null, source: 'none', ...o });
    const s = summariseCost([l({ componentId: 'a', signedAmount: '10', source: 'boq' }), l({ componentId: 'b', deferred: true })], 'AED');
    expect(s).toMatchObject({ pricedSubtotal: '10', deferredCount: 1, unpricedIncluded: 0, fullyPriced: false });
  });
});

describe('persistence and stale invalidation', () => {
  const base = { boqSignature: 'imp1:abc', scopeKeys: ['asphalt|add|road a|100m2'], mapping: { L1: { activityTaskIds: ['T1'] } }, documents: ['pvr.pdf:1200', 'narrative:300'] };

  it('is current when nothing changed, whatever the key order', () => {
    const a = makeFingerprint(base);
    const b = makeFingerprint({ ...base, scopeKeys: [...base.scopeKeys], documents: [...base.documents].reverse() });
    expect(staleReasons(a, b)).toEqual([]);
  });

  it('a revised BOQ, scope quantity, mapping or document marks the right results stale', () => {
    const a = makeFingerprint(base);
    expect(staleReasons(a, makeFingerprint({ ...base, boqSignature: 'imp1:def' }))).toEqual(['boq']);
    expect(staleReasons(a, makeFingerprint({ ...base, scopeKeys: ['asphalt|add|road a|120m2'] }))).toEqual(['scope']);
    expect(staleReasons(a, makeFingerprint({ ...base, mapping: { L1: { activityTaskIds: ['T2'] } } }))).toEqual(['mapping']);
    expect(staleReasons(a, makeFingerprint({ ...base, documents: ['pvr.pdf:1300', 'narrative:300'] }))).toEqual(['documents']);
  });

  it('no saved fingerprint means nothing to compare, not stale', () => {
    expect(staleReasons(null, makeFingerprint(base))).toEqual([]);
  });

  it('fingerprints are deterministic', () => {
    expect(fingerprint({ a: 1 })).toBe(fingerprint({ a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});

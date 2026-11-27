import { describe, expect, it } from 'vitest';
import { EMPTY_ANSWERS, type BoqSet } from './matchEngine';
import { outcomeOf } from './agentClient';
import { PROCESSED_PVR_RATE_BASIS, processedPvrScopeKey, type ManualRate } from './resolutions';
import type { ChangeScope, ModelMatchResult, ScopeComponent } from './scope';
import type { BoqItemRecord } from './types';

const component: ScopeComponent = {
  id: 'c1', name: 'Remove old channel', action: 'omit', workType: 'channel', discipline: '', material: '', specification: 'Medium',
  location: 'Area 2', expectedUnit: 'm', searchTerms: [], quantity: { value: '20', unit: 'm', origin: 'stated_in_document', source: 'Sheet B', quote: '20 m' },
  missingInputs: [], potential: false, potentialReason: '', evidence: [],
};
const rate: ManualRate = {
  processedPvr: { file: 'Processed reference.pdf', page: '2', row: '5; Engineer omission', scopeKey: processedPvrScopeKey(component) },
  value: '9.50', unit: 'L.M.', currency: 'AED', reason: 'Contract BOQ missing', reference: '', attachmentName: '',
  inclusions: { labour: false, materials: false, plant: false, overheads: false, profit: false }, enteredBy: 'Reviewer', enteredAt: '2027-02-01', status: 'proposed',
};
function check(itemAmount: string | null, override: Partial<ManualRate> = {}, scopeChanges: Partial<ScopeComponent> = {}, options: {
  alternatives?: boolean; noPrimary?: boolean; hiddenCandidate?: boolean; selected?: string;
  duplicateWork?: boolean; pricedAlternative?: boolean;
} = {}) {
  const comp = { ...component, ...scopeChanges };
  const items = Array.from({length: options.alternatives || options.pricedAlternative ? 2 : 1}, (_, i) => ({
    id: `r${i}`, ref: `ref${i}`, description: 'Old channel', unit: 'm', currency: 'AED', sourceFile: 'BOQ.xlsx', sheet: 'A', cells: {},
    rate: options.pricedAlternative && i === 1 ? { state: 'value' as const, value: '15', cell: 'F6' } : itemAmount === null ? { state: 'missing' as const, text: '', cell: 'F5' } : { state: 'value' as const, value: itemAmount, text: itemAmount, cell: 'F5' },
  } as BoqItemRecord));
  const set: BoqSet = { items, files: [], context: new Map() };
  const duplicate = { ...comp, id: 'c2' };
  const scope: ChangeScope = { summary: '', location: '', packageName: '', components: options.duplicateWork ? [comp, duplicate] : [comp], contradictions: [], missingInformation: [], limitations: [] };
  const proposal: ModelMatchResult = {
    lines: options.hiddenCandidate ? [] : items.map((item, index) => ({
      componentId: comp.id, rowId: item.id, role: options.noPrimary || (options.pricedAlternative && index === 1) ? 'alternative' : 'primary', why: '', preambleNote: '',
    })), potentiallyAffected: [], overlaps: [], unmatched: [],
  };
  const shortlist = { [comp.id]: items.map((item) => ({ item, score: 1, reasons: [], unitCompat: 'same' as const, specConflict: null })) };
  // The real workspace flow calculates its outcome through this entry point.
  return outcomeOf({ set, scope, proposal, shortlist, events: [], problems: [], cached: { scope: false, match: false }, importSignature: 'boq-test' }, {
    ...EMPTY_ANSWERS, chosenRow: options.selected ? { [comp.id]: options.selected } : {}, resolutions: {
      [comp.id]: { kind: 'manual_rate', manual: { ...rate, ...override } },
      ...(options.duplicateWork ? { [duplicate.id]: { kind: 'manual_rate', manual: { ...rate, processedPvr: { ...rate.processedPvr!, row: 'Other row', scopeKey: processedPvrScopeKey(duplicate) } } } } : {}),
    },
  });
}

describe('processed PVR rate fallback in real valuation', () => {
  it('prices omission once and preserves pilot citation and quantity origin', () => {
    const r = check(null);
    expect(r.total).toBe('-190');
    expect(r.summary.manualProposedCount).toBe(1);
    expect(r.lines[0].manual?.rate.processedPvr).toEqual(rate.processedPvr);
    expect(r.lines[0].quantitySource).toBe('Sheet B');
  });
  it('always prefers the usable BOQ row, including a zero rate', () => {
    expect(check('11').total).toBe('-220');
    expect(check('0').total).toBe('0');
    expect(check('11').summary.manualProposedCount).toBe(0);
  });
  it('does not reuse a fallback on different scope, action, rate unit or currency', () => {
    expect(check(null, {}, { location: 'Area 3' }).total).toBeNull();
    expect(check(null, {}, { action: 'add' }).total).toBeNull();
    expect(check(null, { unit: 'km' }).total).toBeNull();
    expect(check(null, { currency: 'USD' }).total).toBeNull();
  });
  it('does not bypass ambiguous BOQ selection or accept a missing reference page', () => {
    expect(check(null, {}, {}, { alternatives: true }).total).toBeNull();
    expect(check(null, { processedPvr: { ...rate.processedPvr!, page: '' } }).total).toBeNull();
  });
  it('keeps alternatives-only scoped work unpriced, rather than dropping it or silently using a pilot rate', () => {
    const r = check('11', {}, {}, { noPrimary: true });
    expect(r.total).toBeNull();
    expect(r.summary.unpricedIncluded).toBe(1);
    expect(r.needs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'ambiguous_candidates' })]));
    expect(check('11', {}, {}, { noPrimary: true, selected: 'r0' }).total).toBe('-220');
    expect(check('11', {}, {}, { noPrimary: true, selected: '__none__' }).total).toBe('-190');
  });
  it('does not use fallback over a priced alternative or an unreviewed compatible BOQ candidate', () => {
    expect(check(null, {}, {}, { pricedAlternative: true }).total).toBeNull();
    expect(check('11', {}, {}, { hiddenCandidate: true }).total).toBeNull();
    expect(check(null, {}, {}, { pricedAlternative: true, selected: 'r1' }).total).toBe('-300');
  });
  it('checks audit data from stored decisions and does not downgrade a missing pilot citation to a generic rate', () => {
    expect(check(null, { reason: '' }).total).toBeNull();
    expect(check(null, { enteredAt: 'unknown' }).total).toBeNull();
    expect(check(null, { processedPvr: { ...rate.processedPvr!, row: null as unknown as string } }).total).toBeNull();
    expect(check(null, { rateBasis: PROCESSED_PVR_RATE_BASIS, processedPvr: undefined }).total).toBeNull();
  });
  it('does not price the same work twice from distinct processed references or on top of an existing BOQ rate', () => {
    const allPilot = check(null, {}, {}, { duplicateWork: true });
    expect(allPilot.total).toBe('-190');
    expect(allPilot.summary.unpricedIncluded).toBe(1);
    const boqAndPilot = check('11', {}, {}, { duplicateWork: true });
    expect(boqAndPilot.total).toBe('-220');
    expect(boqAndPilot.summary.manualProposedCount).toBe(0);
  });
});

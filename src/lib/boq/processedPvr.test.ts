import { describe, expect, it } from 'vitest';
import { assemble, EMPTY_ANSWERS, type BoqSet } from './matchEngine';
import { processedPvrScopeKey, type ManualRate } from './resolutions';
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
function check(itemAmount: string | null, override: Partial<ManualRate> = {}, scopeChanges: Partial<ScopeComponent> = {}, options: { alternatives?: boolean } = {}) {
  const comp = { ...component, ...scopeChanges };
  const items = Array.from({length: options.alternatives ? 2 : 1}, (_, i) => ({
    id: `r${i}`, ref: `ref${i}`, description: 'Old channel', unit: 'm', currency: 'AED', sourceFile: 'BOQ.xlsx', sheet: 'A', cells: {},
    rate: itemAmount === null ? { state: 'missing' as const, text: '', cell: 'F5' } : { state: 'value' as const, value: itemAmount, text: itemAmount, cell: 'F5' },
  } as BoqItemRecord));
  const set: BoqSet = { items, files: [], context: new Map() };
  const scope: ChangeScope = { summary: '', location: '', packageName: '', components: [comp], contradictions: [], missingInformation: [], limitations: [] };
  const proposal: ModelMatchResult = { lines: items.map((item) => ({ componentId: comp.id, rowId: item.id, role: 'primary', why: '', preambleNote: '' })), potentiallyAffected: [], overlaps: [], unmatched: [] };
  return assemble(set, scope, proposal, { [comp.id]: items.map((item) => ({ item, score: 1, reasons: [], unitCompat: 'same', specConflict: null })) },
    { ...EMPTY_ANSWERS, resolutions: { [comp.id]: { kind: 'manual_rate', manual: { ...rate, ...override } } } });
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
});

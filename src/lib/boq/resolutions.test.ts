import { describe, expect, it } from 'vitest';
import { describeChange, priceWithManualRate, staleEffects, summariseCost, type LineResolution, type SummaryLine } from './resolutions';

const price = (over: Partial<Parameters<typeof priceWithManualRate>[0]> = {}) =>
  priceWithManualRate({ quantity: '8400', quantityUnit: 'm3', rate: '25', rateUnit: 'm3', currency: 'AED', direction: 'addition', ...over });

describe('manual rate pricing', () => {
  it('8,400 m3 at AED 25/m3 gives AED 210,000', () => {
    const r = price();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.signedAmount).toBe('210000');
  });

  it('an m2 rate cannot price an m3 quantity', () => {
    const r = price({ rateUnit: 'm2' });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.kind).toBe('dimension_mismatch'); expect(r.message).toMatch(/cannot price/); }
  });

  it('a blank rate stays unpriced and an explicit zero stays zero', () => {
    const blank = price({ rate: '' });
    expect(blank.ok).toBe(false);
    const zero = price({ rate: '0' });
    expect(zero.ok).toBe(true);
    if (zero.ok) expect(zero.signedAmount).toBe('0');
  });

  it('omission is negated exactly once', () => {
    const r = price({ direction: 'omission' });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.signedAmount).toBe('-210000'); expect(r.amount).toBe('210000'); }
  });

  it('same-dimension conversion (mm to m) goes through the existing conversion logic', () => {
    const r = priceWithManualRate({ quantity: '2000', quantityUnit: 'mm', rate: '10', rateUnit: 'm', currency: 'AED', direction: 'addition' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.signedAmount).toBe('20');
  });

  it('rejects a negative rate and a non-numeric rate', () => {
    expect(price({ rate: '-5' }).ok).toBe(false);
    expect(price({ rate: 'abc' }).ok).toBe(false);
  });
});

const line = (over: Partial<SummaryLine>): SummaryLine => ({ key: 'k', componentId: 'c', included: true, signedAmount: null, source: 'none', ...over });

describe('partial cost summary', () => {
  it('keeps priced, unpriced, excluded and manual amounts separate', () => {
    const s = summariseCost([
      line({ componentId: 'a', signedAmount: '1000', source: 'boq' }),
      line({ componentId: 'b', signedAmount: '210000', source: 'manual_proposed' }),
      line({ componentId: 'c' }),
      line({ componentId: 'd', included: false, signedAmount: '999', excludedScope: 'cost_only' }),
      line({ componentId: 'e', included: false, excludedScope: 'scenario' }),
    ], 'AED');
    expect(s.pricedSubtotal).toBe('211000');
    expect(s.unpricedIncluded).toBe(1);
    expect(s.excludedCount).toBe(2);
    expect(s.excludedCostOnly).toBe(1);
    expect(s.excludedScenario).toBe(1);
    expect(s.manualProposedAmount).toBe('210000');
    expect(s.fullyPriced).toBe(false);
  });

  it('is fully priced only when no included line is unpriced', () => {
    expect(summariseCost([line({ signedAmount: '5', source: 'boq' })], 'AED').fullyPriced).toBe(true);
    expect(summariseCost([line({ signedAmount: '5', source: 'boq' }), line({ componentId: 'x' })], 'AED').fullyPriced).toBe(false);
  });

  it('does not invent a value when nothing is priced', () => {
    expect(summariseCost([line({})], 'AED').pricedSubtotal).toBeNull();
  });

  it('excluding a line removes it from the subtotal and restoring brings it back', () => {
    const base = [line({ componentId: 'a', signedAmount: '100', source: 'boq' }), line({ componentId: 'b', signedAmount: '-40', source: 'boq' })];
    expect(summariseCost(base, 'AED').pricedSubtotal).toBe('60');
    const excluded = [base[0], { ...base[1], included: false, excludedScope: 'cost_only' as const }];
    expect(summariseCost(excluded, 'AED').pricedSubtotal).toBe('100');
    expect(summariseCost(base, 'AED').pricedSubtotal).toBe('60');
  });
});

describe('stale rules', () => {
  const costOnly: LineResolution = { kind: 'excluded', scope: 'cost_only', reason: 'x', by: 'u', at: 't' };
  const scenario: LineResolution = { kind: 'excluded', scope: 'scenario', reason: 'x', by: 'u', at: 't' };

  it('cost-only changes do not invalidate schedule results', () => {
    expect(staleEffects(describeChange(undefined, costOnly)).schedule).toBe(false);
    expect(staleEffects(describeChange(costOnly, undefined)).schedule).toBe(false);
    expect(staleEffects('rate').schedule).toBe(false);
  });

  it('scenario-wide exclusion and its restore invalidate schedule results', () => {
    expect(staleEffects(describeChange(undefined, scenario)).schedule).toBe(true);
    expect(staleEffects(describeChange(scenario, undefined)).schedule).toBe(true);
  });
});

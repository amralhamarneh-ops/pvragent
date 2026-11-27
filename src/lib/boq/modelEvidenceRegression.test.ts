import { describe, expect, it } from 'vitest';
import { sanitiseMatch, sanitiseScope, type ScopeEvidenceInput } from './agentSchemas';

const doc = (name: string, text: string, extracted = true): ScopeEvidenceInput => ({ name, text, extracted, kind: 'pvr', note: '' });
const reply = (value: string, unit: string, quote: string, source = 'Benchmark answer sheet') => ({ components: [
  { id: 'a', name: 'New gravel strip', action: 'add', quantity: { value, unit, quote, source, origin: 'measured_from_geometry' } },
] });

describe('synthetic reviewed scope claims', () => {
  it('binds a verified numeric-unit pair to the actual evidence source without claiming geometry', () => {
    const quote = 'Measured from drawings: install 1,250.50 m² of gravel strip';
    const out = sanitiseScope(reply('1250.5', 'sqm', quote), [doc('Current instruction.txt', quote)], '');
    expect(out.scope?.components[0].quantity).toEqual({ value: '1250.5', unit: 'sqm', quote, source: 'Current instruction.txt', origin: 'stated_in_document' });
  });

  it.each([
    ['20', 'm', '20 m', 'Install 120 m of gravel strip.'],
    ['50', 'm', '50 m', 'Install 1,050 m of gravel strip.'],
    ['5', 'm', '5 m', 'Install 2.5 m of gravel strip.'],
    ['120', 'm', '120 m²', 'Install 120 m².'],
    ['20', 'm', '20 m', 'Install 20 m².'],
    ['20', 'm', 'Remove 20 nr and reuse 10 m', 'Remove 20 nr and reuse 10 m.'],
    ['20', 'm', '20 m', 'Adjustment -20 m.'],
    ['20', 'm', '20 m', 'Use 20 m/s.'],
  ])('rejects partial or mismatched source claim %s %s (%s)', (value, unit, quote, source) => {
    const out = sanitiseScope(reply(value, unit, quote), [], source);
    expect(out.scope?.components[0].quantity).toBeNull();
    expect(out.problems).toHaveLength(1);
  });

  it('holds an unknown change action for review rather than assuming an addition is authoritative', () => {
    const quote = 'Remove 5 m of gravel.';
    const input = reply('5', 'm', quote);
    input.components[0].action = 'not supported';
    expect(sanitiseScope(input, [], quote).scope?.components[0]).toMatchObject({ potential: true, quantity: null });
  });

  it('does not source a quote from unreadable evidence or misattribute a duplicate', () => {
    const quote = 'Install 5 m of gravel.';
    expect(sanitiseScope(reply('5', 'm', quote), [doc('Unreadable.pdf', quote, false)], '').scope?.components[0].quantity).toBeNull();
    expect(sanitiseScope(reply('5', 'm', quote), [doc('Current scope.txt', quote)], quote).scope?.components[0].quantity).toBeNull();
    expect(sanitiseScope(reply('5', 'm', quote, 'Current scope.txt'), [doc('Current scope.txt', quote)], quote).scope?.components[0].quantity?.source).toBe('Current scope.txt');
  });
});

describe('synthetic reviewed BOQ matches', () => {
  it('does not let unseen benchmark IDs, unknown roles or contradictory duplicate roles become primary', () => {
    const model = { lines: [
      { componentId: 'a', rowId: 'reviewed-reference-only', role: 'primary' },
      { componentId: 'toString', rowId: 'active-row', role: 'primary' },
      { componentId: 'potential', rowId: 'active-row', role: 'primary' },
      { componentId: 'a', rowId: 'invalid-role', role: 'automatic' },
      { componentId: 'a', rowId: 'active-row', role: 'primary' },
      { componentId: 'a', rowId: 'active-row', role: 'alternative' },
    ], overlaps: [{ rowIds: ['active-row', 'reviewed-reference-only'], reason: 'model says so' }] };
    const out = sanitiseMatch(model, { a: ['active-row', 'invalid-role'], potential: [] });
    expect(out.match?.lines.map(({ rowId, role }) => [rowId, role])).toEqual([['active-row', 'alternative']]);
    expect(out.match?.overlaps).toEqual([]);
    expect(out.problems).toHaveLength(6);
  });
});

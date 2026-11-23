import { describe, expect, it } from 'vitest';
import { canonUnit, convertQuantity, dimensionOf, planConversion } from './units';

const src = (statement: string) => ({ kind: 'source' as const, statement });
const mine = (statement: string) => ({ kind: 'user_confirmed' as const, statement });

describe('unit classification', () => {
  it('maps spellings to one canonical unit and a dimension', () => {
    expect(canonUnit('Sq.M')).toBe('m2');
    expect(canonUnit('m²')).toBe('m2');
    expect(canonUnit('Nos')).toBe('nr');
    expect(dimensionOf('mm')).toBe('length');
    expect(dimensionOf('ha')).toBe('area');
    expect(dimensionOf('kg')).toBe('mass');
    expect(dimensionOf('furlong')).toBe('unknown');
  });

  it('separates same-dimension, derivation and invalid', () => {
    expect(planConversion('mm', 'm').kind).toBe('same_dimension');
    expect(planConversion('m', 'm²').kind).toBe('needs_derivation');
    expect(planConversion('m²', 'm³').kind).toBe('needs_derivation');
    expect(planConversion('nr', 'm').kind).toBe('needs_derivation');
    expect(planConversion('m', 'nr').kind).toBe('invalid');
    expect(planConversion('kg', 'm').kind).toBe('invalid');
    expect(planConversion('ls', 'm').kind).toBe('invalid');
    expect(planConversion('m', 'm').kind).toBe('identity');
  });
});

describe('convertQuantity', () => {
  it('same-dimension conversions are exact and need no inputs', () => {
    const r = convertQuantity({ quantity: '2500', fromUnit: 'mm', toUnit: 'm' });
    expect(r.ok && r.converted.toString()).toBe('2.5');
    const ha = convertQuantity({ quantity: '20000', fromUnit: 'm²', toUnit: 'ha' });
    expect(ha.ok && ha.converted.toString()).toBe('2');
  });

  it('100 m to m² needs a width, its unit and a basis', () => {
    expect(convertQuantity({ quantity: '100', fromUnit: 'm', toUnit: 'm²' }).ok).toBe(false);
    expect(convertQuantity({ quantity: '100', fromUnit: 'm', toUnit: 'm²', inputs: [{ name: 'width', value: '3', unit: 'm' }] }).ok).toBe(false);
    const ok = convertQuantity({ quantity: '100', fromUnit: 'm', toUnit: 'm²', inputs: [{ name: 'width', value: '3', unit: 'm' }], basis: mine('Typical width') });
    expect(ok.ok && ok.converted.toString()).toBe('300');
    if (ok.ok) { expect(ok.audit.type).toBe('derivation'); expect(ok.audit.originalQuantity).toBe('100'); expect(ok.audit.derivedQuantity).toBe('300'); }
  });

  it('area to volume needs thickness', () => {
    expect(convertQuantity({ quantity: '300', fromUnit: 'm²', toUnit: 'm³' }).ok).toBe(false);
    const r = convertQuantity({ quantity: '300', fromUnit: 'm²', toUnit: 'm³', inputs: [{ name: 'thickness', value: '250', unit: 'mm' }], basis: src('Spec 4.2') });
    expect(r.ok && r.converted.toString()).toBe('75');
  });

  it('length to volume needs width and depth', () => {
    expect(convertQuantity({ quantity: '10', fromUnit: 'm', toUnit: 'm³', inputs: [{ name: 'width', value: '1', unit: 'm' }], basis: src('x') }).ok).toBe(false);
    const r = convertQuantity({ quantity: '10', fromUnit: 'm', toUnit: 'm³', inputs: [{ name: 'width', value: '1', unit: 'm' }, { name: 'depth', value: '500', unit: 'mm' }], basis: src('Trench detail') });
    expect(r.ok && r.converted.toString()).toBe('5');
  });

  it('counts need a per-item basis; nothing converts to a count', () => {
    expect(convertQuantity({ quantity: '12', fromUnit: 'nr', toUnit: 'm' }).ok).toBe(false);
    expect(convertQuantity({ quantity: '12', fromUnit: 'nr', toUnit: 'm²' }).ok).toBe(false);
    const r = convertQuantity({ quantity: '12', fromUnit: 'nr', toUnit: 'm', inputs: [{ name: 'length per item', value: '2.5', unit: 'm' }], basis: src('Datasheet') });
    expect(r.ok && r.converted.toString()).toBe('30');
    const toCount = convertQuantity({ quantity: '12', fromUnit: 'm', toUnit: 'nr' });
    expect(!toCount.ok && toCount.kind).toBe('unsupported');
  });

  it('invalid pairs stay invalid even when inputs and a basis are typed', () => {
    const r = convertQuantity({ quantity: '5', fromUnit: 'kg', toUnit: 'm', inputs: [{ name: 'width', value: '2', unit: 'm' }], basis: mine('trust me') });
    expect(!r.ok && r.kind).toBe('unsupported');
    const lump = convertQuantity({ quantity: '1', fromUnit: 'ls', toUnit: 'm' });
    expect(lump.ok).toBe(false);
    expect(!lump.ok && lump.kind).toBe('unsupported');
    expect(convertQuantity({ quantity: '1', fromUnit: 'furlong', toUnit: 'm' }).ok).toBe(false);
  });

  it('rejects zero or non-numeric supporting values and blank bases', () => {
    const base = { quantity: '100', fromUnit: 'm', toUnit: 'm²' };
    expect(convertQuantity({ ...base, inputs: [{ name: 'width', value: '0', unit: 'm' }], basis: src('x') }).ok).toBe(false);
    expect(convertQuantity({ ...base, inputs: [{ name: 'width', value: 'abc', unit: 'm' }], basis: src('x') }).ok).toBe(false);
    expect(convertQuantity({ ...base, inputs: [{ name: 'width', value: '3', unit: 'parsec' }], basis: src('x') }).ok).toBe(false);
    expect(convertQuantity({ ...base, inputs: [{ name: 'width', value: '3', unit: 'm' }], basis: src('   ') }).ok).toBe(false);
  });
});

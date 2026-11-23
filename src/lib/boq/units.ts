import { D, Dec } from '../assessment/decimal';

/**
 * Unit dimensions and conversion rules.
 *
 * Three outcomes, never mixed up:
 *  1. same_dimension : mm -> m, m2 -> ha. Exact built-in factors. No user input needed.
 *  2. derivation     : needs extra measured dimensions (length x width = area). Needs explicit inputs and a basis.
 *  3. invalid        : no defensible conversion. A bare "factor" can never bridge different dimensions.
 */

export type Dimension = 'length' | 'area' | 'volume' | 'mass' | 'count' | 'lump' | 'unknown';

interface UnitDef { key: string; dimension: Dimension; /** Multiply by this to get the dimension's base unit (m, m2, m3, kg). */ toBase: string }

const UNITS: Record<string, UnitDef> = {
  mm: { key: 'mm', dimension: 'length', toBase: '0.001' },
  cm: { key: 'cm', dimension: 'length', toBase: '0.01' },
  m: { key: 'm', dimension: 'length', toBase: '1' },
  km: { key: 'km', dimension: 'length', toBase: '1000' },
  mm2: { key: 'mm2', dimension: 'area', toBase: '0.000001' },
  cm2: { key: 'cm2', dimension: 'area', toBase: '0.0001' },
  m2: { key: 'm2', dimension: 'area', toBase: '1' },
  ha: { key: 'ha', dimension: 'area', toBase: '10000' },
  km2: { key: 'km2', dimension: 'area', toBase: '1000000' },
  l: { key: 'l', dimension: 'volume', toBase: '0.001' },
  m3: { key: 'm3', dimension: 'volume', toBase: '1' },
  g: { key: 'g', dimension: 'mass', toBase: '0.001' },
  kg: { key: 'kg', dimension: 'mass', toBase: '1' },
  t: { key: 't', dimension: 'mass', toBase: '1000' },
  nr: { key: 'nr', dimension: 'count', toBase: '1' },
  ls: { key: 'ls', dimension: 'lump', toBase: '1' },
  item: { key: 'item', dimension: 'lump', toBase: '1' },
};

const ALIASES: Record<string, string> = {
  'm²': 'm2', sqm: 'm2', 'sq.m': 'm2', squaremetre: 'm2', squaremeter: 'm2',
  'mm²': 'mm2', 'cm²': 'cm2', 'km²': 'km2', hectare: 'ha',
  'm³': 'm3', cum: 'm3', 'cu.m': 'm3', cubicmetre: 'm3', cubicmeter: 'm3', litre: 'l', liter: 'l', ltr: 'l',
  lm: 'm', linm: 'm', metre: 'm', meter: 'm', mtr: 'm', mtrs: 'm', millimetre: 'mm', millimeter: 'mm', kilometre: 'km', kilometer: 'km',
  no: 'nr', nos: 'nr', number: 'nr', each: 'nr', ea: 'nr',
  kgs: 'kg', tonne: 't', ton: 't', tonnes: 't', sum: 'ls', lumpsum: 'ls',
};

/** Canonical unit key, e.g. "Sq.M" -> "m2". Unknown units are returned lower-cased and trimmed. */
export function canonUnit(u: string): string {
  const t = u.trim().toLowerCase().replace(/\s+/g, '');
  const noDots = t.replace(/\./g, '');
  return ALIASES[t] ?? ALIASES[noDots] ?? noDots;
}

export function unitInfo(u: string): UnitDef | null {
  return UNITS[canonUnit(u)] ?? null;
}

export function dimensionOf(u: string): Dimension {
  return unitInfo(u)?.dimension ?? 'unknown';
}

export type BasisKind = 'source' | 'user_confirmed';

export interface DerivationInput {
  /** Which supporting dimension this is, e.g. "width", "thickness", "depth", "length per item". */
  name: string;
  value: string;
  unit: string;
}

export interface DerivationBasis {
  kind: BasisKind;
  /** The source document/cell, or the person's statement of the assumption. Required. */
  statement: string;
}

export interface ConversionAudit {
  type: 'identity' | 'same_dimension' | 'derivation';
  originalQuantity: string;
  originalUnit: string;
  derivedQuantity: string;
  derivedUnit: string;
  /** Plain-language derivation shown before valuation. */
  derivation: string;
  supportingInputs: { name: string; value: string; unit: string; valueInBaseUnit: string }[];
  basis: DerivationBasis | null;
}

export type ConversionPlan =
  | { kind: 'identity' }
  | { kind: 'same_dimension'; factor: string }
  | { kind: 'needs_derivation'; from: Dimension; to: Dimension; required: string[]; explanation: string }
  | { kind: 'invalid'; reason: string };

/** What does converting quantity unit `from` into BOQ unit `to` require? */
export function planConversion(from: string, to: string): ConversionPlan {
  const f = unitInfo(from);
  const t = unitInfo(to);
  if (canonUnit(from) === canonUnit(to) && canonUnit(from) !== '') return { kind: 'identity' };
  if (!f) return { kind: 'invalid', reason: `The change unit "${from}" is not a recognised unit, so it cannot be converted.` };
  if (!t) return { kind: 'invalid', reason: `The BOQ unit "${to}" is not a recognised unit, so a quantity cannot be converted to it.` };
  if (f.dimension === 'lump' || t.dimension === 'lump') return { kind: 'invalid', reason: 'Lump sums and items have no measurable quantity to convert.' };
  if (f.dimension === t.dimension) {
    if (f.dimension === 'count') return { kind: 'identity' };
    return { kind: 'same_dimension', factor: D(f.toBase).div(D(t.toBase)).toString() };
  }
  if (f.dimension === 'length' && t.dimension === 'area') return { kind: 'needs_derivation', from: 'length', to: 'area', required: ['width'], explanation: `Area = length × width. A width, its unit and its source or your confirmation are required to turn ${from} into ${to}.` };
  if (f.dimension === 'area' && t.dimension === 'volume') return { kind: 'needs_derivation', from: 'area', to: 'volume', required: ['thickness'], explanation: `Volume = area × thickness (or depth). A thickness, its unit and its source or your confirmation are required to turn ${from} into ${to}.` };
  if (f.dimension === 'length' && t.dimension === 'volume') return { kind: 'needs_derivation', from: 'length', to: 'volume', required: ['width', 'depth'], explanation: `Volume = length × width × depth. A width and a depth, their units and their source or your confirmation are required to turn ${from} into ${to}.` };
  if (f.dimension === 'count' && (t.dimension === 'length' || t.dimension === 'area' || t.dimension === 'volume' || t.dimension === 'mass')) {
    return { kind: 'needs_derivation', from: 'count', to: t.dimension, required: [`${t.dimension} per item`], explanation: `A count has no ${t.dimension} on its own. State how many ${to} one item represents, with its source or your confirmation.` };
  }
  if (t.dimension === 'count') return { kind: 'invalid', reason: `${from} cannot be converted to a count of items. Re-measure the work as a number of items.` };
  if (f.dimension === 'volume' && t.dimension === 'area') return { kind: 'needs_derivation', from: 'volume', to: 'area', required: ['thickness'], explanation: `Area = volume ÷ thickness. A thickness, its unit and its source or your confirmation are required.` };
  if (f.dimension === 'area' && t.dimension === 'length') return { kind: 'needs_derivation', from: 'area', to: 'length', required: ['width'], explanation: `Length = area ÷ width. A width, its unit and its source or your confirmation are required.` };
  return { kind: 'invalid', reason: `${from} (${f.dimension}) cannot be converted to ${to} (${t.dimension}). No supported derivation exists between these dimensions.` };
}

function clean(s: string): string { return s.replace(/,/g, '').trim(); }
function isPositiveDecimal(s: string): boolean { return /^(\d+(\.\d+)?|\.\d+)$/.test(clean(s)) && !D(clean(s)).isZero(); }

export type ConvertOutcome =
  | { ok: true; converted: Dec; audit: ConversionAudit }
  | { ok: false; kind: 'unit_mismatch' | 'invalid_input' | 'unsupported'; message: string; plan?: ConversionPlan };

export interface ConvertArgs {
  quantity: string;
  fromUnit: string;
  toUnit: string;
  inputs?: DerivationInput[];
  basis?: DerivationBasis | null;
}

/** Convert a user quantity into the BOQ unit. Never applies a generic factor across dimensions. */
export function convertQuantity(args: ConvertArgs): ConvertOutcome {
  const qtyText = clean(args.quantity);
  const qty = D(qtyText);
  const plan = planConversion(args.fromUnit, args.toUnit);

  if (plan.kind === 'invalid') return { ok: false, kind: 'unsupported', message: plan.reason, plan };

  if (plan.kind === 'identity') {
    return { ok: true, converted: qty, audit: { type: 'identity', originalQuantity: qtyText, originalUnit: args.fromUnit, derivedQuantity: qty.toString(), derivedUnit: args.toUnit, derivation: 'Units match. No conversion applied.', supportingInputs: [], basis: null } };
  }

  if (plan.kind === 'same_dimension') {
    const converted = qty.mul(plan.factor);
    return { ok: true, converted, audit: { type: 'same_dimension', originalQuantity: qtyText, originalUnit: args.fromUnit, derivedQuantity: converted.toString(), derivedUnit: args.toUnit, derivation: `${qtyText} ${args.fromUnit} × ${plan.factor} = ${converted.toString()} ${args.toUnit} (same-dimension conversion)`, supportingInputs: [], basis: null } };
  }

  // Derivation: explicit inputs plus a stated basis are mandatory.
  const inputs = args.inputs ?? [];
  const missing = plan.required.filter((name) => !inputs.some((i) => i.name === name));
  if (missing.length > 0) return { ok: false, kind: 'unit_mismatch', message: `${plan.explanation} Missing: ${missing.join(', ')}.`, plan };
  const supporting: ConversionAudit['supportingInputs'] = [];
  for (const name of plan.required) {
    const inp = inputs.find((i) => i.name === name)!;
    if (!isPositiveDecimal(inp.value)) return { ok: false, kind: 'invalid_input', message: `Enter a positive number for ${name}.`, plan };
    const info = unitInfo(inp.unit);
    if (!info) return { ok: false, kind: 'invalid_input', message: `Enter a recognised unit for ${name} (for example m or mm).`, plan };
    supporting.push({ name, value: clean(inp.value), unit: inp.unit.trim(), valueInBaseUnit: D(clean(inp.value)).mul(info.toBase).toString() });
  }
  const basis = args.basis ?? null;
  if (!basis || basis.statement.trim() === '') return { ok: false, kind: 'unit_mismatch', message: `${plan.explanation} State the source of the ${plan.required.join(' and ')} or confirm it as your assumption.`, plan };

  const from = unitInfo(args.fromUnit)!;
  const to = unitInfo(args.toUnit)!;
  const qBase = qty.mul(from.toBase);
  const dims = (n: string) => D(supporting.find((s) => s.name === n)!.valueInBaseUnit);
  const dimUnit = (n: string) => { const s = supporting.find((x) => x.name === n)!; return `${s.value} ${s.unit}`; };
  let baseResult: Dec;
  let expr: string;

  if (plan.from === 'length' && plan.to === 'area') { baseResult = qBase.mul(dims('width')); expr = `${qtyText} ${args.fromUnit} (length) × ${dimUnit('width')} (width)`; }
  else if (plan.from === 'area' && plan.to === 'volume') { baseResult = qBase.mul(dims('thickness')); expr = `${qtyText} ${args.fromUnit} (area) × ${dimUnit('thickness')} (thickness)`; }
  else if (plan.from === 'length' && plan.to === 'volume') { baseResult = qBase.mul(dims('width')).mul(dims('depth')); expr = `${qtyText} ${args.fromUnit} (length) × ${dimUnit('width')} (width) × ${dimUnit('depth')} (depth)`; }
  else if (plan.from === 'volume' && plan.to === 'area') { baseResult = qBase.div(dims('thickness')); expr = `${qtyText} ${args.fromUnit} (volume) ÷ ${dimUnit('thickness')} (thickness)`; }
  else if (plan.from === 'area' && plan.to === 'length') { baseResult = qBase.div(dims('width')); expr = `${qtyText} ${args.fromUnit} (area) ÷ ${dimUnit('width')} (width)`; }
  else if (plan.from === 'count') { const per = plan.required[0]; baseResult = qBase.mul(dims(per)); expr = `${qtyText} ${args.fromUnit} × ${dimUnit(per)}`; }
  else return { ok: false, kind: 'unsupported', message: 'No derivation is defined for this unit pair.', plan };

  const converted = baseResult.div(to.toBase);
  const basisText = basis.kind === 'source' ? `source: ${basis.statement.trim()}` : `user-confirmed assumption: ${basis.statement.trim()}`;
  return { ok: true, converted, audit: { type: 'derivation', originalQuantity: qtyText, originalUnit: args.fromUnit, derivedQuantity: converted.toString(), derivedUnit: args.toUnit, derivation: `${expr} = ${converted.toString()} ${args.toUnit} (${basisText})`, supportingInputs: supporting, basis } };
}

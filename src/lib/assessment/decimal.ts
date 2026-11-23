/**
 * Deterministic decimal arithmetic using BigInt scaled integers.
 * Values keep source precision internally (scale = 12). Rounding is explicit and configurable.
 */

export type RoundingMode = 'half_up' | 'half_even' | 'down' | 'up';

const SCALE = 12;
const FACTOR = BigInt(10) ** BigInt(SCALE);

export class Dec {
  readonly raw: bigint;
  private constructor(raw: bigint) {
    this.raw = raw;
  }

  static of(value: string | number | Dec): Dec {
    if (value instanceof Dec) return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(`Non-finite number: ${value}`);
      return Dec.parse(numToString(value));
    }
    return Dec.parse(value);
  }

  private static parse(input: string): Dec {
    const s = input.trim().replace(/,/g, '');
    const m = /^([+-])?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
    if (!m) throw new Error(`Invalid decimal: "${input}"`);
    const sign = m[1] === '-' ? BigInt(-1) : BigInt(1);
    let intPart = m[2];
    let frac = m[3] ?? '';
    const exp = m[4] ? parseInt(m[4], 10) : 0;
    if (exp > 0) {
      const pad = frac.padEnd(exp, '0');
      intPart += pad.slice(0, exp);
      frac = pad.slice(exp);
    } else if (exp < 0) {
      const all = intPart.padStart(-exp + 1, '0');
      frac = all.slice(all.length + exp) + frac;
      intPart = all.slice(0, all.length + exp);
    }
    const fracScaled = frac.length > SCALE ? frac.slice(0, SCALE) : frac.padEnd(SCALE, '0');
    return new Dec(sign * (BigInt(intPart || '0') * FACTOR + BigInt(fracScaled || '0')));
  }

  static zero(): Dec {
    return new Dec(BigInt(0));
  }

  add(o: Dec | string | number): Dec {
    return new Dec(this.raw + Dec.of(o).raw);
  }
  sub(o: Dec | string | number): Dec {
    return new Dec(this.raw - Dec.of(o).raw);
  }
  mul(o: Dec | string | number): Dec {
    return new Dec((this.raw * Dec.of(o).raw) / FACTOR);
  }
  div(o: Dec | string | number): Dec {
    const d = Dec.of(o);
    if (d.raw === BigInt(0)) throw new Error('Division by zero');
    return new Dec((this.raw * FACTOR) / d.raw);
  }
  neg(): Dec {
    return new Dec(-this.raw);
  }
  abs(): Dec {
    return this.raw < BigInt(0) ? this.neg() : this;
  }
  cmp(o: Dec | string | number): number {
    const d = Dec.of(o);
    return this.raw === d.raw ? 0 : this.raw < d.raw ? -1 : 1;
  }
  isZero(): boolean {
    return this.raw === BigInt(0);
  }
  isNeg(): boolean {
    return this.raw < BigInt(0);
  }
  gt(o: Dec | string | number): boolean {
    return this.cmp(o) > 0;
  }
  lt(o: Dec | string | number): boolean {
    return this.cmp(o) < 0;
  }

  /** Round to `places` decimal places using the chosen mode. */
  round(places: number, mode: RoundingMode = 'half_up'): Dec {
    if (places >= SCALE) return this;
    const unit = BigInt(10) ** BigInt(SCALE - places);
    const neg = this.raw < BigInt(0);
    const abs = neg ? -this.raw : this.raw;
    const q = abs / unit;
    const r = abs % unit;
    const half = unit / BigInt(2);
    let res = q;
    if (mode === 'up') res = r > BigInt(0) ? q + BigInt(1) : q;
    else if (mode === 'down') res = q;
    else if (mode === 'half_up') res = r >= half ? q + BigInt(1) : q;
    else res = r > half ? q + BigInt(1) : r < half ? q : q % BigInt(2) === BigInt(0) ? q : q + BigInt(1);
    return new Dec((neg ? -res : res) * unit);
  }

  toNumber(): number {
    return Number(this.toString());
  }

  /** Plain string with trailing zeros trimmed. */
  toString(): string {
    const neg = this.raw < BigInt(0);
    const abs = neg ? -this.raw : this.raw;
    const ip = abs / FACTOR;
    const fp = (abs % FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
    return `${neg ? '-' : ''}${ip.toString()}${fp ? '.' + fp : ''}`;
  }

  toFixed(places: number, mode: RoundingMode = 'half_up'): string {
    const r = this.round(places, mode);
    const neg = r.raw < BigInt(0);
    const abs = neg ? -r.raw : r.raw;
    const ip = abs / FACTOR;
    const fp = (abs % FACTOR).toString().padStart(SCALE, '0').slice(0, places);
    return `${neg && !r.isZero() ? '-' : ''}${ip.toString()}${places > 0 ? '.' + fp : ''}`;
  }
}

function numToString(n: number): string {
  const s = String(n);
  if (/e/i.test(s)) return n.toFixed(SCALE);
  return s;
}

export const D = (v: string | number | Dec): Dec => Dec.of(v);

export function sumDec(values: Dec[]): Dec {
  return values.reduce((a, b) => a.add(b), Dec.zero());
}

export function formatMoney(v: Dec, currency: string, places = 2): string {
  const fixed = v.toFixed(places);
  const [i, f] = fixed.split('.');
  const neg = i.startsWith('-');
  const digits = neg ? i.slice(1) : i;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency} ${neg ? '-' : ''}${grouped}${f ? '.' + f : ''}`;
}

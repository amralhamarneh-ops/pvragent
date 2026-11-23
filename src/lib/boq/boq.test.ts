import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { buildImport, confirmImport, stageUpload } from './importFlow';
import { calculateChange, canonUnit, recordsFromImport, searchItems } from './calc';
import { MemoryCaseStore, newCase, nextRevision, selectedImportOf } from './store';
import { parseCsvText } from './readers';
import type { BoqImport, CaseRecord, SheetMapping } from './types';

const enc = (s: string) => new TextEncoder().encode(s);

// The synthetic BOQ file from the brief, as an actual CSV file.
const BOQ_V1_CSV = ['Item,Description,Unit,Qty,Rate,Amount', 'TEST-001,Pavement,m²,0,10,0', 'TEST-002,Kerb,m,0,25,0', 'TEST-003,Culvert,m,0,,'].join('\n');
// Revised file: pavement rate changed 10 -> 12. Everything else is identical.
const BOQ_V2_CSV = ['Item,Description,Unit,Qty,Rate,Amount', 'TEST-001,Pavement,m²,0,12,0', 'TEST-002,Kerb,m,0,25,0', 'TEST-003,Culvert,m,0,,'].join('\n');

/** Upload a file through the same path the UI uses and return the stored, confirmed import. */
async function uploadAndConfirm(store: MemoryCaseStore, c: CaseRecord, fileName: string, bytes: Uint8Array, label: string, mappings?: (m: SheetMapping[]) => SheetMapping[]): Promise<BoqImport> {
  const staged = await stageUpload(fileName, bytes);
  const maps = mappings ? mappings(staged.mappings) : staged.mappings;
  const existing = await store.listImports(c.id);
  const { imp } = buildImport({ caseId: c.id, staged, mappings: maps, currency: c.currency, revisionLabel: label, revision: nextRevision(existing) });
  return store.saveImport(confirmImport(imp));
}

async function xlsxBytes(build: (wb: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}

async function selected(store: MemoryCaseStore, caseId: string) {
  const c = await store.getCase(caseId);
  const imp = selectedImportOf(c, await store.listImports(caseId));
  return { c, imp, items: imp ? recordsFromImport(imp) : [] };
}

describe('CSV reader reads the whole file', () => {
  it('does not stop at 400 characters and handles quotes/newlines', () => {
    const long = 'x'.repeat(1000);
    const grid = parseCsvText(`a,b\n"${long}, with comma","line1\nline2\"\n\"he said \"\"hi\"\"",z`);
    expect(grid[1][0]).toBe(`${long}, with comma`);
    expect(grid[1][1]).toBe('line1\nline2');
    expect(grid[2][0]).toBe('he said "hi"');
  });
});

describe('end-to-end: uploaded CSV BOQ -> parsed -> confirmed -> selected -> deterministic cost', () => {
  it('parses items, rates and source references from the file contents', async () => {
    const store = new MemoryCaseStore();
    const c = await store.createCase(newCase('Case A', 'AED'));
    const imp = await uploadAndConfirm(store, c, 'boq-v1.csv', enc(BOQ_V1_CSV), 'Rev A');
    expect(imp.source.fileName).toBe('boq-v1.csv');
    expect(imp.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    const items = recordsFromImport(imp);
    expect(items.map((i) => i.ref)).toEqual(['TEST-001', 'TEST-002', 'TEST-003']);
    let pav = items[0];
    expect(pav.rate).toMatchObject({ state: 'value', value: '10', cell: 'E2' });
    expect(pav.sheet).toBe('CSV');
    expect(pav.rowNumber).toBe(2);
    expect(items[2].rate.state).toBe('missing');
  });

  it('100 m² added pavement = AED 1,000', async () => {
    const store = new MemoryCaseStore();
    const c = await store.createCase(newCase('Case A', 'AED'));
    await uploadAndConfirm(store, c, 'boq-v1.csv', enc(BOQ_V1_CSV), 'Rev A');
    const { items } = await selected(store, c.id);
    let pav = searchItems(items, 'pavement', 'm2')[0].item;
    let r = calculateChange({ direction: 'addition', quantity: '100', quantityUnit: 'm2', item: pav });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.signedAmount).toBe('1000');
      expect(r.rate).toBe('10');
      expect(r.currency).toBe('AED');
      expect(r.sources[0]).toMatchObject({ file: 'boq-v1.csv', sheet: 'CSV', rateCell: 'E2' });
    }
  });

  it('revised file: rate 12 gives AED 1,200 only after the revision is explicitly selected', async () => {
    const store = new MemoryCaseStore();
    const c = await store.createCase(newCase('Case A', 'AED'));
    const v1 = await uploadAndConfirm(store, c, 'boq-v1.csv', enc(BOQ_V1_CSV), 'Rev A');
    const v2 = await uploadAndConfirm(store, c, 'boq-v2.csv', enc(BOQ_V2_CSV), 'Rev B');
    expect(v1.source.sha256).not.toBe(v2.source.sha256);
    // Rev A is still the selected import: uploading a revision must not silently switch it.
    let s = await selected(store, c.id);
    expect(s.imp?.id).toBe(v1.id);
    let pav = searchItems(s.items, 'pavement')[0].item;
    let r = calculateChange({ direction: 'addition', quantity: '100', quantityUnit: 'm2', item: pav });
    expect(r.ok && r.signedAmount).toBe('1000');
    // Explicit revision selection.
    await store.selectImport(c.id, v2.id);
    s = await selected(store, c.id);
    expect(s.imp?.id).toBe(v2.id);
    pav = searchItems(s.items, 'pavement')[0].item;
    r = calculateChange({ direction: 'addition', quantity: '100', quantityUnit: 'm2', item: pav });
    expect(r.ok && r.signedAmount).toBe('1200');
    expect(r.ok && r.rate).toBe('12');
  });

  it('20 m omitted kerb = −AED 500', async () => {
    const store = new MemoryCaseStore();
    const c = await store.createCase(newCase('Case A', 'AED'));
    await uploadAndConfirm(store, c, 'boq-v1.csv', enc(BOQ_V1_CSV), 'Rev A');
    const { items } = await selected(store, c.id);
    const kerb = searchItems(items, 'kerb', 'm')[0].item;
    let r = calculateChange({ direction: 'omission', quantity: '20', quantityUnit: 'm', item: kerb });
    expect(r.ok && r.signedAmount).toBe('-500');
    expect(r.ok && r.formula).toContain('−');
  });

  it('missing culvert rate stays unpriced and is not zero', async () => {
    const store = new MemoryCaseStore();
    const c = await store.createCase(newCase('Case A', 'AED'));
    await uploadAndConfirm(store, c, 'boq-v1.csv', enc(BOQ_V1_CSV), 'Rev A');
    const { items } = await selected(store, c.id);
    const culvert = searchItems(items, 'culvert')[0].item;
    expect(culvert.rate.state).toBe('missing');
    let r = calculateChange({ direction: 'addition', quantity: '10', quantityUnit: 'm', item: culvert });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('unpriced');
  });

  it('incompatible quantity unit blocks calculation until an explicit derivation is supplied', async () => {
    const store = new MemoryCaseStore();
    const c = await store.createCase(newCase('Case A', 'AED'));
    await uploadAndConfirm(store, c, 'boq-v1.csv', enc(BOQ_V1_CSV), 'Rev A');
    const { items } = await selected(store, c.id);
    let pav = searchItems(items, 'pavement')[0].item; // BOQ unit m²
    // 100 m against an m² item: blocked with no width at all.
    const blocked = calculateChange({ direction: 'addition', quantity: '100', quantityUnit: 'm', item: pav });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) { expect(blocked.kind).toBe('unit_mismatch'); expect(blocked.message).toMatch(/width/i); }
    // Width given but no source or confirmed assumption: still blocked.
    const noBasis = calculateChange({ direction: 'addition', quantity: '100', quantityUnit: 'm', item: pav, derivationInputs: [{ name: 'width', value: '3', unit: 'm' }] });
    expect(noBasis.ok).toBe(false);
    // Width + user-confirmed assumption: 100 m x 3 m = 300 m2 x AED 10 = AED 3,000, with a full audit record.
    const ok = calculateChange({ direction: 'addition', quantity: '100', quantityUnit: 'm', item: pav, derivationInputs: [{ name: 'width', value: '3', unit: 'm' }], basis: { kind: 'user_confirmed', statement: 'Typical carriageway width' } });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.converted).toBe('300');
      expect(ok.signedAmount).toBe('3000');
      expect(ok.conversion).toMatchObject({ type: 'derivation', originalQuantity: '100', originalUnit: 'm', derivedQuantity: '300', derivedUnit: 'm²' });
      expect(ok.conversion.supportingInputs[0]).toMatchObject({ name: 'width', value: '3', unit: 'm', valueInBaseUnit: '3' });
      expect(ok.conversion.basis).toEqual({ kind: 'user_confirmed', statement: 'Typical carriageway width' });
      expect(ok.conversion.derivation).toContain('100 m (length) × 3 m (width) = 300');
    }
    // Width in a different unit is normalised: 3000 mm == 3 m.
    const mm = calculateChange({ direction: 'addition', quantity: '100', quantityUnit: 'm', item: pav, derivationInputs: [{ name: 'width', value: '3000', unit: 'mm' }], basis: { kind: 'source', statement: 'Drawing R4-01' } });
    expect(mm.ok && mm.signedAmount).toBe('3000');
    // A zero or non-numeric width is rejected.
    expect(calculateChange({ direction: 'addition', quantity: '100', quantityUnit: 'm', item: pav, derivationInputs: [{ name: 'width', value: '0', unit: 'm' }], basis: { kind: 'source', statement: 'x' } }).ok).toBe(false);
  });

  it('same-dimension units convert automatically; cross-dimension never accepts a generic factor', async () => {
    const store = new MemoryCaseStore();
    const c = await store.createCase(newCase('Case A', 'AED'));
    await uploadAndConfirm(store, c, 'boq-v1.csv', enc(BOQ_V1_CSV), 'Rev A');
    const { items } = await selected(store, c.id);
    const kerb = searchItems(items, 'kerb')[0].item; // BOQ unit m, AED 25
    const mm = calculateChange({ direction: 'omission', quantity: '20000', quantityUnit: 'mm', item: kerb });
    expect(mm.ok && mm.converted).toBe('20');
    expect(mm.ok && mm.signedAmount).toBe('-500');
    expect(mm.ok && mm.conversion.type).toBe('same_dimension');
    // mass -> length has no derivation: unsupported even if a "basis" is typed.
    const bad = calculateChange({ direction: 'addition', quantity: '5', quantityUnit: 'kg', item: kerb, derivationInputs: [{ name: 'width', value: '2', unit: 'm' }], basis: { kind: 'user_confirmed', statement: 'trust me' } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.kind).toBe('unsupported');
    // counts cannot become length without a per-item measurement basis
    const count = calculateChange({ direction: 'addition', quantity: '12', quantityUnit: 'nr', item: kerb });
    expect(count.ok).toBe(false);
    const counted = calculateChange({ direction: 'addition', quantity: '12', quantityUnit: 'nr', item: kerb, derivationInputs: [{ name: 'length per item', value: '2.5', unit: 'm' }], basis: { kind: 'source', statement: 'Kerb unit datasheet' } });
    expect(counted.ok && counted.converted).toBe('30');
    expect(counted.ok && counted.signedAmount).toBe('750');
  });


  it('two cases with different BOQs do not share rates', async () => {
    const store = new MemoryCaseStore();
    const a = await store.createCase(newCase('Case A', 'AED'));
    const b = await store.createCase(newCase('Case B', 'AED'));
    await uploadAndConfirm(store, a, 'boq-v1.csv', enc(BOQ_V1_CSV), 'Rev A');
    await uploadAndConfirm(store, b, 'boq-other.csv', enc(['Item,Description,Unit,Qty,Rate,Amount', 'TEST-001,Pavement,m²,0,99,0'].join('\n')), 'Rev A');
    const sa = await selected(store, a.id);
    const sb = await selected(store, b.id);
    const ra = calculateChange({ direction: 'addition', quantity: '100', quantityUnit: 'm2', item: searchItems(sa.items, 'pavement')[0].item });
    const rb = calculateChange({ direction: 'addition', quantity: '100', quantityUnit: 'm2', item: searchItems(sb.items, 'pavement')[0].item });
    expect(ra.ok && ra.signedAmount).toBe('1000');
    expect(rb.ok && rb.signedAmount).toBe('9900');
    expect(sb.items.find((i) => i.ref === 'TEST-002')).toBeUndefined();
    expect(sa.items.every((i) => i.caseId === a.id)).toBe(true);
  });

  it('a real case with no import, or an unknown case, never receives sample data', async () => {
    const store = new MemoryCaseStore();
    const c = await store.createCase(newCase('Empty', 'AED'));
    let s = await selected(store, c.id);
    expect(s.imp).toBeNull();
    expect(s.items).toEqual([]);
    expect(await store.getCase('does-not-exist')).toBeNull();
    expect(await store.listImports('does-not-exist')).toEqual([]);
    expect(selectedImportOf(null, [])).toBeNull();
  });

  it('an unconfirmed import cannot be used for calculation', async () => {
    const store = new MemoryCaseStore();
    const c = await store.createCase(newCase('Case A', 'AED'));
    const staged = await stageUpload('boq-v1.csv', enc(BOQ_V1_CSV));
    const { imp } = buildImport({ caseId: c.id, staged, mappings: staged.mappings, currency: 'AED', revisionLabel: 'Rev A', revision: 1 });
    await store.saveImport(imp); // not confirmed
    await expect(store.selectImport(c.id, imp.id)).rejects.toThrow(/confirmed/);
    expect((await selected(store, c.id)).items).toEqual([]);
  });
});

describe('BOQ interpretation of real-world spreadsheet layout', () => {
  it('handles title rows, blank rows, repeated headings, subtotals, multiple bills, explicit zero vs blank', async () => {
    const csv = [
      'Project X Bill of Quantities,,,,,',
      ',,,,,',
      'Item,Description,Unit,Qty,Rate,Amount',
      'Bill No. 1 - Roads,,,,,',
      '1.01,Asphalt,m2,50,40,2000',
      '1.02,Free issue kerb,m,10,0,0',
      '1.03,Manhole,nr,2,,',
      'Sub-total Bill 1,,,,,2000',
      ',,,,,',
      'Item,Description,Unit,Qty,Rate,Amount',
      'Bill No. 2 - Drainage,,,,,',
      '2.01,Pipe 300mm,m,100,55.5,5550',
      'Carried to summary,,,,,5550',
    ].join('\n');
    const staged = await stageUpload('x.csv', enc(csv));
    expect(staged.mappings[0].headerRow).toBe(3);
    const { imp } = buildImport({ caseId: 'c1', staged, mappings: staged.mappings, currency: 'AED', revisionLabel: 'A', revision: 1 });
    const byRef = (r: string) => imp.rows.find((x) => x.ref === r)!;
    expect(byRef('1.01').rowClass).toBe('item');
    expect(byRef('1.02').rowClass).toBe('item');
    expect(byRef('1.02').rate).toMatchObject({ state: 'value', value: '0', explicitZero: true });
    expect(byRef('1.03').rowClass).toBe('unpriced_item');
    expect(byRef('1.03').rate.state).toBe('missing');
    expect(imp.rows.filter((r) => r.rowClass === 'repeated_heading')).toHaveLength(1);
    expect(imp.rows.filter((r) => r.rowClass === 'subtotal').length).toBe(2);
    expect(imp.rows.filter((r) => r.rowClass === 'bill_heading').length).toBe(2);
    expect(byRef('2.01').bill).toMatch(/Bill No\. 2/);
    // Only items count as priced scope.
    const recs = recordsFromImport(imp);
    expect(recs.map((r) => r.ref)).toEqual(['1.01', '1.02', '1.03', '2.01']);
    // Explicit zero rate calculates to zero; missing rate does not calculate.
    const zero = calculateChange({ direction: 'addition', quantity: '5', quantityUnit: 'm', item: recs[1] });
    expect(zero.ok && zero.signedAmount).toBe('0');
    expect(calculateChange({ direction: 'addition', quantity: '5', quantityUnit: 'nr', item: recs[2] }).ok).toBe(false);
  });

  it('respects user column remapping and sheet exclusion', async () => {
    const csv = ['A,B,C,D,E', 'X-1,Slab,m3,10,300'].join('\n');
    const staged = await stageUpload('odd.csv', enc(csv));
    expect(staged.mappings[0].included).toBe(false); // nothing header-like, user must map
    const maps: SheetMapping[] = [{ sheet: 'CSV', included: true, headerRow: 1, columns: { ref: 0, description: 1, unit: 2, quantity: 3, rate: 4, amount: null } }];
    const { imp } = buildImport({ caseId: 'c1', staged, mappings: maps, currency: 'AED', revisionLabel: 'A', revision: 1 });
    const recs = recordsFromImport(imp);
    expect(recs).toHaveLength(1);
    let r = calculateChange({ direction: 'addition', quantity: '2', quantityUnit: 'm3', item: recs[0] });
    expect(r.ok && r.signedAmount).toBe('600');
  });
});

describe('XLSX upload: sheets, cell references, formula cached vs missing', () => {
  it('reads multiple sheets, keeps cell refs, flags formula without cached value', async () => {
    const bytes = await xlsxBytes((wb) => {
      const s1 = wb.addWorksheet('Bill 1');
      s1.addRow(['Item', 'Description', 'Unit', 'Qty', 'Rate', 'Amount']);
      s1.addRow(['TEST-001', 'Pavement', 'm²', 0, 10, 0]);
      s1.addRow(['TEST-002', 'Kerb', 'm', 0, { formula: '5*5', result: 25 }, 0]);
      s1.addRow(['TEST-003', 'Culvert', 'm', 0, { formula: 'F9*2' }, 0]);
      s1.addRow(['TEST-004', 'Duct', 'm', 0, null, null]);
      const s2 = wb.addWorksheet('Notes');
      s2.addRow(['Just some notes']);
    });
    const staged = await stageUpload('boq.xlsx', bytes);
    expect(staged.workbook.sheets.map((s) => s.name)).toEqual(['Bill 1', 'Notes']);
    expect(staged.mappings[0].included).toBe(true);
    expect(staged.mappings[1].included).toBe(false);
    expect(staged.workbook.warnings.some((w) => /F9\*2/.test(w) && /no cached value/.test(w))).toBe(true);
    const { imp } = buildImport({ caseId: 'c1', staged, mappings: staged.mappings, currency: 'AED', revisionLabel: 'A', revision: 1 });
    const recs = recordsFromImport(imp);
    expect(recs.map((r) => r.ref)).toEqual(['TEST-001', 'TEST-002', 'TEST-003', 'TEST-004']);
    expect(recs[0].rate).toMatchObject({ value: '10', cell: 'E2' });
    expect(recs[1].rate).toMatchObject({ value: '25', cell: 'E3', formulaStatus: 'cached', formula: '5*5' });
    expect(recs[2].rate.state).toBe('invalid');
    expect(recs[2].rate.formulaStatus).toBe('no_cached_value');
    expect(recs[3].rate.state).toBe('missing');
    const r2 = calculateChange({ direction: 'addition', quantity: '4', quantityUnit: 'm', item: recs[1] });
    expect(r2.ok && r2.signedAmount).toBe('100');
    expect(r2.ok && r2.rateFormulaNote).toMatch(/not recalculated/);
    expect(calculateChange({ direction: 'addition', quantity: '4', quantityUnit: 'm', item: recs[2] }).ok).toBe(false);
  });

  it('rejects unsupported and corrupt files with a specific error', async () => {
    await expect(stageUpload('a.xls', enc('x'))).rejects.toThrow(/\.xls/);
    await expect(stageUpload('a.xlsx', enc('not a zip'))).rejects.toThrow(/not a valid XLSX/);
    await expect(stageUpload('a.pdf', enc('x'))).rejects.toThrow(/Unsupported/);
    await expect(stageUpload('a.csv', new Uint8Array(0))).rejects.toThrow(/empty/);
  });
});

describe('unit canonicalisation', () => {
  it('treats spellings of the same unit as equal and different units as different', () => {
    expect(canonUnit('m²')).toBe('m2');
    expect(canonUnit('SQ.M')).toBe('m2');
    expect(canonUnit('m')).not.toBe(canonUnit('m²'));
    expect(canonUnit('Nos')).toBe('nr');
  });
});

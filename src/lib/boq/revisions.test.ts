import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { searchItems, recordsFromImport, sameUnit } from './calc';
import { findCounterpart, staleness, toSavedCalculation, approvableCalculations } from './revisions';
import { calculateChange } from './calc';
import { buildImport, confirmImport, stageUpload } from './importFlow';
import { MemoryCaseStore, newCase } from './store';
import type { BoqImport } from './types';

const enc = (s: string) => new TextEncoder().encode(s);

/**
 * Isolation: the real-case code must never import the demo engine or fixtures.
 * This test reads the actual source files, so it fails if someone wires them together later.
 */
describe('real-case code is isolated from the demo engine', () => {
  const forbidden = [/lib\/assessment\/(costEngine|fixtures|rates|useAssessment)/, /lib\/mapping\/(boqEngine|useCaseStore|drawingEngine)/, /from '\.\/costEngine'/, /syntheticRates|rateByRef|BOQ_ITEMS|buildFahid/];
  const roots = ['src/lib/boq', 'src/app/api/boq-cases'];
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') || p.endsWith('.tsx') ? [p] : []; });
  const realFiles = [...roots.flatMap(files), 'src/app/case-workspace/components/RealCaseWorkspace.tsx'].filter((f) => !f.endsWith('.test.ts'));

  it('scans a non-empty set of real files', () => { expect(realFiles.length).toBeGreaterThan(8); });
  for (const f of realFiles) {
    it(`${f} does not reference demo engines or fixtures`, () => {
      const src = readFileSync(f, 'utf8');
      for (const re of forbidden) expect(re.test(src), `${f} matches ${re}`).toBe(false);
    });
  }
});

describe('sameUnit is a real check, not a stub', () => {
  it('treats spellings of one unit as equal', () => { expect(sameUnit('Sq.M', 'm²')).toBe(true); expect(sameUnit('m', 'M')).toBe(true); });
  it('treats different units as different', () => { expect(sameUnit('m', 'm2')).toBe(false); expect(sameUnit('', '')).toBe(false); });
});

async function importFrom(caseId: string, name: string, csv: string, revision: number): Promise<BoqImport> {
  const staged = await stageUpload(name, enc(csv));
  const { imp } = buildImport({ caseId, staged, mappings: staged.mappings, currency: 'AED', revisionLabel: `Rev ${revision}`, revision });
  return confirmImport(imp);
}

const V1 = 'Item,Description,Unit,Qty,Rate,Amount\nTEST-001,Pavement,m2,,10,\nTEST-002,Kerb,m,,25,\nTEST-003,Culvert,m,,,\n';
const V2 = 'Item,Description,Unit,Qty,Rate,Amount\nTEST-001,Pavement,m2,,12,\nTEST-002,Kerb,m,,25,\nTEST-003,Culvert,m,,,\n';

describe('revision invalidation', () => {
  it('keeps the earlier calculation and flags it for review when another revision is selected', async () => {
    const store = new MemoryCaseStore();
    const c = await store.createCase(newCase('t', 'AED'));
    const i1 = await importFrom(c.id, 'v1.csv', V1, 1);
    const i2 = await importFrom(c.id, 'v2.csv', V2, 2);
    await store.saveImport(i1);
    await store.saveImport(i2);

    // Uploading revision 2 alone does not activate it.
    const afterUpload = await store.getCase(c.id);
    expect(afterUpload?.selectedImportId).toBe(i1.id);

    const imports = await store.listImports(c.id);
    const item = recordsFromImport(imports.find((i) => i.id === i1.id)!).find((r) => r.ref === 'TEST-001')!;
    const result = calculateChange({ direction: 'addition', quantity: '100', quantityUnit: 'm2', item });
    expect(result.ok && result.signedAmount).toBe('1000');
    if (!result.ok) throw new Error('expected a result');
    const saved = toSavedCalculation({ id: 'calc-1', caseId: c.id, description: 'pavement', imp: i1, result, item });

    // Current while revision 1 is selected.
    expect(staleness(saved, i1, imports).status).toBe('current');
    expect(approvableCalculations([saved], i1, imports)).toHaveLength(1);

    // Select revision 2 explicitly: the old record is untouched, but no longer current or approvable.
    const after = await store.selectImport(c.id, i2.id);
    expect(after.selectedImportId).toBe(i2.id);
    const info = staleness(saved, i2, imports);
    expect(info.status).toBe('needs_review');
    expect(info.changed?.from).toContain('revision 1');
    expect(info.changed?.to).toContain('revision 2');
    expect(info.reason).toContain('10');
    expect(info.reason).toContain('12');
    expect(info.rowChanged).toBe(true);
    expect(approvableCalculations([saved], i2, imports)).toHaveLength(0);
    expect(saved.signedAmount).toBe('1000');
    expect(saved.importRevision).toBe(1);

    // Remapping finds the counterpart row and a NEW calculation gives 1,200 without touching the old one.
    const row = findCounterpart(saved, i2);
    expect(row?.ref).toBe('TEST-001');
    const item2 = recordsFromImport(i2).find((r) => r.ref === 'TEST-001')!;
    const again = calculateChange({ direction: 'addition', quantity: '100', quantityUnit: 'm2', item: item2 });
    expect(again.ok && again.signedAmount).toBe('1200');
  });

  it('flags a result whose row has disappeared from the selected revision', async () => {
    const store = new MemoryCaseStore();
    const c = await store.createCase(newCase('t', 'AED'));
    const i1 = await importFrom(c.id, 'v1.csv', V1, 1);
    const i2 = await importFrom(c.id, 'v2.csv', 'Item,Description,Unit,Qty,Rate,Amount\nTEST-009,Other,m,,5,\n', 2);
    await store.saveImport(i1);
    await store.saveImport(i2);
    const imports = await store.listImports(c.id);
    const item = recordsFromImport(i1).find((r) => r.ref === 'TEST-002')!;
    const result = calculateChange({ direction: 'omission', quantity: '20', quantityUnit: 'm', item });
    if (!result.ok) throw new Error('expected a result');
    expect(result.signedAmount).toBe('-500');
    const saved = toSavedCalculation({ id: 'calc-2', caseId: c.id, description: 'kerb', imp: i1, result, item });
    const info = staleness(saved, i2, imports);
    expect(info.status).toBe('needs_review');
    expect(info.rowMissing).toBe(true);
  });

  it('never shows a result as current when no revision is selected', async () => {
    const store = new MemoryCaseStore();
    const c = await store.createCase(newCase('t', 'AED'));
    const i1 = await importFrom(c.id, 'v1.csv', V1, 1);
    const item = recordsFromImport(i1).find((r) => r.ref === 'TEST-001')!;
    const result = calculateChange({ direction: 'addition', quantity: '1', quantityUnit: 'm2', item });
    if (!result.ok) throw new Error('expected a result');
    const saved = toSavedCalculation({ id: 'calc-3', caseId: c.id, description: 'x', imp: i1, result, item });
    expect(staleness(saved, null, [i1]).status).toBe('needs_review');
  });
});

describe('searchItems reports unit mismatches (previously hidden by a stub)', () => {
  it('marks a unit mismatch as false and a match as true', async () => {
    const i1 = await importFrom('case-x', 'v1.csv', V1, 1);
    const items = recordsFromImport(i1);
    const r = searchItems(items, 'pavement', 'm');
    expect(r[0].item.ref).toBe('TEST-001');
    expect(r[0].unitMatches).toBe(false);
    expect(searchItems(items, 'pavement', 'm2')[0].unitMatches).toBe(true);
  });
});

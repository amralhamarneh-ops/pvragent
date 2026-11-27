import { describe, expect, it } from 'vitest';
import { analyseDocuments } from './analyse';
import { extractTitleBlock } from './titleblock';
import { resolutionsFrom } from './resolve';
import { readDxf } from './dxfRead';

const rows = (...v: (string | number)[]) => new TextEncoder().encode(v.join('\n') + '\n');
const line = (layer: string, len: number, paper = false) => [0, 'LINE', 8, layer, ...(paper ? [67, 1] : []), 10, 0, 20, 0, 11, len, 21, 0];
const dxf = (units: number, ...v: (string | number)[]) => rows(0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, units, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES', ...v, 0, 'ENDSEC', 0, 'EOF');
const dwg = (name: string, bytes: Uint8Array) => ({ name, bytes, role: 'drawings' as const });

describe('CAD quantity guardrails', () => {
  it('keeps the full numbered sheet ID and parses commonly supplied suffixes', () => {
    const a = extractTitleBlock('1200AA-NPC-RS-E22-DR-C-50000_Ver6.dxf', []);
    const b = extractTitleBlock('1200AA-NPC-RS-E22-DR-C-50001_Ver6.dxf', []);
    const c = extractTitleBlock('02001AA-DAR-IR-000-DR-ML-00311[C00]_C00.dxf', []);
    expect(a.drawingNumber).toMatch(/-50000$/);
    expect(b.drawingNumber).toMatch(/-50001$/);
    expect(a.revision).toBe('6');
    expect(c.drawingNumber).toBe('02001AA-DAR-IR-000-DR-ML-00311');
    expect(c.revision).toBe('C00');
  });

  it('excludes paper-space geometry and text from quantities but preserves the paper title-block identity', async () => {
    const a = dxf(6, ...line('PIPE', 12), ...line('PIPE', 500, true), 0, 'TEXT', 67, 1, 8, 'TITLE', 10, 0, 20, 0, 40, 2, 1, 'DRAWING NO: IR-12 REV: 01');
    const result = await readDxf('unnamed.dxf', a);
    expect(result.entities.map((e) => e.length)).toEqual([12]);
    expect(result.titleBlock?.drawingNumber).toBe('IR-12');
    expect(result.texts).toEqual([]);
    expect(result.validationIssues.join(' ')).toMatch(/paper-space/);
  });

  it('does not treat model-space annotation layers as installation quantities', async () => {
    const a = dxf(6, ...line('PIPE', 12), ...line('SHEET-LEGEND', 9));
    const b = dxf(6, ...line('PIPE', 12), ...line('SHEET-LEGEND', 500));
    const result = await analyseDocuments({files:[dwg('IR-12_Ver1.dxf', a),dwg('IR-12_Ver2.dxf',b)], narrative:''});
    expect(result.pairs[0]?.validated).toBe(true);
    expect(result.changes).toHaveLength(0);
  });

  it('only overrides the unitless file, without changing its metre-denominated counterpart', async () => {
    const files = [dwg('IR-12_Ver1.dxf', dxf(0, ...line('PIPE', 12_000))), dwg('IR-12_Ver2.dxf', dxf(6, ...line('PIPE', 12)))];
    const first = await analyseDocuments({files, narrative:''});
    const units = first.questions.find((q) => q.kind === 'unit')!;
    expect(units.evidence).toEqual(['IR-12_Ver1.dxf']);
    const res = resolutionsFrom(first.questions, {[units.id]: 'mm'});
    expect(res.unitOverride).toEqual({'IR-12_Ver1.dxf':'mm'});
    const second = await analyseDocuments({files, narrative:'',resolutions:res});
    expect(second.drawings.map((f)=>f.unit)).toEqual(['mm','m']);
    expect(second.pairs[0]?.validated).toBe(false);
  });

  it('blocks a typical detail companion PDF from generating installed CAD or stated quantities', async () => {
    const files = [dwg('GR-51_Ver1.dxf', dxf(6, ...line('GUARD-RAIL', 12))), dwg('shop/GR-51_Ver2.dxf', dxf(6, ...line('GUARD-RAIL', 15))), dwg('plots/GR-51_Ver2.pdf', rows('pdf'))];
    const result = await analyseDocuments({files, narrative:'', extractor: async (n) => ({kind:'text', ok:true, doc:{name:n, method:'pdf-text',truncated:false,limitation:'',pages:[{page:1,text:'DRAWING TITLE\nGUARD RAIL\nSINGLE FACE TYPICAL DETAILS\n 1.77 m\nContractor shall submit layout drawings'}]}})});
    expect(result.drawings.find(d=>d.fileName.endsWith('Ver2.dxf'))?.detailOnlyEvidence).toBe('plots/GR-51_Ver2.pdf');
    expect(result.pairs[0]?.validated).toBe(false);
    expect(result.changes).toHaveLength(0);
  });
});

import { describe, expect, it } from 'vitest';
import { analyseDocuments } from './analyse';
import { readDxf } from './dxfRead';

function drawing(name: string, content: (string | number)[], blocks: (string | number)[] = []) {
  const pairs = [
    0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 6, 0, 'ENDSEC',
    0, 'SECTION', 2, 'BLOCKS', ...blocks, 0, 'ENDSEC',
    0, 'SECTION', 2, 'ENTITIES', ...content, 0, 'ENDSEC', 0, 'EOF',
  ];
  return { name, role: 'drawings' as const, bytes: new TextEncoder().encode(pairs.join('\n') + '\n') };
}
const line = (layer: string, handle: string, x: number, end: number, y = 0) => [0, 'LINE', 5, handle, 8, layer, 10, x, 20, y, 11, end, 21, y];
const controls = [...line('ANCHOR', 'A', 0, 70, 20), ...line('ANCHOR', 'B', 0, 70, 40), ...line('ANCHOR', 'C', 0, 70, 60)];
const block = (name: string, flags: number, body: (string | number)[] = []) => [0, 'BLOCK', 2, name, 70, flags, 10, 0, 20, 0, ...body, 0, 'ENDBLK'];
const insert = (name: string, layer: string, paper = false) => [0, 'INSERT', 2, name, 8, layer, ...(paper ? [67, 1] : []), 10, 0, 20, 0];

describe('CAD coverage', () => {
  it('withholds just the changed layer with unread geometry; retains exact changes on supported layers', async () => {
    const a = drawing('RW-15_Ver1.dxf', [...controls, ...line('PIPE', 'D', 0, 8), ...line('KERB', 'E', 0, 8, 10)]);
    const b = drawing('RW-15_Ver2.dxf', [...controls, ...line('PIPE', 'D', 0, 14), ...line('KERB', 'E', 0, 14, 10),
      0, 'ACAD_PROXY_ENTITY', 5, 'F', 8, 'PIPE', 0, 'HATCH', 8, 'KERB', 67, 1]);
    const result = await analyseDocuments({ files:[a,b], narrative:'' });
    expect(result.pairs[0].validated).toBe(true);
    expect(result.drawings[1].coverageGapsByLayer).toEqual({ PIPE: ['ACAD_PROXY_ENTITY'] });
    expect(result.changes.map((c) => c.component)).toEqual(['KERB','KERB']);
    expect(result.questions).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Drawing layer not safe to measure', issue: expect.stringContaining('ACAD_PROXY_ENTITY') })]));
  });

  it('blocks a placed unresolved model XREF, not an unused or paper-space-only reference', async () => {
    const definitions = block('EXTERNAL', 8);
    const normal = drawing('RW-15_Ver1.dxf', [...controls, ...line('PIPE', 'D', 0, 8)], definitions);
    const paper = drawing('RW-15_Ver2.dxf', [...controls, ...line('PIPE', 'D', 0, 14), ...insert('EXTERNAL','PIPE', true)], definitions);
    const placed = drawing('RW-15_Ver2.dxf', [...controls, ...line('PIPE', 'D', 0, 14), ...insert('EXTERNAL','PIPE')], definitions);
    const a = await analyseDocuments({ files:[normal,paper], narrative:'' });
    const b = await analyseDocuments({ files:[normal,placed], narrative:'' });
    expect(a.drawings[0].unresolvedXrefs).toEqual(['EXTERNAL']);
    expect(a.drawings[1].unboundedCoverageGaps).toEqual([]);
    expect(a.changes).not.toHaveLength(0);
    expect(b.pairs[0].validated).toBe(false);
    expect(b.pairs[0].blockers.join(' ')).toContain('Unresolved external reference “EXTERNAL” on layer PIPE');
    expect(b.changes).toHaveLength(0);
  });

  it('inherits a parent installation layer through nested layer-0 block geometry and gaps', async () => {
    const blocks = [...block('PARENT',0,insert('CHILD','0')), ...block('CHILD',0,[...line('0','A',0,12),0,'MLINE',8,'0'])];
    const f = drawing('RW-15_Ver1.dxf', insert('PARENT','PIPE'), blocks);
    const d = await readDxf(f.name, f.bytes);
    expect(d.entities.find((e) => e.kind === 'LINE')).toMatchObject({ layer:'PIPE', length:12, fromBlock:'CHILD' });
    expect(d.coverageGapsByLayer).toEqual({ PIPE:['MLINE'] });
  });
});

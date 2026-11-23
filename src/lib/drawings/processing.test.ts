// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readDxf, boundsOf } from './dxfRead';
import { dwgStatus, convertDwg } from './dwgConvert';
import { validateUpload, workerConfig, isCurrentRun, submitJob, getJob, cancelJob } from './processingAdapter';

const dxf = (rows: (string | number)[]) => new TextEncoder().encode(rows.map(String).join('\n') + '\n');

describe('DXF coverage is reported, not hidden', () => {
  it('flags an unresolved XREF and unsupported geometry as coverage-limited', async () => {
    const blocks = [0, 'BLOCK', 2, 'BASEMAP', 1, 'base.dwg', 70, 4, 10, 0, 20, 0, 0, 'ENDBLK'];
    const rows = [0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 6, 0, 'ENDSEC', 0, 'SECTION', 2, 'BLOCKS', ...blocks, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES',
      0, 'LINE', 5, 'A', 8, 'ROAD', 10, 0, 20, 0, 11, 10, 21, 0, 0, 'SPLINE', 5, 'S', 8, 'KERB', 0, 'ENDSEC', 0, 'EOF'];
    const d = await readDxf('x.dxf', dxf(rows));
    expect(d.state).toBe('read');
    expect(d.coverageLimited).toBe(true);
    expect(d.validationIssues.join(' ')).toMatch(/SPLINE/);
  });
  it('computes extents over a very large coordinate set without RangeError', () => {
    const pts = Array.from({ length: 600_000 }, (_, i) => ({ x: i, y: -i }));
    const b = boundsOf(pts)!;
    expect(b.maxX).toBe(599_999); expect(b.minY).toBe(-599_999);
    expect(() => Math.min(...pts.map((p) => p.x))).toThrow(); // documents why the spread form was unsafe
  });
});

describe('DWG converter', () => {
  it('imports child_process correctly: not-configured is reported, not a ReferenceError', async () => {
    expect(dwgStatus({}).configured).toBe(false);
    const r = await convertDwg(new Uint8Array([65, 67, 49, 48]), {});
    expect(r.ok).toBe(false); expect(r.error).toMatch(/No DWG converter/);
  });
  it('reports a missing executable explicitly', async () => {
    const r = await convertDwg(new Uint8Array(200), { DWG_CONVERTER: 'libredwg', DWG_CONVERTER_PATH: '/nonexistent/dwg2dxf' });
    expect(r.ok).toBe(false); expect(r.error).toMatch(/not found|failed/i); expect(r.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  // NOTE: no real DWG conversion is asserted here. That needs an installed converter and a real DWG file.
});

describe('upload validation', () => {
  const pdf = new TextEncoder().encode('%PDF-1.4 hello');
  it('accepts matching signatures and rejects mismatches, empties and unknown types', () => {
    expect(validateUpload('a.pdf', pdf)).toBeNull();
    expect(validateUpload('a.pdf', new TextEncoder().encode('not pdf'))).toMatch(/signature/);
    expect(validateUpload('a.exe', pdf)).toMatch(/not accepted/);
    expect(validateUpload('a.pdf', new Uint8Array())).toMatch(/empty/);
  });
});

describe('adapter (MOCK-LEVEL: in-process path, no remote worker contacted)', () => {
  it('reports in_process mode when no worker is configured and never invents a URL', () => {
    const c = workerConfig();
    if (!process.env.PROCESSING_WORKER_URL) { expect(c.remote).toBe(false); expect(c.url).toBe(''); }
  });
  it('a cancelled job never completes and a newer run supersedes an older one', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4\ngarbage');
    const a = await submitJob({ caseId: 'c1', runId: 'run-old', fileName: 'x.pdf', bytes, userId: 'u' });
    const b = await submitJob({ caseId: 'c1', runId: 'run-new', fileName: 'x.pdf', bytes, userId: 'u' });
    expect(isCurrentRun('c1', a.sha256, 'run-old')).toBe(false);
    expect(isCurrentRun('c1', b.sha256, 'run-new')).toBe(true);
    const c = await cancelJob(b.id);
    expect('job' in c && ['cancelled', 'failed'].includes(c.job.state)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    const after = await getJob(b.id);
    expect('job' in after && after.job.state !== 'completed').toBe(true);
  });
});

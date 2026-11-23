// @vitest-environment node
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { analyseDocuments, type InputFile } from './analyse';
import { arcSweep, bulgeSegment, pathArea, readDxf, segLength } from './dxfRead';
import { hasRelocationEvidence } from './compare';
import { buildViewModel, detailWindows, fitViewport, zoomAt } from './viewModel';
import { initialPlayback, initialRun, playbackReducer, runReducer, visibleLayerCount } from './runState';
import { extractDocx, extractPdf } from './extractServer';
import { dwgStatus, convertDwg } from './dwgConvert';
import { readWorkbook } from '@/lib/boq/readers';
import { parseXer } from '@/lib/mapping/xerParser';
import type { ProcessingEvent } from './types';

/** Build an ASCII DXF from raw group-code pairs. */
function dxfText(entities: (string | number)[], opts: { insunits?: number | null; blocks?: (string | number)[] } = {}): Uint8Array {
  let p: (string | number)[] = [0, 'SECTION', 2, 'HEADER'];
  const u = opts.insunits === undefined ? 6 : opts.insunits;
  if (u !== null) p.push(9, '$INSUNITS', 70, u);
  p.push(0, 'ENDSEC');
  if (opts.blocks) p.push(0, 'SECTION', 2, 'BLOCKS', ...opts.blocks, 0, 'ENDSEC');
  p.push(0, 'SECTION', 2, 'ENTITIES', ...entities, 0, 'ENDSEC', 0, 'EOF');
  return new TextEncoder().encode(p.map(String).join('\n') + '\n');
}
const text = (t: string, h = 'T1') => [0, 'TEXT', 5, h, 8, 'TEXT', 10, 0, 20, 0, 40, 2.5, 1, t];
const lw = (layer: string, h: string, pts: [number, number, number?][], closed = false) => [0, 'LWPOLYLINE', 5, h, 8, layer, 90, pts.length, 70, closed ? 1 : 0, ...pts.flatMap(([x, y, b]) => [10, x, 20, y, ...(b ? [42, b] : [])])];
const circle = (layer: string, h: string, cx: number, cy: number, r: number) => [0, 'CIRCLE', 5, h, 8, layer, 10, cx, 20, cy, 40, r];
const enc = (s: string) => new TextEncoder().encode(s);
const dr = (name: string, bytes: Uint8Array | null, role: InputFile['role'] = 'drawings'): InputFile => ({ name, bytes, role });

describe('curve geometry is preserved, not flattened to chords', () => {
  it('a stadium (10 x 4 with semicircular ends) has the true area and perimeter', async () => {
    const d = await readDxf('s.dxf', dxfText([...text('DWG NO: S-1 REV: A'), ...lw('SHAPE', 'S1', [[0, 0], [10, 0, 1], [10, 4], [0, 4, 1]], true)]));
    const e = d.entities.find((x) => x.layer === 'SHAPE')!;
    expect(e.curved).toBe(true);
    expect(e.area).toBeCloseTo(40 + Math.PI * 4, 6);
    expect(e.length).toBeCloseTo(20 + 2 * Math.PI * 2, 6);
  });
  it('major arcs (|bulge| > 1) and negative bulges have the right sweep', () => {
    for (const b of [2, -2, 3, -3, 0.5, -0.5, 1]) {
      let s = bulgeSegment({ x: 3, y: 1 }, { x: -1, y: 5 }, b);
      expect(arcSweep(s as never)).toBeCloseTo(4 * Math.atan(Math.abs(b)), 9);
    }
  });
  it('a circle keeps its radius: area πr², length 2πr', async () => {
    const d = await readDxf('c.dxf', dxfText([...text('DWG NO: C-1 REV: A'), ...circle('POND', 'C1', 5, 5, 3)]));
    const e = d.entities.find((x) => x.layer === 'POND')!;
    expect(e.area).toBeCloseTo(Math.PI * 9, 9);
    expect(e.length).toBeCloseTo(2 * Math.PI * 3, 9);
    expect(e.radius).toBeCloseTo(3, 9);
  });
  it('an ARC entity is measured on the arc, not its chord', async () => {
    const arc = [0, 'ARC', 5, 'A1', 8, 'KERB', 10, 0, 20, 0, 40, 10, 50, 0, 51, 90];
    const d = await readDxf('a.dxf', dxfText([...text('DWG NO: A-1 REV: A'), ...arc]));
    const e = d.entities.find((x) => x.layer === 'KERB')!;
    expect(e.length).toBeCloseTo((Math.PI * 10) / 2, 6); // quarter circle, not the 14.14 chord
  });
  it('segment helpers agree on a closed path', () => {
    const segs = [{ type: 'line' as const, x1: 0, y1: 0, x2: 2, y2: 0 }, bulgeSegment({ x: 2, y: 0 }, { x: 2, y: 2 }, 1), { type: 'line' as const, x1: 2, y1: 2, x2: 0, y2: 2 }, { type: 'line' as const, x1: 0, y1: 2, x2: 0, y2: 0 }];
    expect(pathArea(segs)).toBeCloseTo(4 + (Math.PI * 1) / 2, 9);
    expect(segs.reduce((s, x) => s + segLength(x), 0)).toBeCloseTo(6 + Math.PI, 9);
  });
});

describe('block inserts keep their transforms', () => {
  const block = [0, 'BLOCK', 2, 'POST', 8, '0', 10, 0, 20, 0, ...lw('0', 'B1', [[0, 0], [1, 0], [1, 1], [0, 1]], true), 0, 'ENDBLK'];
  it('expands a block with translation, rotation and scale into real geometry', async () => {
    const ins = [0, 'INSERT', 5, 'I1', 8, 'POSTS', 2, 'POST', 10, 10, 20, 0, 41, 2, 42, 2, 50, 90];
    const d = await readDxf('b.dxf', dxfText([...text('DWG NO: B-1 REV: A'), ...ins], { blocks: block }));
    const geo = d.entities.find((e) => e.kind === 'LWPOLYLINE' && e.fromBlock === 'POST')!;
    expect(geo.layer).toBe('POSTS'); // layer 0 inside a block inherits the insert layer
    expect(geo.area).toBeCloseTo(4, 9); // 1 m² scaled by 2 x 2
    const xs = geo.vertices.map((v) => v.x); const ys = geo.vertices.map((v) => v.y);
    expect(Math.min(...xs)).toBeCloseTo(8, 9); expect(Math.max(...xs)).toBeCloseTo(10, 9); // rotated 90° about (10,0)
    expect(Math.min(...ys)).toBeCloseTo(0, 9); expect(Math.max(...ys)).toBeCloseTo(2, 9);
    expect(d.entities.filter((e) => e.kind === 'INSERT')).toHaveLength(1); // one countable instance
  });
  it('reports an insert of an undefined block instead of dropping it', async () => {
    const ins = [0, 'INSERT', 5, 'I1', 8, 'X', 2, 'MISSING', 10, 0, 20, 0];
    const d = await readDxf('b.dxf', dxfText([...text('DWG NO: B-2 REV: A'), ...ins]));
    expect(d.validationIssues.join(' ')).toMatch(/undefined block "MISSING"/);
  });
  it('reports unsupported entity types by name', async () => {
    const d = await readDxf('h.dxf', dxfText([...text('DWG NO: H-1 REV: A'), ...lw('A', 'A1', [[0, 0], [5, 0]]), 0, 'SPLINE', 5, 'SP', 8, 'A', 70, 8, 71, 3, 72, 0, 73, 0, 74, 0]));
    expect(d.validationIssues.join(' ')).toMatch(/SPLINE/);
  });
});

describe('uploaded revision pair → evidence-linked, curve-aware changes', () => {
  const orig = dxfText([...text('DWG NO: R4-001 REV: B'), ...lw('ROAD-CL', 'A1', [[0, 0], [5000, 0]]), ...circle('POND', 'P1', 100, 100, 10)]);
  const rev = dxfText([...text('DWG NO: R4-001 REV: C'), ...lw('ROAD-CL', 'A1', [[0, 0], [5000, 0]]), ...lw('ROAD-CL', 'A9', [[5000, 0], [5100, 0, 0.5], [5200, 0]]), ...circle('POND', 'P1', 100, 100, 10), ...circle('POND', 'P2', 300, 300, 5)]);
  it('measures the added curved polyline on its arc and the added circle by area, with entity references', async () => {
    const events: ProcessingEvent[] = [];
    let out = await analyseDocuments({ files: [dr('b.dxf', orig), dr('c.dxf', rev)], narrative: '', runId: 'r1', caseId: 'case-1', onEvent: (e) => events.push(e) });
    expect(out.pairs[0].validated).toBe(true);
    const road = out.changes.find((c) => c.component === 'ROAD-CL')!;
    const chord = 200; const sweep = 4 * Math.atan(0.5); const r1 = 100 / (2 * Math.sin(sweep / 2));
    // two segments: first has bulge 0.5 over a 100 chord; second straight 100
    expect(Number(road.changeQty)).toBeCloseTo(r1 * sweep + 100, 2);
    expect(Number(road.changeQty)).toBeGreaterThan(chord); // longer than the straight chord (200 total chords = 200)
    expect(road.entityRefs?.revised[0].handle).toBe('A9');
    expect(road.entityRefs?.drawingNumber).toBe('R4-001');
    const pond = out.changes.find((c) => c.component === 'POND')!;
    expect(pond.unit).toBe('m2');
    expect(Number(pond.changeQty)).toBeCloseTo(Math.PI * 25, 2);
    // real events, in stage order, tagged with this run and case
    expect(events.every((e) => e.runId === 'r1' && e.caseId === 'case-1')).toBe(true);
    const stages = events.map((e) => e.stage);
    expect(stages.indexOf('parsing')).toBeLessThan(stages.indexOf('geometry'));
    expect(stages.indexOf('geometry')).toBeLessThan(stages.indexOf('alignment'));
    expect(stages.indexOf('alignment')).toBeLessThan(stages.indexOf('comparison'));
    expect(stages.indexOf('comparison')).toBeLessThan(stages.indexOf('measurement'));
    expect(stages[stages.length - 1]).toBe('reconciliation');
    const layerEvents = events.filter((e) => e.stage === 'geometry' && e.layer);
    // Both files report their real layers with real entity counts, as the parser finishes them.
    expect(new Set(layerEvents.map((e) => e.layer))).toEqual(new Set(['ROAD-CL', 'POND']));
    expect(layerEvents.filter((e) => e.fileName === 'c.dxf').find((e) => e.layer === 'ROAD-CL')!.count).toBe(2);
    expect(layerEvents.every((e) => (e.count ?? 0) > 0)).toBe(true);
  });
  it('builds a view model from the uploaded geometry with true extents and linked changes', async () => {
    let out = await analyseDocuments({ files: [dr('b.dxf', orig), dr('c.dxf', rev)], narrative: '' });
    const m = buildViewModel(out.pairs[0], out.changes);
    expect(m.drawingNumber).toBe('R4-001');
    expect(m.originalRevision).toBe('B'); expect(m.revisedRevision).toBe('C');
    expect(m.entities.some((e) => e.state === 'added' && e.layer === 'ROAD-CL')).toBe(true);
    expect(m.entities.filter((e) => e.state === 'added').every((e) => e.changeIds.length > 0)).toBe(true);
    expect(m.entities.find((e) => e.handle === 'A9')!.d).toContain('A'); // arc command, not a straight chord
    expect(m.extent.maxX).toBeCloseTo(5200, 0);
    expect(m.alignmentOk).toBe(true);
  });
  it('flags a long narrow drawing and offers undistorted detail windows', async () => {
    let out = await analyseDocuments({ files: [dr('b.dxf', orig), dr('c.dxf', rev)], narrative: '' });
    const m = buildViewModel(out.pairs[0], out.changes);
    expect(m.elongated).toBe(true);
    const w = detailWindows(m.extent);
    expect(w.length).toBeGreaterThan(1);
    w.forEach((x) => expect((x.box.maxX - x.box.minX) / Math.max(x.box.maxY - x.box.minY, 1e-9)).toBeGreaterThan(0));
  });
});

describe('relocation needs evidence, not a matching size', () => {
  const o = dxfText([...text('DWG NO: L-1 REV: A'), ...lw('LIGHT', 'A', [[0, 0], [10, 0]]), ...lw('KEEP', 'K', [[0, 5], [2, 5]])]);
  const r = dxfText([...text('DWG NO: L-1 REV: B'), ...lw('LIGHT', 'B', [[0, 50], [10, 50]]), ...lw('KEEP', 'K', [[0, 5], [2, 5]])]);
  it('keeps an equal-sized removal and addition separate and asks for confirmation', async () => {
    let out = await analyseDocuments({ files: [dr('o.dxf', o), dr('r.dxf', r)], narrative: 'Revise the lighting layout.' });
    const light = out.changes.filter((c) => c.component === 'LIGHT');
    expect(light.map((c) => c.change).sort()).toEqual(['added', 'removed']);
    expect(out.questions.some((q) => /relocation/i.test(q.title))).toBe(true);
  });
  it('treats it as a relocation only when the PVR says so', async () => {
    let out = await analyseDocuments({ files: [dr('o.dxf', o), dr('r.dxf', r)], narrative: 'The lighting cable route is relocated 50 m north.' });
    expect(hasRelocationEvidence(['relocated 50 m north'])).toBe(true);
    const light = out.changes.filter((c) => c.component === 'LIGHT');
    expect(light).toHaveLength(1); expect(light[0].change).toBe('modified');
  });
  it('drawing revision date is not an event date', async () => {
    let out = await analyseDocuments({ files: [dr('o.dxf', dxfText([...text('DWG NO: D-1 REV: A ISSUED 05/10/2026'), ...lw('X', 'a', [[0, 0], [1, 0]])])), dr('r.dxf', dxfText([...text('DWG NO: D-1 REV: B ISSUED 20/10/2026'), ...lw('X', 'a', [[0, 0], [2, 0]])]))], narrative: '' });
    expect(out.proposedEventDate).toBeNull();
  });
});

describe('viewport maths', () => {
  it('fits an extent without distorting the aspect ratio', () => {
    const v = fitViewport({ minX: 0, maxX: 1000, minY: 0, maxY: 10 }, 900, 500);
    expect(v.w / v.h).toBeCloseTo(900 / 500, 6);
    expect(v.w).toBeGreaterThanOrEqual(1000);
  });
  it('zooms about a point keeping that point fixed', () => {
    const v = zoomAt({ x: 0, y: 0, w: 100, h: 50 }, 40, 20, 2);
    expect(v.w).toBe(50); expect(v.h).toBe(25);
    expect(40 - v.x).toBeCloseTo((40 - 0) / 2, 9);
  });
});

describe('run state: late, cancelled and cross-case events are ignored', () => {
  const ev = (over: Partial<ProcessingEvent>): ProcessingEvent => ({ seq: 1, runId: 'A', caseId: 'c1', stage: 'geometry', status: 'progress', detail: '', at: 0, layer: 'L1', count: 5, fileName: 'f.dxf', ...over });
  it('applies matching events and drops others', () => {
    let s = runReducer(initialRun(), { type: 'start', runId: 'A', caseId: 'c1', at: 0 });
    s = runReducer(s, { type: 'event', event: ev({}) });
    s = runReducer(s, { type: 'event', event: ev({ runId: 'OLD', layer: 'X' }) });
    s = runReducer(s, { type: 'event', event: ev({ caseId: 'other', layer: 'Y' }) });
    expect(s.layers.map((l) => l.name)).toEqual(['L1']);
    expect(s.ignored).toBe(2);
  });
  it('a cancelled run ignores everything that arrives afterwards', () => {
    let s = runReducer(initialRun(), { type: 'start', runId: 'A', caseId: 'c1', at: 0 });
    s = runReducer(s, { type: 'cancel', runId: 'A', caseId: 'c1' });
    s = runReducer(s, { type: 'event', event: ev({ layer: 'LATE' }) });
    s = runReducer(s, { type: 'complete', runId: 'A', caseId: 'c1' });
    expect(s.status).toBe('cancelled'); expect(s.layers).toHaveLength(0);
  });
  it('a new run for another case is not polluted by the previous run', () => {
    let s = runReducer(initialRun(), { type: 'start', runId: 'A', caseId: 'c1', at: 0 });
    s = runReducer(s, { type: 'start', runId: 'B', caseId: 'c2', at: 1 });
    s = runReducer(s, { type: 'event', event: ev({ runId: 'A', caseId: 'c1', layer: 'OLD' }) });
    expect(s.layers).toHaveLength(0); expect(s.runId).toBe('B');
  });
  it('pausing or skipping playback never changes the run', () => {
    let s = runReducer(initialRun(), { type: 'start', runId: 'A', caseId: 'c1', at: 0 });
    s = runReducer(s, { type: 'event', event: ev({}) });
    const before = JSON.stringify(s);
    let p = playbackReducer(initialPlayback(), { type: 'pause' });
    p = playbackReducer(p, { type: 'tick', available: 1 });
    expect(p.position).toBe(0);
    p = playbackReducer(p, { type: 'skip', available: 1 });
    expect(visibleLayerCount(p, 1)).toBe(1);
    expect(JSON.stringify(s)).toBe(before);
    expect(s.status).toBe('running');
  });
  it('reduced motion shows everything immediately', () => {
    expect(initialPlayback(true).skipped).toBe(true);
    expect(visibleLayerCount(initialPlayback(true), 5)).toBe(5);
    expect(visibleLayerCount(initialPlayback(false), 5)).toBe(0);
  });
  it('analyseDocuments emits nothing after the run is aborted', async () => {
    const ac = new AbortController();
    const events: ProcessingEvent[] = [];
    const o = dxfText([...text('DWG NO: Z-1 REV: A'), ...lw('X', 'a', [[0, 0], [1, 0]])]);
    const r = await analyseDocuments({ files: [dr('o.dxf', o), dr('r.dxf', o)], narrative: '', signal: ac.signal, onEvent: (e) => { events.push(e); ac.abort(); } });
    expect(r.cancelled).toBe(true);
    expect(events.length).toBe(1); // first event delivered, then nothing
  });
});

describe('XER programmes are parsed from real files', () => {
  const xer = ['ERMHDR\t8.4', '%T\tPROJECT', '%F\tproj_id\tlast_recalc_date', '%R\t1\t2026-10-01 08:00', '%T\tPROJWBS', '%F\twbs_id\twbs_name', '%R\t10\tRoad R4', '%T\tTASK', '%F\ttask_id\ttask_code\ttask_name\twbs_id\ttarget_start_date\ttarget_end_date\ttarget_drtn_hr_cnt\ttotal_float_hr_cnt\tphys_complete_pct', '%R\t1\tA100\tExcavate\t10\t2026-11-01 08:00\t2026-11-10 17:00\t80\t16\t0', '%R\t2\tA110\tPave\t10\t2026-11-11 08:00\t2026-11-20 17:00\t80\t0\t0', '%T\tTASKPRED', '%F\ttask_id\tpred_task_id\tpred_type\tlag_hr_cnt', '%R\t2\t1\tPR_FS\t0', '%E'].join('\n');
  it('reads activities and relationships and reports them in the analysis', async () => {
    const m = parseXer(xer, 'p.xer');
    expect(m.activityCount).toBe(2); expect(m.relationships).toHaveLength(1); expect(m.dataDate).toBe('2026-10-01');
    let out = await analyseDocuments({ files: [{ name: 'p.xer', bytes: enc(xer), role: 'schedule' }], narrative: '' });
    expect(out.schedules[0].model.activities.map((a) => a.id)).toEqual(['A100', 'A110']);
    expect(out.files[0].stateLabel).toBe('Read successfully');
  });
});

describe('DOCX and PDF extraction with real files', () => {
  async function docx(paras: string[]): Promise<Uint8Array> {
    const z = new JSZip();
    z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    z.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
    return new Uint8Array(await z.generateAsync({ type: 'uint8array' }));
  }
  /** Minimal valid one-page-per-string text PDF with correct xref offsets. */
  function pdf(pages: string[]): Uint8Array {
    const objs: string[] = []; const kids: string[] = [];
    objs.push('<< /Type /Catalog /Pages 2 0 R >>');
    pages.forEach((_, i) => kids.push(`${4 + i * 2} 0 R`));
    objs.push(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`);
    objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    pages.forEach((t, i) => {
      const stream = `BT /F1 12 Tf 72 720 Td (${t.replace(/[()\\]/g, '')}) Tj ET`;
      objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
      objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    });
    let out = '%PDF-1.4\n'; const offs: number[] = [];
    objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const x = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
    return enc(out);
  }
  it('reads Word text', async () => {
    const d = await extractDocx('pvr.docx', await docx(['Extend access road R4 by 1,500 m.', 'Event date: 01/10/2026']));
    expect(d.method).toBe('docx');
    expect(d.pages.map((p) => p.text).join(' ')).toContain('Extend access road R4 by 1,500 m.');
  });
  it('reads PDF text with page numbers', async () => {
    const d = await extractPdf('letter.pdf', pdf(['Instruction to extend road by 1500 m', 'Second page instruction dated 02/10/2026']));
    expect(d.pages).toHaveLength(2);
    expect(d.pages[0].page).toBe(1); expect(d.pages[0].text).toContain('extend road by 1500 m');
    expect(d.pages[1].page).toBe(2); expect(d.pages[1].text).toContain('02/10/2026');
  });
  it('analysis carries stated quantities from a PDF and keeps the PDF text for the BOQ stage', async () => {
    const extractor = async (n: string, b: Uint8Array) => { const doc = n.endsWith('.pdf') ? await extractPdf(n, b) : await extractDocx(n, b); return { kind: 'text' as const, ok: true, doc }; };
    let out = await analyseDocuments({ files: [{ name: 'pvr.pdf', bytes: pdf(['Extend the road by 1,500 m to the east.']), role: 'pvr' }, { name: 'rfi.docx', bytes: await docx(['Event date: 01/10/2026']), role: 'correspondence' }], narrative: '', extractor });
    expect(out.extracted.map((x) => x.name).sort()).toEqual(['pvr.pdf', 'rfi.docx']);
    expect(out.changes.some((c) => c.changeQty === '1500')).toBe(true);
    expect(out.documents.find((d) => d.name === 'pvr.pdf')!.pages[0].page).toBe(1);
    expect(out.files.every((f) => f.stateLabel === 'Read successfully')).toBe(true);
  });
  it('without an extractor, a PDF is reported as not read, never silently skipped', async () => {
    let out = await analyseDocuments({ files: [{ name: 'pvr.pdf', bytes: pdf(['x']), role: 'pvr' }], narrative: '' });
    expect(out.files[0].stateLabel).toBe('Not supported');
    expect(out.capability.unsupported).toHaveLength(1);
  });
});

describe('DWG conversion is honest about its dependency', () => {
  it('reports exactly what is missing when nothing is configured', async () => {
    const st = dwgStatus({});
    expect(st.configured).toBe(false);
    if (!st.configured) { expect(st.requirement).toMatch(/ODA File Converter/); expect(st.requirement).toMatch(/LibreDWG/); expect(st.requirement).toMatch(/DWG_CONVERTER_PATH/); }
    const r = await convertDwg(enc('AC1032'), {});
    expect(r.ok).toBe(false); expect(r.error).toMatch(/DWG_CONVERTER/);
  });
  it('actually invokes a configured converter and returns its DXF', async () => {
    // A tiny shell "converter" that behaves like libredwg's dwg2dxf: writes the -o target.
    const { writeFile, chmod, mkdtemp } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'fake-conv-')); const script = join(dir, 'dwg2dxf');
    await writeFile(script, '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\nshift\nprintf "0\\nSECTION\\n2\\nENTITIES\\n0\\nENDSEC\\n0\\nEOF\\n" > "$1"\n');
    await chmod(script, 0o755);
    const r = await convertDwg(enc('AC1032'), { DWG_CONVERTER: 'libredwg', DWG_CONVERTER_PATH: script });
    expect(r.ok).toBe(true);
    expect(new TextDecoder().decode(r.dxf!)).toContain('EOF');
  });
  it('a DWG with no converter is reported as not read and offers the DXF alternative', async () => {
    let out = await analyseDocuments({ files: [dr('x.dwg', enc('AC1032'))], narrative: '' });
    expect(out.files[0].stateLabel).toBe('Not supported');
    expect(out.files[0].detail).toMatch(/ASCII DXF/);
  });
});

describe('multiple BOQ files and sheets are read', () => {
  it('reads CSV and every sheet of an XLSX workbook with cell references', async () => {
    const wb = new ExcelJS.Workbook();
    const s1 = wb.addWorksheet('Civil'); s1.addRow(['Item', 'Description', 'Unit', 'Qty', 'Rate']); s1.addRow(['1.1', 'Excavation', 'm3', 100, 25]);
    const s2 = wb.addWorksheet('Lighting'); s2.addRow(['Item', 'Description', 'Unit', 'Qty', 'Rate']); s2.addRow(['2.1', 'Lamp', 'nr', 10, 450]);
    const x = await readWorkbook('boq-a.xlsx', new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer));
    const c = await readWorkbook('boq-b.csv', enc('Item,Description,Unit,Qty,Rate\n3.1,Kerb,m,50,60\n'));
    expect(x.sheets.map((s) => s.name)).toEqual(['Civil', 'Lighting']);
    expect(x.sheets[1].rows.flatMap((r) => r.cells).some((cell) => cell.text === 'Lamp' && cell.address === 'B2')).toBe(true);
    expect(c.sheets).toHaveLength(1);
    expect(c.sha256).not.toBe(x.sha256);
  });
});

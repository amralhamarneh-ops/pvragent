import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { analyseDocuments } from '@/lib/drawings/analyse';
import { buildSavedDrawingReplay } from '@/lib/drawings/replay';
import { initialRun, runReducer } from '@/lib/drawings/runState';
import DrawingAnalysisPanel from './DrawingAnalysisPanel';
import SavedDrawingReplay from './SavedDrawingReplay';

const dxf = (revised: boolean) => new TextEncoder().encode([
  0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 6, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES',
  0, 'LINE', 5, 'A1', 8, 'REFERENCE', 10, 0, 20, 0, 11, 50, 21, 0,
  0, 'LINE', 5, 'A2', 8, 'REFERENCE', 10, 0, 20, 10, 11, 50, 21, 10,
  ...(revised ? [0, 'LINE', 5, 'B2', 8, 'GUARD RAIL', 10, 50, 20, 1, 11, 62, 21, 1] : []),
  0, 'ENDSEC', 0, 'EOF', '',
].join('\n'));
const noop = () => {};
it('shows the current real-run drawing sheet as well as the saved assessment preview', async () => {
  const files = [
    { name: 'TEST-CIV-101 Rev A.dxf', bytes: dxf(false), id: 'original', sha256: 'a'.repeat(64), role: 'drawings' as const },
    { name: 'TEST-CIV-101 Rev B.dxf', bytes: dxf(true), id: 'revised', sha256: 'b'.repeat(64), role: 'drawings' as const },
  ];
  const runId = 'test-run', caseId = 'test-case';
  let run = runReducer(initialRun(), {type:'start', runId, caseId, at:0});
  const out = await analyseDocuments({ files, narrative: '', runId, caseId, streamGeometry:true, onEvent: event => {
    run = runReducer(run, {type:'event', event});
  } });
  expect(run.live[files[1].name].delivered).toBe(3);
  expect(run.stages.measurement).toBe('done');
  run = runReducer(run, {type:'complete', runId, caseId});
  expect(run.stages.loading).toBe('done');
  const replay = buildSavedDrawingReplay(out);
  expect(replay).not.toBeNull();
  const liveComplete = renderToStaticMarkup(createElement(DrawingAnalysisPanel, {
    scopeId: caseId, documents: files, narrative: '', run, out, streamGeometry: true,
    onStreamGeometry: noop, onStart: noop, onCancel: noop,
  }));
  const saved = renderToStaticMarkup(createElement(SavedDrawingReplay, {replay: replay!, changes: out.changes, showSheets:true}));
  for (const html of [liveComplete, saved]) {
    const svgs = [...html.matchAll(/<svg[^>]*viewBox="([^"]+)"[^>]*>(.*?)<\/svg>/g)].filter(([svg])=>svg.includes('full drawing with numbered red change boxes'));
    expect(svgs).toHaveLength(2);
    expect(svgs[0][1]).toBe(svgs[1][1]);
    expect(svgs[0][2]).not.toContain('M50 -1L62 -1');
    expect(svgs[1][2]).toContain('M50 -1L62 -1');
    expect(html).toContain('Replay completed processing');
  }
  expect(out.changes.find(c=>c.component==='GUARD RAIL')).toMatchObject({unit:'m',addedQty:'12'});
});

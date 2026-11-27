import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { runBrowserRehearsal } from '@/lib/demo/browserRehearsal';
import DrawingChangeSheets from './DrawingChangeSheets';

const bytes = (s: string) => new TextEncoder().encode(s);
const dxf = (add: boolean) => bytes([
  0,'SECTION',2,'HEADER',9,'$INSUNITS',70,6,0,'ENDSEC',0,'SECTION',2,'ENTITIES',
  0,'LINE',5,'A1',8,'REFERENCE',10,0,20,0,11,50,21,0,
  0,'LINE',5,'A2',8,'REFERENCE',10,0,20,10,11,50,21,10,
  ...(add ? [0,'LINE',5,'B2',8,'GUARD RAIL',10,50,20,1,11,62,21,1] : []),
  0,'ENDSEC',0,'EOF','',
].join('\n'));

it('shows the original and revised drawings at a shared scale without drawing the addition on the original', async () => {
  const run = await runBrowserRehearsal(
    { name: 'DEMO-CIV-101 Rev A.dxf', bytes: dxf(false) },
    { name: 'DEMO-CIV-101 Rev B.dxf', bytes: dxf(true) },
    { name: 'BOQ.csv', bytes: bytes('Item,Description,Unit,Qty,Rate,Amount\nGR-01,Guard rail,m,100,120,12000\n') },
  );
  const html = renderToStaticMarkup(createElement(DrawingChangeSheets, { model: run.replay.models[0], changes: run.changes }));
  const svgs = Array.from(html.matchAll(/<svg[^>]*viewBox="([^"]+)"[^>]*>(.*?)<\/svg>/g));
  expect(svgs).toHaveLength(4);
  expect(svgs[0][1]).toBe(svgs[1][1]);
  expect(svgs[2][1]).toBe(svgs[3][1]);
  expect(svgs[0][2]).not.toContain('M50 -1L62 -1');
  expect(svgs[0][2]).toContain('stroke-dasharray="5 4"');
  expect(svgs[1][2]).toContain('M50 -1L62 -1');
  expect(svgs[1][2]).not.toContain('stroke-dasharray="5 4"');
  expect(html).toContain('not a reproduction of the native sheet border or title block');
});

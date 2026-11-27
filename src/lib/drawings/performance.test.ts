import { expect, it, vi } from 'vitest';
import { AnalysisReadCache, analyseDocuments, type InputFile } from './analyse';
import { diffEntities } from './compare';
import type { Extractor } from './extractClient';
import type { DrawingEntity, DrawingFile } from './types';

const enc = (s: string) => new TextEncoder().encode(s);
const drawingEntity = (handle: string, x: number, length: number): DrawingEntity => ({
  handle, kind: 'LINE', layer: 'GUARD RAIL', vertices: [{x, y: 0}, {x: x + length, y: 0}],
  closed: false, length, area: 0,
});
const file = (entities: DrawingEntity[]): DrawingFile => ({
  fileName:'test', format:'dxf', state:'read', limitation:'', titleBlock:null, texts:[], unit:'m',
  unitSource:'fixture', entities, layers:['GUARD RAIL'], extents:null, validationIssues:[], metresPerUnit:1,
});
const dxf = (rev: string, count: number) => enc([
  0,'SECTION',2,'HEADER',9,'$INSUNITS',70,6,0,'ENDSEC',0,'SECTION',2,'ENTITIES',
  0,'TEXT',5,'A0',8,'TITLEBLOCK',10,0,20,12,40,1,1,`DWG NO: DEMO-CIV-101 REV: ${rev}`,
  ...Array.from({length: count}, (_, i) => [0,'LINE',5,`B${i}`,8,'GUARD RAIL',10,0,20,i,11,12,21,i]).flat(),
  0,'ENDSEC',0,'EOF',
].join('\n')+'\n');

it('keeps original-order selection, ambiguity and one-to-one evidence when indexing candidate sizes', () => {
  const o = file([drawingEntity('first',1,10.05),drawingEntity('second',2,9.95),drawingEntity('unique',3,15)]);
  const r = file([drawingEntity('add-a',30,10),drawingEntity('add-b',40,15),drawingEntity('add-c',50,15)]);
  const [d] = diffEntities(o,r,0.01,true);
  expect(d.ambiguous?.map((a)=>a.removed)).toEqual([2]);
  expect(d.candidatePairs[0].from.handle).toBe('first');
  expect(d.relocated.map((a)=>[a.from.handle,a.to.handle])).toEqual([['unique','add-b']]);
  expect(d.removed.map((e)=>e.handle)).toEqual(['first','second']);
  expect(d.added.map((e)=>e.handle)).toEqual(['add-a','add-c']);
});

it('does not drop any candidates on a dense layer with equal-size changes', () => {
  const n = 5000;
  const o = file(Array.from({length:n}, (_,i)=>drawingEntity(`old${i}`,i,10)));
  const r = file(Array.from({length:n}, (_,i)=>drawingEntity(`new${i}`,i+n,10)));
  const [d] = diffEntities(o,r,0.01,true);
  expect(d.ambiguous).toHaveLength(n);
  expect(d.ambiguous?.every(x=>x.removed===n)).toBe(true);
  expect(d.candidatePairs.every(x=>x.from.handle==='old0')).toBe(true);
  expect([d.added.length,d.removed.length,d.relocated.length]).toEqual([n,n,0]);
});

it('preserves all geometry, measured quantities and trace with live preview off and on a cached rerun', async () => {
  const cad = [{name:'DEMO-CIV-101 Rev A.dxf',bytes:dxf('A',3),role:'drawings'}, {name:'DEMO-CIV-101 Rev B.dxf',bytes:dxf('B',4),role:'drawings'}] satisfies InputFile[];
  const stream = vi.fn(); const noStream = vi.fn(); const readCache = new AnalysisReadCache();
  const animated = await analyseDocuments({files:cad,narrative:'',onEvent:stream});
  const unanimated = await analyseDocuments({files:cad,narrative:'',onEvent:noStream,streamGeometry:false,readCache});
  const cached = await analyseDocuments({files:cad,narrative:'',readCache});
  expect(stream.mock.calls.some(([e])=>e.batch)).toBe(true);
  expect(noStream.mock.calls.some(([e])=>e.batch)).toBe(false);
  expect(unanimated.changes).toEqual(animated.changes);
  expect(cached.changes).toEqual(animated.changes);
  expect(cached.drawings[0].entities).toBe(unanimated.drawings[0].entities);
  expect(cached.changes.some(x=>x.addedQty==='12' && x.entityRefs?.revised[0].handle==='B3')).toBe(true);
  const replaced = await analyseDocuments({files:[cad[0],{...cad[1],bytes:dxf('B',5)}],narrative:'',readCache});
  expect(replaced.changes.some(x=>x.addedQty==='24')).toBe(true);
});

it('does not cache failures, truncated reads, aborted extraction or a different file or reader', async () => {
  const bytes = enc('contents'); const readCache = new AnalysisReadCache();
  const success = {kind:'text',ok:true,doc:{name:'doc.pdf',pages:[{page:1,text:'Evidence'}],method:'pdf-text',limitation:'',truncated:false}} as const;
  const fresh = {...success,doc:{...success.doc,pages:[...success.doc.pages]}};
  const reader = vi.fn<Extractor>().mockResolvedValueOnce({kind:'text',ok:false,error:'timeout'})
    .mockResolvedValueOnce({...fresh,doc:{...fresh.doc,truncated:true}}).mockResolvedValue(fresh);
  const ac = new AbortController(); ac.abort();
  for(let i=0;i<2;i+=1) await readCache.extract(reader,'doc.pdf',bytes);
  await readCache.extract(reader,'doc.pdf',bytes,undefined,ac.signal);
  await readCache.extract(reader,'doc.pdf',bytes);
  await readCache.extract(reader,'doc.pdf',bytes);
  expect(reader).toHaveBeenCalledTimes(4);
  await readCache.extract(reader,'renamed.pdf',bytes);
  await readCache.extract(reader,'doc.pdf',enc('replacement'));
  expect(reader).toHaveBeenCalledTimes(6);
  const alternate = vi.fn<Extractor>().mockResolvedValue(fresh);
  await readCache.extract(alternate,'doc.pdf',bytes);
  expect(alternate).toHaveBeenCalledOnce();
});

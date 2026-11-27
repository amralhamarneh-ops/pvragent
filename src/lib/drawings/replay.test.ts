import { describe, expect, it } from 'vitest';
import { analyseDocuments } from './analyse';
import { buildHandoff, normaliseHandoff } from './handoff';
import { buildSavedDrawingReplay, readSavedDrawingReplay, REPLAY_SPEEDS, replayDelay } from './replay';

const dxf = (revision: string, revised: boolean) => new TextEncoder().encode([
  0,'SECTION',2,'HEADER',9,'$INSUNITS',70,6,0,'ENDSEC',0,'SECTION',2,'ENTITIES',
  0,'TEXT',5,'A0',8,'TITLEBLOCK',10,0,20,0,40,1,1,`DWG NO: DEMO-CIV-101 REV: ${revision}`,
  0,'LINE',5,'B1',8,'GUARD RAIL',10,0,20,0,11,50,21,0,
  ...(revised ? [0,'LINE',5,'B2',8,'GUARD RAIL',10,50,20,0,11,62,21,0] : []),
  0,'ENDSEC',0,'EOF',
].join('\n')+'\n');

describe('drawing replay', () => {
  it('has monotonically faster timings at the actual selected speed', () => {
    expect(REPLAY_SPEEDS).toEqual([1,2,5,10,20,40]);
    expect(REPLAY_SPEEDS.map(replayDelay)).toEqual([800,400,160,80,40,20]);
  });
  it('round trips the completed real DXF comparison without changing the measured output', async () => {
    const out = await analyseDocuments({narrative:'',files:[{name:'DEMO-CIV-101 Rev A.dxf',bytes:dxf('A',false),role:'drawings'},{name:'DEMO-CIV-101 Rev B.dxf',bytes:dxf('B',true),role:'drawings'}]});
    expect(out.pairs[0].validated).toBe(true);
    const handoff = buildHandoff(out,{});
    handoff.drawingReplay = buildSavedDrawingReplay(out) ?? undefined;
    const restored = normaliseHandoff(JSON.parse(JSON.stringify(handoff)));
    expect(restored?.drawingReplay?.models[0].entities.find((e)=>e.handle==='B2')).toMatchObject({state:'added',length:12});
    expect(restored?.records?.find((v)=>v.component==='GUARD RAIL')).toMatchObject({addedQty:'12',unit:'m'});
    expect(readSavedDrawingReplay({version:1,eligiblePairCount:1,models:[{...restored?.drawingReplay?.models[0],entities:[]}]})).toBeNull();
  });
});

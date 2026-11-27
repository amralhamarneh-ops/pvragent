import { describe, expect, it } from 'vitest';
import { runBrowserRehearsal, loadBrowserRehearsal } from './browserRehearsal';

const bytes = (s: string) => new TextEncoder().encode(s);
const makeDxf = (rev: 'A'|'B') => bytes([
  0,'SECTION',2,'HEADER',9,'$ACADVER',1,'AC1015',9,'$INSUNITS',70,6,0,'ENDSEC',0,'SECTION',2,'ENTITIES',
  0,'LINE',5,'A1',8,'REFERENCE',10,0,20,0,11,50,21,0,
  0,'LINE',5,'A2',8,'REFERENCE',10,0,20,10,11,50,21,10,
  ...(rev === 'B' ? [
    0,'LINE',5,'B2',8,'GUARD RAIL',10,50,20,1,11,62,21,1,
    0,'LWPOLYLINE',5,'C2',8,'CONCRETE FOOTPATH',90,4,70,1,10,50,20,2,10,62,20,2,10,62,20,4,10,50,20,4,
  ] : []),0,'ENDSEC',0,'EOF','',
].join('\n'));
const a={name:'DEMO-CIV-101 Rev A.dxf',bytes:makeDxf('A')};
const b={name:'DEMO-CIV-101 Rev B.dxf',bytes:makeDxf('B')};
const csv=(rows:string)=>({name:'BOQ Civil.csv',bytes:bytes('Item,Description,Unit,Qty,Rate,Amount\n'+rows)});
const normal='GR-01,Guard rail,m,100,120,12000\nFP-01,Concrete footpath,m2,200,85,17000\n';
describe('browser-only drawing and BOQ rehearsal',()=>{
  it('matches current measured drawing changes to the uploaded BOQ and restores the completed run',async()=>{
    const out=await runBrowserRehearsal(a,b,csv(normal),'Processed PVR.txt');
    const restored=loadBrowserRehearsal(JSON.stringify(out));
    expect(restored?.replay.models).toHaveLength(1);
    const results=Object.fromEntries(out.changes.map(c=>[c.component,[c.netQty,out.mappings.find(m=>m.id===c.id)?.proposal?.ref]]));
    expect(results).toEqual({'GUARD RAIL':['12','GR-01'],'CONCRETE FOOTPATH':['24','FP-01']});
    expect(restored?.sources[3].role).toContain('Reference only');
    expect(restored?.events.map(e=>e.step)).toEqual(['Read drawings','Compare revisions','Measure changes','Read uploaded BOQ','Propose BOQ matches']);
  });
  it('leaves a wrong unit or competing BOQ rows unresolved without changing the drawing quantity',async()=>{
    for(const rows of [normal.replace('Guard rail,m,','Guard rail,m2,'),normal+'GR-02,Guard rail,m,120,125,15000\n']){
      const out=await runBrowserRehearsal(a,b,csv(rows));
      const guard=out.changes.find(c=>c.component==='GUARD RAIL');
      expect(guard?.netQty).toBe('12');
      expect(out.mappings.find(m=>m.id===guard?.id)?.proposal).toBeNull();
      expect(out.mappings.some(m=>m.proposal?.ref==='FP-01')).toBe(true);
    }
  });
  it('does not allow the user to accidentally treat the revised drawing as the original',async()=>{
    await expect(runBrowserRehearsal(b,a,csv(normal))).rejects.toThrow(/original.*revised/);
  });
});

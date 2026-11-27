import { beforeAll, describe, expect, it } from 'vitest';
import { loadBrowserRehearsal, runBrowserRehearsal, type BrowserRehearsal, type DemoFile } from './browserRehearsal';
import { calculateRehearsalSchedule } from './scheduleRehearsal';
import { completeCivilSample } from './scheduleSample';

const sample=completeCivilSample();
let run:BrowserRehearsal;
const edit = (f:DemoFile, fn:(s:string)=>string) => ({...f,bytes:new TextEncoder().encode(fn(new TextDecoder().decode(f.bytes)))});
beforeAll(async()=>{run=await runBrowserRehearsal(sample.original,sample.revised,sample.boq,sample.referenceName);});

describe('end-to-end PVR civil rehearsal',()=>{
  it('links two measured changes through actual uploaded BOQ rows to XER activities; shows milestones, float and completion',async()=>{
    const r=await calculateRehearsalSchedule(run,sample.schedule,true);
    expect(r.blockers).toEqual([]);
    expect(r.checkedCount).toBe(7);
    expect(r.mappings.map(m=>[m.boqRef,m.qty,m.code,m.rate,m.workDays])).toEqual([
      ['FP-01','24','CIV-110','12',2],['GR-01','12','CIV-120','6',2],
    ]);
    expect([r.before,r.after,r.completionDelta]).toEqual(['2027-02-08','2027-02-12',4]);
    expect(r.rows.filter(x=>x.kind==='milestone_finish').map(x=>[x.code,x.shift])).toEqual([['CIV-115',2],['CIV-140',4]]);
    expect(r.rows.find(x=>x.code==='CIV-125')).toMatchObject({shift:0,beforeFloat:3,afterFloat:7,driving:false});
    expect(r.path).toEqual(['CIV-100','CIV-110','CIV-115','CIV-120','CIV-130','CIV-140']);
    expect(r.benchmark).toMatchObject({status:'matched',milestoneMatches:2,milestoneCount:2});
    expect(loadBrowserRehearsal(JSON.stringify({...run,schedule:r}))?.schedule).toEqual(r);
    expect(loadBrowserRehearsal(JSON.stringify(run))?.schedule).toBeUndefined();
    expect(loadBrowserRehearsal(JSON.stringify({...run,schedule:{...r,mappings:[]}}))).toBeNull();
  });
  it('does not let a changed or unavailable reference influence the prediction',async()=>{
    const altered=edit(sample.schedule.benchmark,s=>s.replace('2027-02-12 17:00\tCT_TotFloat','2027-02-17 17:00\tCT_TotFloat'));
    const r=await calculateRehearsalSchedule(run,{...sample.schedule,benchmark:altered});
    expect(r.after).toBe('2027-02-12');
    expect(r.benchmark).toMatchObject({status:'different',storedFinish:'2027-02-17'});
    const nr=await calculateRehearsalSchedule(run,{...sample.schedule,benchmark:undefined});
    expect(nr.after).toBe(r.after);expect(nr.rows).toEqual(r.rows);expect(nr.benchmark).toBeNull();
  });
  it('blocks uncertain duration, ambiguous BOQ links and an unreproduced source instead of reporting zero impact',async()=>{
    const noRate=edit(sample.schedule.productivity,s=>s.replace('GR-01,m,6,','GR-01,m2,6,'));
    const ambiguous=edit(sample.schedule.baseline,s=>s.replace('%R\t104\t302\n','%R\t104\t302\n%R\t107\t302\n'));
    const mismatch=edit(sample.schedule.baseline,s=>s.replace('2027-02-08 17:00\tCT_TotFloat','2027-02-09 17:00\tCT_TotFloat'));
    for(const [f,reason] of [[{productivity:noRate},/matching-unit/],[{baseline:ambiguous},/multiple activities/],[{baseline:mismatch},/did not reproduce/]] as const) {
      const r=await calculateRehearsalSchedule(run,{...sample.schedule,...f});
      expect(r.after).toBe('');expect(r.completionDelta).toBeNull();expect(r.blockers.join()).toMatch(reason);
    }
  });
});

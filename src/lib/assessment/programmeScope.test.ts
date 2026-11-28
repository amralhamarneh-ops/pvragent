import {describe,expect,it} from 'vitest';
import {anchorKey,reviewProgrammeScope,scopeHours,type ProgrammeScopeLine,type ScopeDecision} from './programmeScope';
const line:ProgrammeScopeLine={id:'DRAW-1',name:'Civil work',quantity:'12',unit:'m',drawingSource:'Verified DXF',boqSource:'BOQ 1.1',activityCodes:['WORK']};
const take:ScopeDecision={treatment:'include',rate:'1.5',basis:'Measured crew production'};
describe('build a reviewable duration scenario',()=>{
  it('derives 8 working hours from 12 m and 1.5 m/hour, not a BOQ rate',()=>{
    expect(scopeHours(line,take)).toMatchObject({entries:[{minutes:480,code:'WORK',quantity:'12'}]});
    expect(scopeHours({...line,boqSource:'unavailable'},take)).toMatchObject({entries:[{minutes:480}]});
  });
  it('holds an unmeasured or unmapped line unless deliberately excluded with a reason',()=>{
    const unsupported={...line,id:'DRAW-2',quantity:null,drawingSource:'',activityCodes:[]};
    expect(reviewProgrammeScope([line,unsupported],{'DRAW-1':take}).changes).toEqual([]);
    const r=reviewProgrammeScope([line,unsupported],{'DRAW-1':take,'DRAW-2':{...take,treatment:'exclude',basis:'Separate procurement scope, not tested'}});
    expect(r.error).toBe('');expect(r.exclusions).toBe(1);expect(r.changes).toEqual([{code:'WORK',hours:8}]);
  });
  it('splits exact measured work, rounds each duration upward, and combines only within each task',()=>{
    const split={...line,activityCodes:['WORK','PIPE'],split:{WORK:'25',PIPE:'75'}};
    expect(scopeHours(split,take)).toMatchObject({entries:[{code:'WORK',minutes:120,quantity:'3'},{code:'PIPE',minutes:360,quantity:'9'}]});
    expect(reviewProgrammeScope([split,{...line,id:'DRAW-2',quantity:'.002'}],{'DRAW-1':take,'DRAW-2':take}).changes)
      .toEqual([{code:'PIPE',hours:6},{code:'WORK',hours:121/60}]);
    expect(scopeHours({...split,split:{WORK:'25',PIPE:'74.99999'}},take)).toMatchObject({error:expect.stringContaining('100%')});
  });
  it('does not turn omissions, rework or unreviewed scope into generic extensions',()=>{
    expect(scopeHours({...line,blocker:'Separate time basis required.'},take)).toEqual({error:'Separate time basis required.'});
    expect(scopeHours(line,{...take,rate:'0'})).toHaveProperty('error');
    expect(scopeHours(line,{...take,rate:'0.00000000000001'})).toHaveProperty('error');
    expect(scopeHours(line,{...take,rate:'-1'})).toHaveProperty('error');
  });
  it('requires source anchors and refuses to assume parallel sequencing for two insertions',()=>{
    const from='WORK',to='END',anchor=new Set([anchorKey({from,to})]);
    const newLine={...line,activityCodes:[],newCode:'PVR-NEW-1'};
    const decision={...take,predecessor:from,successor:to};
    expect(reviewProgrammeScope([newLine],{'DRAW-1':decision}).error).not.toBe('');
    expect(reviewProgrammeScope([newLine],{'DRAW-1':decision},anchor).fragments).toEqual([{code:'PVR-NEW-1',from,to,hours:8}]);
    expect(reviewProgrammeScope([newLine,{...newLine,id:'DRAW-2',newCode:'PVR-NEW-2'}],{'DRAW-1':decision,'DRAW-2':decision},anchor).error).toMatch(/parallel/);
  });
});

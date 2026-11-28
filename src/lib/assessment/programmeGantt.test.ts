import {describe,expect,it} from 'vitest';
import {makeGanttLayout} from './programmeGantt';
describe('programme Gantt date axis',()=>{
  it('uses one chronological scale for source and simulated rows',()=>{
    const b={start:'2027-02-01 08:00',finish:'2027-02-02 17:00'};
    const a={start:'2027-02-01T08:00:00',finish:'2027-02-03T17:00:00'};
    const axis=makeGanttLayout([{code:'CIV',name:'Civil work',before:b,after:a}]);
    expect(axis.position(b.start)).toBe(axis.position(a.start));
    expect(axis.position(a.finish)).toBeGreaterThan(axis.position(b.finish));
    expect(axis.ticks[0]).toBe('2027-02-01');
  });
  it('keeps a zero-duration milestone but skips reversed and invalid dates',()=>{
    const g=makeGanttLayout([{code:'M',name:'Finish',milestone:true,before:{start:'2027-02-02',finish:'2027-02-02'}},
      {code:'B',name:'Reversed',after:{start:'2027-02-03',finish:'2027-02-02'}},
      {code:'C',name:'Invalid',before:{start:'N/A',finish:'2027-02-02'}}]);
    expect(g.rows.map(x=>x.code)).toEqual(['M']);
    expect(new Set(g.ticks).size).toBe(g.ticks.length);
  });
  it('does not show more than the bounded preview',()=>{
    const rows=Array.from({length:200},(_,i)=>({name:'Activity',code:String(i),before:{start:'2027-02-02',finish:'2027-02-05'}}));
    const axis=makeGanttLayout(rows,12);expect(axis.total).toBe(200);expect(axis.rows).toHaveLength(12);
  });
});

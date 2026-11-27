import {describe,it,expect} from 'vitest';
import {parseXer} from '../mapping/xerParser';
import {compareProgrammeEvidence, testDurationChange, validateRealProgramme} from './realProgramme';
import {calculateCpm,drivingPath,type CpmNetwork} from './cpmEngine';

const weeks = [1,2,3,4,5,6,7].map(d => `(0||${d}()(${d>=2 && d<=6?'(0||0(s|08:00|f|12:00)())(0||1(s|13:00|f|17:00)())':''}))`).join('');
const cal = `(0||CalendarData()((0||DaysOfWeek()(${weeks}))(0||VIEW(ShowTotal|Y)())(0||Exceptions()())))`;
const tbl = (name:string, fields:string[], rows:string[][]) =>
  [['%T',name],['%F',...fields],...rows.map(r=>['%R',...r])].map(row=>row.join('\t')).join('\n');
function fixture({date='2027-02-01 08:00',remaining='16',lag='0',lagCal='rcal_Successor',finish='2027-02-02 17:00',actual=''}={}) {
  return parseXer([
    tbl('PROJECT',['proj_id','proj_short_name','clndr_id','last_recalc_date','scd_end_date','critical_path_type'],[['1','TEST','1',date,finish,'CT_TotFloat']]),
    tbl('SCHEDOPTIONS',['proj_id','sched_retained_logic','sched_progress_override','sched_float_type','sched_calendar_on_relationship_lag'],[['1','Y','N','FT_FF',lagCal]]),
    tbl('CALENDAR',['clndr_id','clndr_name','day_hr_cnt','clndr_data'],[['1','Test working calendar','8',cal]]),
    tbl('TASK',['task_id','proj_id','task_type','task_code','task_name','clndr_id','status_code','target_drtn_hr_cnt','remain_drtn_hr_cnt','early_start_date','early_end_date','total_float_hr_cnt','act_start_date'],
      [['101','1','TT_Task','ACT','Real test activity','1','TK_NotStart','16',remaining,'2027-02-01 08:00',finish,'0',actual],
       ['102','1','TT_FinMile','END','Finish','1','TK_NotStart','0','0',finish,finish,'0','']]),
    tbl('TASKPRED',['task_id','pred_task_id','pred_type','lag_hr_cnt'],[['102','101','PR_FS',lag]]),
  ].join('\n'));
}

describe('real programme assessment',()=>{
  it('builds the live network from XER IDs and reproduces stored inputs before any impact',()=>{
    const d=validateRealProgramme(fixture());
    expect(d.reasons).toEqual([]); expect(d.compared).toBe(2);
    expect(d.network?.activities.map(a=>a.id)).toEqual(['101','102']);
    expect(d.result?.projectFinish).toBe('2027-02-02');
    expect(testDurationChange(d,'101',1)?.after).toBe('2027-02-03');
    expect(testDurationChange(d,'102',1)).toBeNull();
  });
  it('does not score a benchmark with a different data date or progress',()=>{
    const d=compareProgrammeEvidence(fixture(),fixture({date:'2027-02-02 08:00',finish:'2027-02-04 17:00',actual:'2027-02-01 08:00'}));
    expect(d.observedCalendarDays).toBe(2); expect(d.progressChanges).toBe(1); expect(d.checks).toHaveLength(2);
  });
  it('discloses changed existing durations and ties even with the same data date and progress',()=>{
    const d=compareProgrammeEvidence(fixture(),fixture({remaining:'24',lag:'8'}));
    expect(d.checks).toEqual([]);
    expect(d.existingDurationChanges).toEqual([{code:'ACT',before:'16',after:'24'}]);
    expect(d.existingLinkAdds).toBe(1);
    expect(d.existingLinkRemovals).toBe(1);
  });
  it('blocks fractional data and incompatible calendars rather than rounding them',()=>{
    const d=validateRealProgramme(fixture({remaining:'16.1',lag:'4',lagCal:'rcal_Predecessor'}));
    expect(d.result).toBeNull(); expect(d.reasons.join(' ')).toMatch(/lag.*Fractional/i);
  });
  it('does not promote a self-comparison or allow a scenario on unmatched unchanged results',()=>{
    const d=validateRealProgramme(fixture({finish:'2027-02-04 17:00'}));
    expect(d.reasons.length).toBeGreaterThan(0); expect(d.mismatches).toBe(2);
    expect(testDurationChange(d,'101',1)).toBeNull();
  });
});

describe('zero-duration milestone and holiday regression',()=>{
  it.each([
    ['control','2027-02-12',4,['START','A','B','FINISH']],
    ['driving','2027-02-17',7,['START','A','X','B','FINISH']],
    ['parallel','2027-02-12',1,['START','A','B','FINISH']],
  ])('%s: handles the day boundaries and reports the driving chain',(kind,finish,float,path)=>{
    const dur:Record<string,number> = {START:0,A:4,B:5,C:5,FINISH:0,...(kind==='control'?{}:{X:3})};
    const links=[['START','A'],['START','C'],['B','FINISH'],...(kind==='driving'?[['A','X'],['X','B']]:[['A','B']]),...(kind==='parallel'?[['C','X'],['X','FINISH']]:[['C','FINISH']])];
    const net:CpmNetwork = {
      activities:Object.entries(dur).map(([id,d])=>({id,name:id,type:id==='START'?'milestone_start':id==='FINISH'?'milestone_finish':'task',calendarId:'cal',originalDuration:d,remainingDuration:d})),
      relationships:links.map(([from,to])=>({from,to,type:'FS',lag:0})),dataDate:'2027-02-01',projectCalendarId:'cal',
      calendars:[{id:'cal',name:'5 days',workDays:[1,2,3,4,5],holidays:['2027-02-03']}],
      settings:{progressMode:'retained_logic',resourceLevelling:false,criticalDefinition:'total_float_lte_zero'},
    };
    const r=calculateCpm(net);
    expect(r.projectFinish).toBe(finish); expect(r.activities.C.totalFloat).toBe(float);
    expect(drivingPath(r,'FINISH')).toEqual(path);
  });
});

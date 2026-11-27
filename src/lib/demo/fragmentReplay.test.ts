import { describe, expect, it } from 'vitest';
import { readSavedFragment, runFragmentReplay } from './fragmentReplay';

function fixture(opts: {reference?:string; lag?:string; exception?:string; predecessor?:string; constraint?:string} = {}) {
  const cal = (days:number[]) => '(0||DaysOfWeek()(' + Array.from({length:7}, (_,i) =>
    `(0||${i+1}()(${days.includes(i+1)?'(0||0(s|08:00|f|18:00)())':''}))`).join('') + '))(0||Exceptions()(' +
    (opts.exception ? `(0||0(d|${opts.exception})())` : '') + '))';
  return new TextEncoder().encode([
    'ERMHDR\t23.0',
    '%T\tPROJECT','%F\tlast_recalc_date','%R\t2026-07-13',
    '%T\tCALENDAR','%F\tclndr_id\tclndr_name\tday_hr_cnt\tclndr_data',
    '%R\t1\tSix-day calendar\t10\t'+cal([2,3,4,5,6,7]),'%R\t2\tSeven-day calendar\t10\t'+cal([1,2,3,4,5,6,7]),
    '%T\tTASK','%F\ttask_id\ttask_code\ttask_name\ttask_type\tstatus_code\tclndr_id\ttarget_drtn_hr_cnt\tremain_drtn_hr_cnt\tearly_end_date\tcstr_type\tcstr_date',
    `%R\t100\tA1\tInstruction\tTT_Task\tTK_NotStart\t1\t10\t10\t2026-07-15 18:00\t${opts.constraint??'CS_MSO'}\t2026-07-15 00:00`,
    `%R\t101\tA2\tWork\tTT_Task\tTK_NotStart\t2\t40\t40\t${opts.reference??'2026-07-19'} 18:00\t\t`,
    '%T\tTASKPRED','%F\ttask_id\tpred_task_id\tpred_type\tlag_hr_cnt',
    `%R\t101\t100\tPR_FS\t${opts.lag??'0'}`,...(opts.predecessor?[`%R\t100\t${opts.predecessor}\tPR_FS\t0`]:[]), '%E',
  ].join('\n'));
}
const run = (opts?: Parameters<typeof fixture>[0])=>runFragmentReplay(fixture(opts),'reference.xer','A1','A2');

describe('local demo-only impacted-XER replay',()=>{
  it('uses calendar working time and source durations, not stored finishes',()=>{
    const result=run();
    expect(result.rows.map(r=>[r.start,r.finish,r.storedFinish,r.days,r.weekDays])).toEqual([
      ['2026-07-15','2026-07-15','2026-07-15',1,6],
      ['2026-07-16','2026-07-19','2026-07-19',4,7],
    ]);
    expect(run({reference:'2026-07-18'}).rows[1]).toMatchObject({finish:'2026-07-19',storedFinish:'2026-07-18'});
    expect(readSavedFragment(JSON.stringify(result))).toEqual(result);
  });
  it('fails closed for another incoming link, nonzero lag, an unsupported constraint or overlapping exceptions',()=>{
    expect(()=>run({predecessor:'200'})).toThrow('no other incoming links');
    expect(()=>run({lag:'10'})).toThrow('zero-lag');
    expect(()=>run({constraint:'CS_SNET'})).toThrow('mandatory start');
    const serial=String((Date.parse('2026-07-17')-Date.parse('1899-12-30'))/86400000);
    expect(()=>run({exception:serial})).toThrow('exception falls inside');
  });
  it('rejects invalid saved data and incorrect activity selections',()=>{
    expect(readSavedFragment('{"rows":[]}')).toBeNull();
    expect(()=>runFragmentReplay(fixture(),'reference.xer','A1','A1')).toThrow('different');
    expect(()=>runFragmentReplay(fixture(),'reference.xer','A1','UNKNOWN')).toThrow('missing');
  });
});

// Synthetic data only. The source and check XER date rows are authored separately from the solver.
import type { DemoFile } from './browserRehearsal';
const file = (name: string, text: string): DemoFile => ({ name, bytes: new TextEncoder().encode(text) });
const table = (name: string, fields: string[], values: (string | number)[][]) =>
  [['%T',name],['%F',...fields],...values.map(row=>['%R',...row])].map(row=>row.join('\t')).join('\n');
const shifts = [1,2,3,4,5,6,7].map(d =>
  `(0||${d}()(${d >= 2 && d <= 6 ? '(0||0(s|08:00|f|12:00)())(0||1(s|13:00|f|17:00)())' : ''}))`).join('');
const cal = `(0||CalendarData()((0||DaysOfWeek()(${shifts}))(0||VIEW(ShowTotal|Y)())(0||Exceptions()())))`;
const source: [number,string,string,string,number,number,number,number][] = [
  [101,'TT_Mile','CIV-100','Start civil works',0,1,1,0],
  [102,'TT_Task','CIV-110','Install concrete footpath',16,1,2,0],
  [103,'TT_FinMile','CIV-115','Footpath complete',0,2,2,0],
  [104,'TT_Task','CIV-120','Install guard rail',16,3,4,0],
  [105,'TT_Task','CIV-130','Final safety inspection',16,5,8,0],
  [106,'TT_FinMile','CIV-140','Practical completion',0,8,8,0],
  [107,'TT_Task','CIV-125','Plant and landscape verge',24,1,3,24],
];
const benchmark: typeof source = [
  [101,'TT_Mile','CIV-100','Start civil works',0,1,1,0],
  [102,'TT_Task','CIV-110','Install concrete footpath',32,1,4,0],
  [103,'TT_FinMile','CIV-115','Footpath complete',0,4,4,0],
  [104,'TT_Task','CIV-120','Install guard rail',32,5,10,0],
  [105,'TT_Task','CIV-130','Final safety inspection',16,11,12,0],
  [106,'TT_FinMile','CIV-140','Practical completion',0,12,12,0],
  [107,'TT_Task','CIV-125','Plant and landscape verge',24,1,3,56],
];
const stamp = (day: number, time: string) => `2027-02-${String(day).padStart(2,'0')} ${time}`;
const xer = (rows: typeof source, finish: number) => [
  'ERMHDR\t23.12\t2026-11-27\tProject\tDEMO\tDemo\tAED',
  table('PROJECT',['proj_id','proj_short_name','clndr_id','last_recalc_date','scd_end_date','critical_path_type'],
    [[1,'DEMO-CIV-101',1,stamp(1,'08:00'),stamp(finish,'17:00'),'CT_TotFloat']]),
  table('SCHEDOPTIONS',['proj_id','sched_retained_logic','sched_progress_override','sched_float_type','sched_calendar_on_relationship_lag'],
    [[1,'Y','N','FT_FF','rcal_Successor']]),
  table('CALENDAR',['clndr_id','clndr_name','day_hr_cnt','clndr_data'],[[1,'Mon–Fri · 8 hours',8,cal]]),
  table('PROJWBS',['wbs_id','parent_wbs_id','wbs_name','wbs_short_name'],[[10,'','Civil works','CIV']]),
  table('TASK',['task_id','proj_id','wbs_id','task_type','task_code','task_name','clndr_id','status_code','target_drtn_hr_cnt',
      'remain_drtn_hr_cnt','early_start_date','early_end_date','total_float_hr_cnt'],
    rows.map(([id,type,code,name,hours,start,end,float]) =>
      [id,1,10,type,code,name,1,'TK_NotStart',hours,hours,stamp(start,type==='TT_FinMile'?'17:00':'08:00'),stamp(end,type==='TT_Mile'?'08:00':'17:00'),float])),
  table('ACTVTYPE',['actv_code_type_id','actv_code_type'],[[201,'BOQ Item']]),
  table('ACTVCODE',['actv_code_id','actv_code_type_id','actv_code_name','short_name'],[[301,201,'FP-01','FP-01'],[302,201,'GR-01','GR-01']]),
  table('TASKACTV',['task_id','actv_code_id'],[[102,301],[104,302]]),
  table('TASKPRED',['task_id','pred_task_id','pred_type','lag_hr_cnt'],
    [[102,101],[103,102],[104,103],[105,104],[106,105],[107,101],[106,107]].map(([to,from])=>[to,from,'PR_FS',0])),
  '%E','',
].join('\n');

export function scheduleSample() {
  return {
    baseline: file('DEMO-CIV-101 Pre-change programme.xer', xer(source,8)),
    productivity: file('DEMO-CIV-101 Productivity assumptions.csv',
      'Item,Unit,Quantity per working day,Source\nFP-01,m2,12,Synthetic demo crew output\nGR-01,m,6,Synthetic demo crew output\n'),
    benchmark: file('DEMO-CIV-101 Independent synthetic check.xer',xer(benchmark,12)),
  };
}

export function completeCivilSample() {
  return {
    original: file("DEMO-CIV-101 Rev A.dxf", "0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n9\n$INSUNITS\n70\n6\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nTEXT\n5\nA0\n8\nTITLEBLOCK\n10\n0\n20\n12\n40\n1\n1\nDWG NO: DEMO-CIV-101 REV: A ISSUED 03/11/2026\n0\nLINE\n5\nB1\n8\nGUARD RAIL\n10\n0\n20\n0\n30\n0\n11\n50\n21\n0\n31\n0\n0\nLWPOLYLINE\n5\nC1\n8\nCONCRETE FOOTPATH\n90\n4\n70\n1\n10\n0\n20\n3\n10\n50\n20\n3\n10\n50\n20\n5\n10\n0\n20\n5\n0\nLINE\n5\nD1\n8\nCONTROL\n10\n0\n20\n-2\n30\n0\n11\n75\n21\n-2\n31\n0\n0\nLINE\n5\nD2\n8\nCONTROL\n10\n0\n20\n-3\n30\n0\n11\n75\n21\n-3\n31\n0\n0\nLINE\n5\nD3\n8\nCONTROL\n10\n0\n20\n-4\n30\n0\n11\n75\n21\n-4\n31\n0\n0\nENDSEC\n0\nEOF\n"),
    revised: file("DEMO-CIV-101 Rev B.dxf", "0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n9\n$INSUNITS\n70\n6\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nTEXT\n5\nA0\n8\nTITLEBLOCK\n10\n0\n20\n12\n40\n1\n1\nDWG NO: DEMO-CIV-101 REV: B ISSUED 09/11/2026\n0\nLINE\n5\nB1\n8\nGUARD RAIL\n10\n0\n20\n0\n30\n0\n11\n50\n21\n0\n31\n0\n0\nLWPOLYLINE\n5\nC1\n8\nCONCRETE FOOTPATH\n90\n4\n70\n1\n10\n0\n20\n3\n10\n50\n20\n3\n10\n50\n20\n5\n10\n0\n20\n5\n0\nLINE\n5\nD1\n8\nCONTROL\n10\n0\n20\n-2\n30\n0\n11\n75\n21\n-2\n31\n0\n0\nLINE\n5\nD2\n8\nCONTROL\n10\n0\n20\n-3\n30\n0\n11\n75\n21\n-3\n31\n0\n0\nLINE\n5\nD3\n8\nCONTROL\n10\n0\n20\n-4\n30\n0\n11\n75\n21\n-4\n31\n0\n0\nLINE\n5\nB2\n8\nGUARD RAIL\n10\n50\n20\n0\n30\n0\n11\n62\n21\n0\n31\n0\n0\nLWPOLYLINE\n5\nC2\n8\nCONCRETE FOOTPATH\n90\n4\n70\n1\n10\n50\n20\n3\n10\n62\n20\n3\n10\n62\n20\n5\n10\n50\n20\n5\n0\nENDSEC\n0\nEOF\n"),
    boq: file("BOQ Bill 1 - Civil Works.csv", "Item,Description,Unit,Qty,Rate,Amount\nGR-01,Guard rail,m,100,120,12000\nFP-01,Concrete footpath,m2,200,85,17000\n"),
    referenceName: 'PVR-0001 Change Instruction.txt',
    schedule: scheduleSample(),
  };
}

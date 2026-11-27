import {it,expect} from 'vitest';
import {parseXer,parseXerBytes} from './xerParser';
it('preserves unmapped attributes and nested calendar exceptions',()=>{
 const s='%T\tCALENDAR\n%F\tclndr_id\tclndr_data\n%R\t1\t(0||Exceptions()((0||0(d|45000)())(0||1(d|45001)())))\n%T\tSCHEDOPTIONS\n%F\tproj_id\tcustom_setting\n%R\t7\tretained\n';
 const m=parseXer(s);
 expect(m.calendars?.[0].exceptions).toEqual(['2023-03-15','2023-03-16']);
 expect(m.rawTables?.SCHEDOPTIONS.rows[0]).toEqual(['7','retained']);
});

const tinyXer = 'ERMHDR\t8.0\r%T\tTASK\r%F\ttask_id\ttask_code\ttask_name\r%R\t1\tA\tCafé\r%E\r';
it('decodes legacy bytes without introducing replacement characters, and reports the fallback',()=>{
 const m=parseXerBytes(Uint8Array.from([...tinyXer].map(c=>c.charCodeAt(0))));
 expect(m.activities[0].name).toBe('Café');
 expect(m.integrityProblems).toEqual([]);
 expect(m.warnings).toContainEqual(expect.stringContaining('Windows-1252'));
});
it('reads BOM-marked UTF-16BE and ordinary UTF-8 without a legacy warning',()=>{
 const unicode=Uint8Array.from([0xfe,0xff,...[...tinyXer].flatMap(c=>[0,c.charCodeAt(0)])]);
 expect(parseXerBytes(unicode).activities[0].name).toBe('Café');
 expect(parseXerBytes(new TextEncoder().encode(tinyXer)).warnings).not.toContainEqual(expect.stringContaining('Windows-1252'));
});
it('diagnoses truncated exports and duplicate internal IDs, and does not trust their relationships',()=>{
 const m=parseXer(tinyXer.replace('%E\r','%R\t1\tB\tDuplicate\r%T\tTASKPRED\r%F\ttask_id\tpred_task_id\tpred_type\tlag_hr_cnt\r%R\t1\t1\tPR_FS\t0'));
 expect(m.integrityProblems).toEqual([expect.stringContaining('end marker'),expect.stringContaining('duplicate')]);
 expect(m.relationships[0].resolved).toBe(false);
});
it('does not overwrite a previous TASK table or accept malformed rows before a header',()=>{
 const m=parseXer(tinyXer.replace('%E\r','%T\tTASK\r%R\t2\tB\tOther\r%E\r'));
 expect(m.activities.map(a=>a.id)).toEqual(['A']);
 expect(m.integrityProblems).toEqual([expect.stringContaining('Duplicate XER table'),expect.stringContaining('no valid field header')]);
});
it('keeps raw unsupported types and unknown lags out of usable logic',()=>{
 const m=parseXer(tinyXer.replace('%E\r','%R\t2\tB\tOther\r%T\tTASKPRED\r%F\ttask_id\tpred_task_id\tpred_type\tlag_hr_cnt\r%R\t2\t1\tPR_INVALID\t8\r%R\t2\t1\tPR_FS\t\r%E\r'));
 expect(m.relationships.map(r=>[r.resolved,r.rawType,r.lagHours])).toEqual([[false,'PR_INVALID',8],[false,'PR_FS',undefined]]);
});

import {it,expect} from 'vitest';
import {parseXer} from './xerParser';
it('preserves unmapped attributes and nested calendar exceptions',()=>{
 const s='%T\tCALENDAR\n%F\tclndr_id\tclndr_data\n%R\t1\t(0||Exceptions()((0||0(d|45000)())(0||1(d|45001)())))\n%T\tSCHEDOPTIONS\n%F\tproj_id\tcustom_setting\n%R\t7\tretained\n';
 const m=parseXer(s);
 expect(m.calendars?.[0].exceptions).toEqual(['2023-03-15','2023-03-16']);
 expect(m.rawTables?.SCHEDOPTIONS.rows[0]).toEqual(['7','retained']);
});

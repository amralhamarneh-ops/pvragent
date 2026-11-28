import {describe,expect,it} from 'vitest';
import {calculateScopeReadiness,type ScopeLot} from './scopeReadiness';
const week=[1,2,3,4,5,6];
const lot:ScopeLot={id:'signs',quantity:'3',leadMonths:'1',unitsPerCrewDay:'2'};
describe('source quantity readiness sensitivity',()=>{
  it('clamps calendar-month delivery, rounds crew days up, and skips nonworking weekdays',()=>{
    const t=calculateScopeReadiness('2024-01-31','2024-03-04',week,[lot])!;
    expect(t.rows).toEqual([{id:'signs',delivery:'2024-02-29',complete:'2024-03-02',fieldDays:2}]);
    expect(t.afterGateCalendarDays).toBe(-2);
  });
  it('compares the latest of separate concurrent lots with the stored gate',()=>{
    const t=calculateScopeReadiness('2024-01-31','2024-03-04',week,[lot,{...lot,id:'sensors',quantity:'5',unitsPerCrewDay:'1'}])!;
    expect(t.ready).toBe('2024-03-06');expect(t.afterGateCalendarDays).toBe(2);
  });
  it('rejects invalid dates, missing rates, fractions, duplicate lots and excessive durations',()=>{
    for(const x of [{quantity:'1.5'},{quantity:'731',unitsPerCrewDay:'1'},{unitsPerCrewDay:''},{leadMonths:''},{leadMonths:'-1'}])
      expect(calculateScopeReadiness('2024-01-31','2024-03-04',week,[{...lot,...x}])).toBeNull();
    expect(calculateScopeReadiness('2024-02-30','2024-03-04',week,[lot])).toBeNull();
    expect(calculateScopeReadiness('2024-01-31','2024-03-04',week,[lot,lot])).toBeNull();
  });
});

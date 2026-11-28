import {expect,it} from 'vitest';
import {isReferenceProgramme} from './scheduleProvenance';
it('only admits source revisions on the input side',()=>{
  for(const s of ['Before impact.xer','Pre-Impact baseline.xer','Baseline Rev-2.xer','Without impact.xer','Current update.xer'])expect(isReferenceProgramme(s,'current')).toBe(false);
  for(const s of ['PVR-18 Impact.xer','Impacted Program.xer','Pre-impact vs impacted.xer','with_impact.xer','Processed PVR.xer','postimpact.xer'])expect(isReferenceProgramme(s,'current')).toBe(true);
  expect(isReferenceProgramme('schedule.xer','reference')).toBe(true);
});

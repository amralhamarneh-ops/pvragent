/** Source-quantity sensitivity, not CPM and not a contractual/proven time impact. */
export interface ScopeLot {
  id: string;
  quantity: string;
  leadMonths: string;
  unitsPerCrewDay: string;
}
const DAY_MS=86_400_000;
const iso=(v:string)=>/^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10)===v;
const positiveInteger=(s:string)=>/^[1-9]\d*$/.test(s) && Number.isSafeInteger(Number(s));
const months=(s:string)=>/^(?:0|[1-9]\d*)$/.test(s) && Number(s)<=36;
const date=(d:Date)=>d.toISOString().slice(0,10);

function addMonths(src:Date,n:number) {
  const dest=new Date(src);
  dest.setUTCDate(1);
  dest.setUTCMonth(src.getUTCMonth()+n);
  const last=new Date(dest);last.setUTCMonth(last.getUTCMonth()+1);last.setUTCDate(0);
  dest.setUTCDate(Math.min(src.getUTCDate(),last.getUTCDate()));
  return dest;
}

export function calculateScopeReadiness(instruction:string,storedGateStart:string,workingDays:readonly number[],lots:readonly ScopeLot[]) {
  if (!iso(instruction)||!iso(storedGateStart)||instruction<'1900-01-01'||instruction>'2100-01-01'||
      !lots.length||lots.length>50||new Set(lots.map(l=>l.id)).size!==lots.length||
      !workingDays.length||new Set(workingDays).size!==workingDays.length||workingDays.some(x=>!Number.isInteger(x)||x<0||x>6)) return null;
  const chosen=new Set(workingDays);
  const rows=[];
  for (const l of lots) {
    if (!positiveInteger(l.quantity)||!positiveInteger(l.unitsPerCrewDay)||!months(l.leadMonths)) return null;
    const fieldDays=Math.ceil(Number(l.quantity)/Number(l.unitsPerCrewDay));
    if (fieldDays>730) return null;
    const delivery=addMonths(new Date(instruction),Number(l.leadMonths));
    const complete=new Date(delivery);
    for(let n=fieldDays;n>0;) {
      complete.setUTCDate(complete.getUTCDate()+1);
      if(chosen.has(complete.getUTCDay())) n--;
    }
    rows.push({id:l.id,delivery:date(delivery),complete:date(complete),fieldDays});
  }
  const ready=rows.map(l=>l.complete).sort().at(-1)!;
  const afterGateCalendarDays=Math.round((Date.parse(ready)-Date.parse(storedGateStart))/DAY_MS);
  return {rows,ready,afterGateCalendarDays};
}

export type GanttDates = {start:string;finish:string;floatHours?:number|null;critical?:boolean};
export type GanttRow = {code:string;name:string;milestone?:boolean;before?:GanttDates;after?:GanttDates};
export const finiteDate = (s?:string) => {
  if (!s || !/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/.test(s.trim())) return null;
  const t=Date.parse(s.trim().replace(' ','T')+(s.trim().length===10?'T00:00:00Z':'Z'));
  return Number.isFinite(t)?t:null;
};
export const validDates = (d?:GanttDates): d is GanttDates => {
  const a=finiteDate(d?.start),b=finiteDate(d?.finish);return !!d && a!==null && b!==null && a<=b;
};
const dayMs=86400000;
export function makeGanttLayout(input:GanttRow[],limit=14) {
  const rows=input.flatMap(row=>{
    const before=validDates(row.before)?row.before:undefined,after=validDates(row.after)?row.after:undefined;
    return before||after?[{...row,before,after}]:[];
  });
  const displayed=rows.slice(0,limit);
  const all=displayed.flatMap(r=>[r.before,r.after]).filter(validDates);
  if(!all.length)return {rows:displayed,total:0,ticks:[],position:() => 0};
  const min=Math.floor(Math.min(...all.map(r=>finiteDate(r.start)!))/dayMs)*dayMs;
  const max=Math.max(min+dayMs,Math.ceil(Math.max(...all.map(r=>finiteDate(r.finish)!))/dayMs)*dayMs);
  const tickCount=Math.min(5,Math.max(2,(max-min)/dayMs+1));
  return {rows:displayed,total:rows.length,ticks:Array.from({length:tickCount},(_,i)=>new Date(min+(max-min)*i/(tickCount-1)).toISOString().slice(0,10)),
    position:(s:string)=>{const t=finiteDate(s);return t===null?0:Math.max(0,Math.min(100,(t-min)/(max-min)*100));}};
}

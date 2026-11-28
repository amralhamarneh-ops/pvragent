import { D } from './decimal';
import { validateDecimalText } from '../boq/calc';

export const MAX_SCENARIO_HOURS = 8760;
export const MAX_SCENARIO_ACTIVITIES = 30;
export type ProgrammeScopeLine = {
  id:string; name:string; quantity:string|null; unit:string; drawingSource:string;
  boqSource:string; activityCodes:string[]; split?:Record<string,string>; newCode?:string; blocker?:string;
};
export type ScopeDecision = {treatment:'include'|'exclude'; rate:string; basis:string; predecessor?:string; successor?:string};
export type ProgrammeAnchor = {from:string;to:string};
export type ReviewedFragment = {code:string;from:string;to:string;hours:number};
export const anchorKey=({from,to}:ProgrammeAnchor)=>JSON.stringify([from,to]);
export type ReviewedChange = {code:string; hours:number};
const decimal = (value:string) => {
  const text=value.trim().replace(/,/g,'').replace(/^\+?\./,'0.');
  return text.length<=40 && validateDecimalText(text) ? D(text).raw : BigInt(0);
};
export function scopeHours(line:ProgrammeScopeLine, decision?:ScopeDecision,anchors:ReadonlySet<string>=new Set()):{error:string}|{excluded:true}|{entries:{minutes:number;code:string;quantity:string}[];anchor?:ProgrammeAnchor} {
  if(!decision) return {error:'Review this line.'} as const;
  if(decision.basis.trim().length<3 || decision.basis.length>300) return {error:'Record the productivity source or reason for exclusion.'} as const;
  if(decision.treatment==='exclude')return {excluded:true} as const;
  if(line.blocker)return {error:line.blocker} as const;
  if(!line.quantity || decimal(line.quantity)<=BigInt(0) || !line.unit || !line.drawingSource) return {error:'Verified, positive drawing quantity is required.'} as const;
  const anchor = line.newCode ? {from:decision.predecessor??'',to:decision.successor??''} : undefined;
  if(anchor && !anchors.has(anchorKey(anchor)))return {error:'Select a valid original finish-to-start link for the proposed activity.'};
  if(!anchor && !line.activityCodes.length)return {error:'Confirm an eligible execution activity for this line.'} as const;
  const hundred=decimal('100'), codes=anchor?[line.newCode!]:line.activityCodes;
  const shares=codes.length===1?[hundred]:codes.map(code=>decimal(line.split?.[code]??''));
  if(new Set(codes).size!==codes.length || shares.some(x=>x<=BigInt(0)) || shares.reduce((a,b)=>a+b,BigInt(0))!==hundred)
    return {error:'Review the allocation percentages. Positive shares must total exactly 100%.'};
  const rate=decimal(decision.rate);
  if(rate<=BigInt(0))return {error:'Enter positive productivity in the stated unit per working hour.'} as const;
  // Round up to a whole minute so a positive physical change cannot disappear in the scheduler.
  const measured=decimal(line.quantity), denominator=rate*hundred;
  const entries=codes.map((code,i)=>{
    const share=shares[i], numerator=measured*share*BigInt(60);
    const minutes=Number((numerator+denominator-BigInt(1))/denominator);
    const quantity=D(line.quantity!.replace(/^\+?\./,'0.')).mul(D((share===hundred?'100':line.split?.[code]??'0').replace(/^\+?\./,'0.'))).div('100').toString();
    return {code,minutes,quantity};
  });
  if(entries.some(e=>!Number.isSafeInteger(e.minutes)||e.minutes>MAX_SCENARIO_HOURS*60))return {error:'Calculated duration exceeds the supported range.'} as const;
  return {entries,anchor} as const;
}
export function reviewProgrammeScope(lines:ProgrammeScopeLine[],decisions:Record<string,ScopeDecision>,anchors:ReadonlySet<string>=new Set()) {
  const sum=new Map<string,number>(), fragments:ReviewedFragment[]=[], usedAnchors=new Set<string>(); let exclusions=0,duplicateAnchor=false;
  const review=lines.map(line=>({line,result:scopeHours(line,Object.hasOwn(decisions,line.id)?decisions[line.id]:undefined,anchors)}));
  for(const {result} of review) {
    if('entries' in result) {
      if(result.anchor) {
        const key=anchorKey(result.anchor);
        if(usedAnchors.has(key))duplicateAnchor=true;
        const [entry]=result.entries;
        usedAnchors.add(key);fragments.push({code:entry.code,...result.anchor,hours:entry.minutes/60});
      } else for(const e of result.entries)sum.set(e.code,(sum.get(e.code)??0)+e.minutes);
    }
    if('excluded' in result)exclusions++;
  }
  const invalid=review.filter(x=>'error' in x.result).length;
  const error=invalid?'Review every identified scope line before running this scenario.':
    duplicateAnchor?'Two new activities use the same anchors. Review their sequence; the tool will not assume parallel work.':
    !(sum.size+fragments.length)?'Include at least one verified measured change.':
    sum.size+fragments.length>MAX_SCENARIO_ACTIVITIES?'This scenario exceeds 30 changed activities.':
    [...sum.values()].some(m=>m>MAX_SCENARIO_HOURS*60)?'Combined hours exceed the limit for one activity.':'';
  return {review,exclusions,error,fragments:error?[]:fragments,changes:error?[]:[...sum].map(([code,m])=>({code,hours:m/60})).sort((a,b)=>a.code<b.code?-1:a.code>b.code?1:0)};
}

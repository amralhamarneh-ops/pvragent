import fs from 'node:fs';
import {parseXer} from '../src/lib/mapping/xerParser';
import {retrieveCandidates} from '../src/lib/boq/retrieve';
import {buildRowContext} from '../src/lib/boq/context';
import {retrieveActivities} from '../src/lib/mapping/realActivityMapping';
const root=process.argv[2],out=process.argv[3];
const rows=JSON.parse(fs.readFileSync(out+'/boq.json','utf8')).result.rows;
const ctx=buildRowContext(rows);
const items=rows.filter((r: any)=>r.included).map((r: any)=>({...r,importId:'benchmark',caseId:'benchmark',sourceFile:'P340 BOQ',sourceSha256:'',currency:'AED'}));
const model=parseXer(fs.readFileSync(root+'/Programs/Updated Program cut-off 18.07.2026.xer','utf8'));
const claims=JSON.parse(fs.readFileSync(out+'/pvr-lines.json','utf8'));
const results=claims.map((c: any)=>{
 const comp={name:c.description,discipline:'ITS',workType:'',material:'',specification:c.description,location:'',searchTerms:[],expectedUnit:c.unit};
 const boq=retrieveCandidates(items,ctx,comp,3).map(x=>({sheet:x.item.sheet,row:x.item.rowNumber,description:x.item.description,unit:x.item.unit,rate:x.item.rate.value,score:x.score,unitCompat:x.unitCompat,specConflict:x.specConflict,rateMatchesClaim:Number(x.item.rate.value)===Number(c.rate)}));
 const acts=retrieveActivities({lineId:c.ref,componentId:c.ref,name:c.description,description:c.description,specification:'',location:'',discipline:'ITS',workType:'',searchTerms:[],quantity:c.quantity,unit:c.unit,action:'add',executes:true},model,{limit:3});
 return {...c,drawingQuantity:null,drawingStatus:'not independently verified',boqCandidates:boq,activityCandidates:acts.candidates.map(x=>({code:x.activity.code,name:x.activity.name,wbs:x.activity.wbsPath,score:x.score,eligible:x.eligible,cautions:x.cautions}))};
});
fs.writeFileSync(out+'/mapping-comparison.json',JSON.stringify(results,null,2));
console.log(JSON.stringify({lines:results.length,topRateAgrees:results.filter((x: any)=>x.boqCandidates[0]?.rateMatchesClaim).length,calendarExceptions:model.calendars?.map(c=>c.exceptions.length),rawTables:Object.keys(model.rawTables||{})}));

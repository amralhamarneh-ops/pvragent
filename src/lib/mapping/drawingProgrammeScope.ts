import { buildSharedLinesDetailed } from './sharedLines';
import { withDrawingQuantities } from '../boq/drawingQuantities';
import type { ChangeScope, ScopeComponent } from '../boq/scope';
import type { ChangeHandoff } from '../drawings/handoff';

/** Schedule review can start from intake; no BOQ is needed to know that an item takes time. */
export function drawingProgrammeScope(handoff:ChangeHandoff|null, currency:string, verificationManifest=handoff?.documents??[]) {
  const empty:ChangeScope={components:[],summary:'',location:'',packageName:'',contradictions:[],missingInformation:[],limitations:[]};
  const scope=withDrawingQuantities(empty,handoff,verificationManifest);
  const pending:ScopeComponent[]=[];
  for(const c of handoff?.changes??[]) {
    const measured=scope.components.some(m=>['add','omit','rework'].some(action=>m.id.endsWith(`:${c.id}:${action}`)));
    if(measured)continue;
    pending.push({id:`pending-drawing:${c.id}`,name:c.component,action:c.change==='removed'?'omit':c.change==='modified'?'rework':'add',
      discipline:'',workType:'',material:'',specification:'',location:c.location,searchTerms:[c.component,c.description].filter(Boolean),
      expectedUnit:c.unit,quantity:null,missingInputs:['Verified drawing takeoff'],potential:false,potentialReason:'',evidence:[]});
  }
  const components=[...scope.components,...pending];
  const lines=buildSharedLinesDetailed({...scope,components},null,[],currency).lines.map(l=>pending.some(x=>x.id===l.componentId)
    ? {...l,work:{...l.work,executes:true}} : l);
  return {components,lines};
}

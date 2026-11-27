import { D } from '../assessment/decimal';
import { sameUnit, validateDecimalText } from '../boq/calc';
import { totalsFor, type TotalsLine } from '../boq/valuation';

export const REASONS = ['Project Owner Preferences','Design Changes','Site Conditions','Authority Requirements','Additional Scope','Other'] as const;
export const DETAILS = [
  ['project','Project Name'],['contractor','Contractor Name'],['contract','Contract Number'],['number','PVR Number'],
  ['title','PVR Title'],['description','PVR Description'],['reasoning','PVR Reasoning'],['projectCode','Project Code'],['costCode','Cost Code'],
  ['otherReason','Other – please specify'],['initiator','Change Initiated / Requested by'],['basis','Basis of PVR Value'],
  ['revisedContract','Revised Contract Value (including all approved VOs)'],['cumulativeVo','Cumulative VOs per Original Contract Value %'],
  ['totalPvr','Total PVRs (approved including this one)'],['cumulativePvr','Cumulative PVRs and VOs per Original Contract Value %'],
  ['negativePvr','Total Negative PVRs (approved including this one)'],['positivePvr','Total Positive PVRs (approved including this one)'],
  ['budget','Value of approved PVRs including this one'],['recommendation','Recommendation'],['clientCommitment','Client Commitment Date'],
] as const;
export type FormDetails = Partial<Record<typeof DETAILS[number][0],string>> & {reasons?: string[]};
export interface TakeoffReference {value:string; unit:string; citation:string}
export interface FormLine extends TotalsLine {
  description:string;
  quantity:string|null;
  quantityUnit:string;
  drawingSource:string;
  rate:string|null;
  rateUnit:string;
  rateSource:string;
  rateFallback:boolean;
  mappedActivity?:string;
}
export interface ProgrammeWhatIf {before:string; after:string; calendarDays:number; input:string; activity:string}
export interface FormInput {
  details:FormDetails; lines:FormLine[]; references?:Record<string,TakeoffReference>;
  reportReady:boolean; whatIf?:ProgrammeWhatIf|null; blockers?:string[];
}
export function compareTakeoff(line:Pick<FormLine,'quantity'|'quantityUnit'|'drawingSource'>, ref?:TakeoffReference) {
  if (!ref?.citation.trim() || !validateDecimalText(ref.value) || !line.drawingSource || !line.quantity || !validateDecimalText(line.quantity) ||
      !line.quantityUnit || !ref.unit || !sameUnit(line.quantityUnit,ref.unit)) return null;
  return D(line.quantity.replace(/,/g,'').trim()).sub(D(ref.value.replace(/,/g,'').trim())).toString();
}
const e = (v:unknown) => String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]??c));
const display = (v:unknown) => e(v || '—');
const money = (v:string, c:string) => {
  const n=Number(v);
  return e(c+' '+(Number.isFinite(n)?n.toLocaleString('en-AE',{minimumFractionDigits:2,maximumFractionDigits:2}):v));
};
const check = (on:boolean) => on ? '☒' : '☐';
const section = (text:string) => '<h2>'+text+'</h2>';
const primary = (label:string,value:unknown) => '<tr><th>'+e(label)+'</th><td>'+display(value)+'</td></tr>';

export function renderPvrForm(input:FormInput):string {
  const {details:d,reportReady,whatIf}=input;
  // Defence in depth: the report never values a line that has not come through a cited drawing takeoff.
  const lines=input.lines.map<FormLine>(l=>l.disposition==='priced' && (!l.drawingSource || !l.quantity || !validateDecimalText(l.quantity))
    ? {...l,disposition:'unpriced',signedAmount:null} : l);
  const totals=totalsFor(lines);
  const total=totals.perCurrency[0];
  const pendingCost=!reportReady || totals.mixedCurrency || !total?.complete;
  const pricing=totals.perCurrency.filter(t=>t.pricedSubtotal!==null).map(t=>money(t.pricedSubtotal!,t.currency)).join(' / ');
  const cost=pendingCost ? 'Pending verification'+(pricing?' (priced subtotal only: '+pricing+')':'') : pricing;
  // The current scenario tool accepts manually entered working days. It has no full-scope result suitable for official reporting.
  const timeText='Pending independent programme assessment';
  const commitment = /^\d{4}-\d{2}-\d{2}$/.test(d.clientCommitment??'') ? d.clientCommitment : null;
  const timeChoice = ['No Time Impact','Within Client Commitment Date','Delay to Client Commitment Date'].map(label => check(false)+' '+label).join('　　');
  const fallbackCount=lines.filter(l=>l.disposition==='priced'&&l.rateFallback).length;
  const details=DETAILS.slice(0,6).map(([k,label])=>primary(label,d[k])).join('');
  const budget = [DETAILS.slice(12,15),DETAILS.slice(15,18)].map(row=>'<tr>'+row.map(([k,label])=>'<th>'+e(label)+'</th><td>'+display(d[k])+'</td>').join('')+'</tr>').join('');
  const refs=input.references??{};
  const approvalRows=[
    ['Validator','Scope, Contract Check, Quantities, Cost & Time Impact','Sr. Vice President – Project Management'],
    ['Validator','Budget & Schedule','Senior Vice President – Development Project Scheduling'],
    ['Validator','Budget & Schedule','Project Controls'],
    ['Endorsement','Scope, Contract Check, Quantities, Cost & Time Impact','Executive Director – Project Management'],
    ['Endorsement','Contracts Management','Director – Contracts Management'],
    ['Endorsement','Budget & Schedule','Executive Director – Project Controls and Operations'],
    ['Approval','Approver','Executive Director – Project Procurement'],
    ['Approval','Approver','Chief Delivery Officer'],
  ].map(([step,role,title])=>'<tr><td>'+step+'</td><td>'+role+'</td><td>'+title+'</td><td></td><td></td></tr>').join('');
  const disposition:Record<FormLine['disposition'],string>={priced:'Priced',unpriced:'Not priced',excluded:'Excluded',deferred:'Deferred',held_overlap:'Held: overlap'};
  const audit=lines.map(l=>{
    const ref=refs[l.lineId], delta=compareTakeoff(l,ref);
    const qe=l.drawingSource && l.quantity ? e(l.quantity)+' '+e(l.quantityUnit)+'<small>'+e(l.drawingSource)+'</small>' : 'Not verified from drawings';
    const rate = l.rate ? money(l.rate,l.currency)+' / '+e(l.rateUnit)+'<small>'+e(l.rateSource)+'</small>' : display(l.rateSource);
    return '<tr><td>'+e(l.description)+'<small>'+e(l.mappedActivity??'')+'</small></td><td>'+qe+'</td><td>'+rate+'</td><td>'+
      (l.disposition==='priced' && l.signedAmount!==null?money(l.signedAmount,l.currency):disposition[l.disposition])+'</td><td>'+
      (ref?.citation.trim() && validateDecimalText(ref.value) ? e(ref.value)+' '+e(ref.unit)+'<small>'+e(ref.citation)+'</small>'+(delta!==null?'<small>Drawings less reference: '+e(delta)+' '+e(l.quantityUnit)+'</small>':'<small>Not comparable</small>') : '—')+'</td></tr>';
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Potential Variation Request</title>
<style>
@page{size:A4;margin:11mm}*{box-sizing:border-box}body{font:10px/1.24 Arial,sans-serif;color:#161616;margin:0 auto;max-width:190mm}h1{text-align:center;font-size:15px;margin:4mm 0 1mm}h2{font-size:10px;text-align:center;background:#191919;color:#fff;margin:2.1mm 0 0;padding:2.5px;print-color-adjust:exact;-webkit-print-color-adjust:exact}p{margin:3px 0}.notice{text-align:center;font-weight:bold;font-size:9px;margin-bottom:2mm}.annex{break-before:page;page-break-before:always}.reason{display:grid;grid-template-columns:1fr 1fr;gap:2px 12px;padding:4px;border:1px solid #333}.remarks{white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #333;text-align:left;padding:3px 4px;vertical-align:top;overflow-wrap:anywhere;white-space:pre-wrap}th{font-weight:600;background:#f0f0f0;print-color-adjust:exact;-webkit-print-color-adjust:exact}.identity th{width:27%}.grid th{width:19%}.grid td{width:14.33%}.approval td{height:23px}.section-heading{margin-top:3px;font-weight:bold}.annex thead{display:table-header-group}.annex tr{break-inside:avoid}small{display:block;margin-top:3px;color:#474747}.classification{text-align:right;font-size:8px;margin-top:2mm}@media screen{body{padding:10px}.annex{margin-top:22px}}@media print{h2{break-after:avoid}}
</style></head><body>
<h1>POTENTIAL VARIATION REQUEST</h1><p class="notice">DRAFT – ASSESSMENT INCOMPLETE</p>
${section('PVR DETAILS')}
<table class="identity">${details}<tr><th>PVR Reasoning</th><td><p class="section-heading">Justification of Proposed Variation</p><p>${display(d.reasoning)}</p><p class="section-heading">Estimated Time Impact of Proposed Variation</p><p>${timeText}</p><p class="section-heading">Estimated Cost Impact of Proposed Variation</p><p>${cost}${fallbackCount?' · '+fallbackCount+' line(s) use cited processed-PVR rates because usable BOQ rates were unavailable. See Annex.':''}</p></td></tr></table>
${section('CHANGE REASON')}<div class="reason">${REASONS.map(r=>'<div>'+check(d.reasons?.includes(r)??false)+' '+e(r)+(r==='Other' && d.otherReason?' – '+e(d.otherReason):'')+'</div>').join('')}</div>
<table class="grid"><tr><th>Change Initiated / Requested by</th><td colspan="5">${['Project Owner/Development','Consultant','Contractor'].map(x=>check(d.initiator===x)+' '+x).join('　　')}</td></tr><tr><th>Estimated Cost Impact</th><td>${cost}</td><th>Project Code</th><td>${display(d.projectCode)}</td><th>Cost Code</th><td>${display(d.costCode)}</td></tr>
<tr><th>Basis of PVR Value</th><td colspan="5">${['Rough order of Magnitude','Detailed Proposal','Other'].map(x=>check(d.basis===x)+' '+x).join('　　')}</td></tr>
${budget}<tr><th>Value of approved PVRs including this one</th><td colspan="5">${display(d.budget)}</td></tr><tr><th>Estimated Time Impact</th><td colspan="5">${timeText}<small>${timeChoice}</small><small>Client commitment date: ${commitment ? e(commitment) : 'not supplied'}</small></td></tr></table>
${section('RECOMMENDATIONS')}<table><tr><td>${check(d.recommendation==='Sign VO before proceeding with work')} Sign VO before proceeding with work</td><td>${check(d.recommendation==="Proceed with Engineer's Instruction")} Proceed with Engineer’s Instruction</td></tr></table>
${section('APPROVALS')}<table class="approval"><thead><tr><th style="width:13%">Stage</th><th style="width:22%">Role</th><th style="width:33%">Title</th><th style="width:15%">Name</th><th style="width:17%">Signature &amp; Date</th></tr></thead><tbody>${approvalRows}</tbody><tfoot><tr><th colspan="3">Received by Procurement Dept.</th><td></td><td></td></tr></tfoot></table>
<p class="classification">Internal working document. No approval or signature is implied.</p>
<div class="annex">${section('ANNEX — QUANTITY, COST AND PROGRAMME AUDIT')}
<p>Quantity source: drawings only. Reference quantities are for comparison only and do not contribute to cost or programme calculations.</p>
<p>Contract BOQ rates take precedence. Cited processed-PVR rates are disclosed per line; they are not approved rates.</p>
${input.blockers?.length?'<ul>'+input.blockers.map(b=>'<li>'+e(b)+'</li>').join('')+'</ul>':''}
${whatIf?'<p><strong>What-if scenario only (not PVR time impact):</strong> '+e(whatIf.input)+' · '+e(whatIf.activity)+' · '+e(whatIf.before)+' → '+e(whatIf.after)+' ('+e(whatIf.calendarDays)+' calendar days difference). Duration input was entered manually; the variation impact has not been verified.</p>':''}
<table><thead><tr><th>Scope / Activity</th><th>Drawing Takeoff</th><th>Unit Rate and Source</th><th>Cost Impact</th><th>Processed Quantity (Comparison Only)</th></tr></thead><tbody>${audit || '<tr><td colspan="5">No valuation lines available.</td></tr>'}</tbody></table>
</div></body></html>`;
}

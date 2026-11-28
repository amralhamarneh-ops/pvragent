import { describe,expect,it } from 'vitest';
import { compareTakeoff,renderPvrForm,type FormInput,type FormLine } from './finalForm';

const line:FormLine={lineId:'line-1',description:'Install sample barrier',disposition:'priced',signedAmount:'325',currency:'AED',
  quantity:'10',quantityUnit:'m',drawingSource:'Sheet 05 Rev C · entities A–E · 10 m',rate:'32.5',rateUnit:'m',
  rateSource:'Processed PVR rate (BOQ unavailable): ref.pdf p.1 row 2',rateFallback:true,mappedActivity:'TEST-100'};
const base:FormInput={details:{project:'Example Works',number:'PVR-002',title:'Barrier Change',contract:'C-1'},lines:[line],reportReady:true,
  whatIf:{before:'2026-01-01',after:'2026-01-04',calendarDays:3,input:'Baseline.xer',activity:'TEST-100'}};
describe('final PVR form and distinct benchmark data',()=>{
  it('uses the exact active valuation and discloses rate fallback and source inline',()=>{
    const html=renderPvrForm({...base,references:{'line-1':{value:'1,000',unit:'m',citation:'Manual benchmark p.2'}}});
    expect(html).toContain('AED 325.00');expect(html).not.toContain('AED 32,500.00');
    expect(html).toContain('1 line(s) use cited processed-PVR rates');
    expect(html).toContain('Processed PVR rate (BOQ unavailable): ref.pdf p.1 row 2');
    expect(html).toContain('Drawings less reference: -990 m');
    expect(html).toContain('DRAFT – ASSESSMENT INCOMPLETE');
  });
  it.each([0,3])('keeps an arbitrary %i-day scenario for a drawing-measured, priced and mapped line out of formal time impact', calendarDays=>{
    const html=renderPvrForm({...base,details:{...base.details,clientCommitment:'2026-01-02'},
      whatIf:{...base.whatIf!,calendarDays}});
    const [form,annex]=html.split('<div class="annex">');
    expect(form).toContain('Pending independent programme assessment');
    expect(form).toContain('DRAFT – ASSESSMENT INCOMPLETE');
    for (const option of ['No Time Impact','Within Client Commitment Date','Delay to Client Commitment Date']) {
      expect(form).toContain('☐ '+option);expect(form).not.toContain('☒ '+option);
    }
    expect(form).not.toContain('ASSESSMENT COMPLETE');
    expect(form).not.toContain('2026-01-04');
    expect(annex).toContain('What-if scenario only (not PVR time impact)');
    expect(annex).toContain(calendarDays+' calendar days difference');
  });
  it('does not price a narrative or benchmark number when drawing evidence is missing',()=>{
    const html=renderPvrForm({...base,whatIf:null,lines:[{...line,quantity:'50',drawingSource:''}],
      references:{'line-1':{value:'50',unit:'m',citation:'Manual benchmark p.2'}}});
    expect(html).not.toContain('AED 325.00');expect(html).toContain('DRAFT');
    expect(html).toContain('Not verified from drawings');expect(html).toContain('Pending independent programme assessment');
    expect(html).not.toContain('AED 0.00');expect(html).toContain('Not comparable');
  });
  it('does not show stale amounts or time as a finished PVR and escapes editable fields',()=>{
    const html=renderPvrForm({...base,details:{project:'<script>alert(2)</script>'},reportReady:false});
    expect(html).toContain('Pending verification (priced subtotal only: AED 325.00)');
    expect(html).toContain('Pending independent programme assessment');
    expect(html).not.toContain('<script>');expect(html).toContain('&lt;script&gt;');
  });
  it('prints scope exclusions and missing drawing references without adding an amount or delay',()=>{
    const html=renderPvrForm({...base,details:{...base.details,scopeExclusions:'Spare duct excluded because the issued alignment is missing. <test>'},
      drawingNotes:['Issued plot p.4 refers to an unavailable CAD sheet.','Issued plot p.4 refers to an unavailable CAD sheet.']});
    expect(html).toContain('AED 325.00 (excludes the scope noted below)');
    expect(html).toContain('Scope excluded from this assessment');
    expect(html).toContain('Spare duct excluded because the issued alignment is missing. &lt;test&gt;');
    expect(html.match(/Issued plot p.4 refers/g)).toHaveLength(1);
    expect(html).toContain('Pending independent programme assessment');
  });
  it('only calculates a delta for equivalent explicit units and with independent citation',()=>{
    expect(compareTakeoff(line,{value:'10',unit:'m2',citation:'p.1'})).toBeNull();
    expect(compareTakeoff(line,{value:'10',unit:'m',citation:''})).toBeNull();
    expect(compareTakeoff(line,{value:'8.75',unit:'m',citation:'p.1'})).toBe('1.25');
  });
});

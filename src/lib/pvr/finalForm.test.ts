import { describe,expect,it } from 'vitest';
import { compareTakeoff,renderPvrForm,type FormInput,type FormLine } from './finalForm';

const line:FormLine={lineId:'line-1',description:'Install sample barrier',disposition:'priced',signedAmount:'325',currency:'AED',
  quantity:'10',quantityUnit:'m',drawingSource:'Sheet 05 Rev C · entities A–E · 10 m',rate:'32.5',rateUnit:'m',
  rateSource:'Processed PVR rate (BOQ unavailable): ref.pdf p.1 row 2',rateFallback:true,mappedActivity:'TEST-100'};
const base:FormInput={details:{project:'Example Works',number:'PVR-002',title:'Barrier Change',contract:'C-1'},lines:[line],reportReady:true,
  time:{before:'2026-01-01',after:'2026-01-04',calendarDays:3,input:'Baseline.xer',activity:'TEST-100'}};
describe('final PVR form and distinct benchmark data',()=>{
  it('uses the exact active valuation and discloses rate fallback and source inline',()=>{
    const html=renderPvrForm({...base,references:{'line-1':{value:'1,000',unit:'m',citation:'Manual benchmark p.2'}}});
    expect(html).toContain('AED 325.00');expect(html).not.toContain('AED 32,500.00');
    expect(html).toContain('1 line(s) use cited processed-PVR rates');
    expect(html).toContain('Processed PVR rate (BOQ unavailable): ref.pdf p.1 row 2');
    expect(html).toContain('Drawings less reference: -990 m');
    expect(html).toContain('3 calendar days in the calculated scenario');
    expect(html).toContain('FOR REVIEW / UNSIGNED');
  });
  it('does not price a narrative or benchmark number when drawing evidence is missing',()=>{
    const html=renderPvrForm({...base,time:null,lines:[{...line,quantity:'50',drawingSource:''}],
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
  it('only calculates a delta for equivalent explicit units and with independent citation',()=>{
    expect(compareTakeoff(line,{value:'10',unit:'m2',citation:'p.1'})).toBeNull();
    expect(compareTakeoff(line,{value:'10',unit:'m',citation:''})).toBeNull();
    expect(compareTakeoff(line,{value:'8.75',unit:'m',citation:'p.1'})).toBe('1.25');
  });
});

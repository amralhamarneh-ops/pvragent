import { readFile } from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it, vi } from 'vitest';
import { extractPdf, ocrLanguageOptions } from './extractServer';

function mixedPdf() {
  const cnv=createCanvas(960,600);
  const ctx=cnv.getContext('2d');
  ctx.fillStyle='white';ctx.fillRect(0,0,960,600);
  ctx.fillStyle='black';ctx.font='bold 54px sans-serif';
  ctx.fillText('IRRIGATION PIPE DRAWING',60,160);
  ctx.fillText('PROPOSED RELOCATION',60,265);
  const jpg=cnv.toBuffer('image/jpeg');
  const ops='q 560 0 0 350 20 45 cm /Im0 Do Q BT /F1 14 Tf 20 420 Td (Digital archive watermark for review) Tj ET';
  const objs=[
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 460] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Im0 6 0 R >> >> >>'),
    Buffer.from(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 960 /Height 600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`),jpg,Buffer.from('\nendstream')]),
  ];
  const chunks=[Buffer.from('%PDF-1.4\n')];let offset=chunks[0].length;
  const offsets=objs.map((b,i)=>{const obj=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),b,Buffer.from('\nendobj\n')]);chunks.push(obj);const p=offset;offset+=obj.length;return p;});
  chunks.push(Buffer.from(`xref\n0 ${objs.length+1}\n0000000000 65535 f \n${offsets.map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`));
  return Buffer.concat(chunks);
}
describe('offline evidence OCR',()=>{
  it('uses the bundled raw English model rather than requesting a compressed download', async()=>{
    const options=ocrLanguageOptions({NODE_ENV:"test"});
    expect(options).toMatchObject({gzip:false,cacheMethod:'none'});
    expect((await readFile(options.langPath+'/eng.traineddata')).length).toBeGreaterThan(100_000);
  });
  it('recovers raster content behind a short native watermark without treating OCR as geometry',async()=>{
    const bytes=mixedPdf();
    const d=await extractPdf('drawing.pdf',bytes);
    expect(d.method).toBe('ocr');
    expect(d.truncated).toBe(false);
    expect(d.pages[0].text).toMatch(/IRRIGATION PIPE DRAWING/i);
    expect(d.pages[0].text).toMatch(/Digital archive watermark/i);
    expect(d.limitation).toContain('not used for geometric measurement');
  },25000);
  it('preserves native text and reports the scan as partial when the rasterizer is unavailable',async()=>{
    vi.stubEnv('PDF_RASTERIZER_PATH','/missing/pdftoppm');
    try {
      const d=await extractPdf('drawing.pdf',mixedPdf());
      expect(d.truncated).toBe(true);
      expect(d.pages[0].text).toMatch(/Digital archive watermark/i);
      expect(d.pages[0].text).not.toMatch(/PROPOSED RELOCATION/i);
      expect(d.limitation).toMatch(/Poppler is not installed/);
    } finally { vi.unstubAllEnvs(); }
  },15000);
});

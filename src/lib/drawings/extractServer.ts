/**
 * Server-side document text extraction. Runs in Node (route handlers / tests), never in the browser.
 *  - PDF: text layer per page via pdfjs-dist. Pages with no text layer are flagged as scanned and OCR'd when a
 *         rasteriser is available (pdftoppm/Poppler), otherwise reported explicitly as not read.
 *  - DOCX: raw text via mammoth. Sections are paragraph groups, NOT physical pages.
 *  - Images: OCR via tesseract.js (uses the bundled English language model or an explicitly configured source).
 * Every result keeps page numbers, and every limit (page cap, size cap) is reported, never silently applied.
 * `coverage` states exactly how many units were read, OCR'd, skipped or failed.
 */
import { runFile } from '../server/execFile';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ExtractedDocument } from './types';

export const MAX_PDF_PAGES = 400;
export const MAX_OCR_PAGES = 25;
export const MAX_BYTES = 40 * 1024 * 1024;
const MAX_OCR_PIXELS = 6_000_000;
const MIN_TEXT_CHARS_PER_PAGE = 25;
export function ocrLanguageOptions(env = process.env) {
  const langPath = env.OCR_LANG_PATH?.trim() || resolve(process.cwd());
  const remote = /^https?:\/\//i.test(langPath);
  const raw = !remote && existsSync(join(langPath, 'eng.traineddata'));
  if (!remote && !raw && !existsSync(join(langPath, 'eng.traineddata.gz'))) {
    throw new Error('English OCR data were not packaged. Set OCR_LANG_PATH to a directory with eng.traineddata or eng.traineddata.gz.');
  }
  return { langPath, gzip: !raw, cacheMethod: 'none' as const };
}


const extOf = (n: string) => (n.match(/\.([a-z0-9]+)$/i) ?? [])[1]?.toLowerCase() ?? '';
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp'];

type OnPage = (info: { page: number; total: number; chars: number; method: string }) => void;

const poppler = (env = process.env) => env.PDF_RASTERIZER_PATH?.trim() || 'pdftoppm';
export async function scanRasterizerReady() {
  try { await runFile(poppler(), ['-v'], { timeout: 3_000, maxBuffer: 32_000 }); return true; } catch { return false; }
}
async function rasterise(file: string, page: number): Promise<Uint8Array> {
  // Isolate native rendering in a subprocess. A malformed PDF or an unavailable renderer must not crash the app.
  const { stdout } = await runFile(poppler(), ['-f',String(page),'-l',String(page),'-r','144',
    '-scale-to',String(Math.floor(Math.sqrt(MAX_OCR_PIXELS))),'-png','-singlefile',file],
    {encoding:'buffer',timeout:15_000,maxBuffer:15*1024*1024});
  if (stdout.subarray(1,4).toString() !== 'PNG') throw new Error('PDF rendering produced no PNG.');
  return stdout;
}

async function ocrBuffers(images: Uint8Array[], startPage: number[], onPage?: OnPage): Promise<{ page: number; text: string; confidence: number }[]> {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng', 1, ocrLanguageOptions());
  try {
    const out: { page: number; text: string; confidence: number }[] = [];
    for (let i = 0; i < images.length; i += 1) {
      const r = await worker.recognize(Buffer.from(images[i]));
      out.push({ page: startPage[i], text: r.data.text ?? '', confidence: Math.round(r.data.confidence ?? 0) });
      onPage?.({ page: startPage[i], total: images.length, chars: (r.data.text ?? '').length, method: 'ocr' });
    }
    return out;
  } finally {
    await worker.terminate();
  }
}

export async function extractPdf(name: string, bytes: Uint8Array, onPage?: OnPage): Promise<ExtractedDocument> {
  const base: ExtractedDocument = { name, method: 'pdf-text', pages: [], truncated: false, limitation: '' };
  if (bytes.byteLength > MAX_BYTES) return { ...base, limitation: `The PDF is ${(bytes.byteLength / 1048576).toFixed(1)} MB, above the ${MAX_BYTES / 1048576} MB limit. Split the document or upload the relevant pages.` };
  let pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs');
  try { pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'); } catch (e) { return { ...base, limitation: `The PDF reader could not be loaded: ${e instanceof Error ? e.message : 'unknown error'}` }; }
  let doc;
  try { doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false, verbosity: 0 } as never).promise; }
  catch (e) { return { ...base, limitation: `The PDF could not be opened: ${e instanceof Error ? e.message : 'unknown error'}${/password/i.test(String(e)) ? ' (it is password protected)' : ''}.` }; }
  const total = doc.numPages;
  const limit = Math.min(total, MAX_PDF_PAGES);
  const pages: ExtractedDocument['pages'] = [];
  const scanned: number[] = [];
  const failedPages: number[] = [];
  for (let p = 1; p <= limit; p += 1) {
    try {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const nativeText = tc.items.map((it) => ('str' in it ? it.str + ('hasEOL' in it && it.hasEOL ? '\n' : ' ') : '')).join('').replace(/[ \t]+/g, ' ').trim();
      const annotations = await page.getAnnotations({ intent: 'display' }).catch(() => []);
      const notes = [...new Set(annotations
        .filter((a) => ['FreeText', 'Text', 'Polygon', 'PolyLine', 'Line', 'Square', 'Circle', 'Ink', 'Highlight'].includes(a.subtype))
        .map((a) => typeof a.contentsObj?.str === 'string' ? a.contentsObj.str.trim().slice(0, 500) : '')
        .filter((a) => a && !nativeText.includes(a)))].slice(0, 100);
      // A markup note is not drawn geometry and never substitutes for the scan's underlying text.
      const text = [nativeText, notes.length ? '[PDF annotations; review against the sheet]\n' + notes.join('\n') : ''].filter(Boolean).join('\n');
      pages.push({ page: p, text });
      // A small native caption/watermark can coexist with a raster-only drawing.
      let rasterBody = false;
      if (nativeText.length >= MIN_TEXT_CHARS_PER_PAGE && nativeText.length < 120) {
        const ops = await page.getOperatorList().catch(() => null);
        if (ops) rasterBody = ops.fnArray.some((op, i) =>
          op === pdfjs.OPS.paintImageXObject && Number(ops.argsArray[i]?.[1]) >= 512 && Number(ops.argsArray[i]?.[2]) >= 384);
      }
      if (nativeText.length < MIN_TEXT_CHARS_PER_PAGE || rasterBody) scanned.push(p);
      onPage?.({ page: p, total: limit, chars: text.length, method: 'pdf-text' });
    } catch { pages.push({ page: p, text: '' }); failedPages.push(p); }
  }
  let limitation = '';
  let method: ExtractedDocument['method'] = 'pdf-text';
  if (failedPages.length) limitation += `${failedPages.length} page(s) could not be read: ${failedPages.slice(0, 20).join(', ')}. `;
  if (total > limit) limitation += `Only the first ${limit} of ${total} pages were read (page limit); pages ${limit + 1}-${total} were NOT read. `;
  if (scanned.length) {
    const ocrPages = scanned.slice(0, MAX_OCR_PAGES);
    const images: Uint8Array[] = [];
    const nums: number[] = [];
    const renderFailures: string[] = [];
    let folder: string | undefined;
    try {
      folder = await mkdtemp(join(tmpdir(),'pvr-pdf-'));
      const file = join(folder,'input.pdf');
      await writeFile(file, bytes, {mode:0o600});
      for (const p of ocrPages) {
        try { images.push(await rasterise(file,p)); nums.push(p); }
        catch (e) {
          renderFailures.push(`${p} (${e instanceof Error && 'code' in e && e.code==='ENOENT' ? 'Poppler is not installed; use the configured processing worker for scan OCR' : 'the rasterizer failed or exceeded its limits'})`);
          if (e instanceof Error && 'code' in e && e.code==='ENOENT') break;
        }
      }
    } catch (e) { renderFailures.push(e instanceof Error ? e.message : 'Unable to stage PDF for rendering.'); }
    finally { if (folder) await rm(folder, {recursive:true,force:true}); }
    if (renderFailures.length) limitation += `OCR render failed page(s): ${renderFailures.slice(0, 6).join('; ')}. `;
    if (images.length === 0) {
      limitation += `${scanned.length} page(s) need OCR and were NOT fully read because no page could be rendered: pages ${scanned.slice(0, 20).join(', ')}${scanned.length > 20 ? '…' : ''}. `;
    } else {
      try {
        const ocr = await ocrBuffers(images, nums, onPage);
        const stillEmpty: number[] = [];
        for (const o of ocr) { let i = pages.findIndex((x) => x.page === o.page); if (i >= 0 && o.text.trim()) {
          const native = pages[i].text;
          const extracted = o.text.trim();
          const normalize = (s: string) => s.toLowerCase().replace(/\s+/g,' ').trim();
          pages[i] = { page: o.page, text: native && !normalize(extracted).includes(normalize(native)) ? native+'\n'+extracted : extracted, confidence: o.confidence };
        } if (!o.text.trim()) stillEmpty.push(o.page); }
        method = 'ocr';
        const notReached = scanned.length - ocrPages.length;
        if (notReached > 0) limitation += `${notReached} further scanned page(s) were NOT OCR'd (limit ${MAX_OCR_PAGES} pages per document). `;
        const low = ocr.filter(o => o.text.trim() && o.confidence < 70).map(o => o.page);
        if (low.length) limitation += `Low-confidence OCR needs manual verification on page(s): ${low.slice(0,20).join(', ')}. `;
        if (stillEmpty.length) limitation += `OCR recognised no text on page(s) ${stillEmpty.slice(0, 20).join(', ')}. `;
        limitation += `OCR was used for ${ocr.length} scanned page(s); OCR text can contain errors and is not used for geometric measurement. `;
      } catch (e) {
        limitation += `OCR failed for ${images.length} scanned page(s): ${e instanceof Error ? e.message : 'unknown error'}. Check the packaged English language model or OCR_LANG_PATH configuration. `;
      }
    }
  }
  await doc.destroy();
  return { ...base, method, pages, truncated: total > limit || failedPages.length>0 || scanned.some(p => pages[p-1]?.confidence === undefined), limitation: limitation.trim() };
}

export async function extractDocx(name: string, bytes: Uint8Array): Promise<ExtractedDocument> {
  const base: ExtractedDocument = { name, method: 'docx', pages: [], truncated: false, limitation: '' };
  if (bytes.byteLength > MAX_BYTES) return { ...base, limitation: `The document is larger than the ${MAX_BYTES / 1048576} MB limit.` };
  try {
    const mammoth = (await import('mammoth')) as unknown as { extractRawText: (o: { buffer: Buffer }) => Promise<{ value: string; messages: { message: string }[] }> };
    const r = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    // DOCX has no fixed pages. `page` here is a SECTION index (paragraph groups), never a physical page number.
    const paras = r.value.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    const pages: ExtractedDocument['pages'] = [];
    let buf = ''; let n = 1;
    for (let p of paras) { if ((buf + p).length > 3000 && buf) { pages.push({ page: n, text: buf.trim() }); n += 1; buf = ''; } buf += `${p}\n\n`; }
    if (buf.trim()) pages.push({ page: n, text: buf.trim() });
    const notes = r.messages.length ? ` Reader notes: ${r.messages.slice(0, 3).map((m) => m.message).join(' ')}` : '';
    return { ...base, pages, unitKind: 'section', limitation: `Word documents have no fixed pages: references are to text sections (paragraph groups), not physical page numbers.${notes}` };
  } catch (e) {
    return { ...base, limitation: `The Word document could not be read: ${e instanceof Error ? e.message : 'unknown error'}. Legacy .doc files are not supported; save as .docx.` };
  }
}

export async function extractImage(name: string, bytes: Uint8Array, onPage?: OnPage): Promise<ExtractedDocument> {
  const base: ExtractedDocument = { name, method: 'ocr', pages: [], truncated: false, limitation: '' };
  if (bytes.byteLength > MAX_BYTES) return { ...base, limitation: `The image is larger than the ${MAX_BYTES / 1048576} MB limit.` };
  try {
    const r = await ocrBuffers([bytes], [1], onPage);
    const t = r[0].text.trim();
    return { ...base, pages: [{ page: 1, text: t, confidence: r[0].confidence }], limitation: `${t ? '' : 'OCR recognised no text. '}OCR text can contain errors. It is not used for geometric measurement: a scanned drawing needs a scale and alignment before anything is measured.`.trim() };
  } catch (e) {
    return { ...base, limitation: `OCR failed: ${e instanceof Error ? e.message : 'unknown error'}. Check the packaged English language model or OCR_LANG_PATH configuration.` };
  }
}

/** Dispatch by extension. Returns null for formats this module does not read as text. */
export async function extractByExtension(name: string, bytes: Uint8Array, onPage?: OnPage): Promise<ExtractedDocument | null> {
  const e = extOf(name);
  if (e === 'pdf') return extractPdf(name, bytes, onPage);
  if (e === 'docx') return extractDocx(name, bytes);
  if (IMAGE_EXT.includes(e)) return extractImage(name, bytes, onPage);
  return null;
}

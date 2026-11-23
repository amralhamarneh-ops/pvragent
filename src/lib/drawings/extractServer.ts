/**
 * Server-side document text extraction. Runs in Node (route handlers / tests), never in the browser.
 *  - PDF: text layer per page via pdfjs-dist. Pages with no text layer are flagged as scanned and OCR'd when a
 *         rasteriser is available (@napi-rs/canvas), otherwise reported explicitly as not read.
 *  - DOCX: raw text via mammoth. Sections are paragraph groups, NOT physical pages.
 *  - Images: OCR via tesseract.js (eng traineddata is fetched once from OCR_LANG_PATH or the tesseract.js CDN;
 *            only the language model is downloaded, never project documents).
 * Every result keeps page numbers, and every limit (page cap, size cap) is reported, never silently applied.
 * `coverage` states exactly how many units were read, OCR'd, skipped or failed.
 */
import type { ExtractedDocument } from './types';

export const MAX_PDF_PAGES = 400;
export const MAX_OCR_PAGES = 25;
export const MAX_BYTES = 40 * 1024 * 1024;
const MIN_TEXT_CHARS_PER_PAGE = 25;

const extOf = (n: string) => (n.match(/\.([a-z0-9]+)$/i) ?? [])[1]?.toLowerCase() ?? '';
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp'];

type OnPage = (info: { page: number; total: number; chars: number; method: string }) => void;

type CanvasMod = { createCanvas: (w: number, h: number) => { getContext: (t: string) => unknown; toBuffer: (m: string) => Buffer; width: number; height: number }; Path2D: unknown; DOMMatrix: unknown; ImageData: unknown };
let canvasMod: CanvasMod | null | undefined;

/**
 * pdfjs-dist 5.x must draw with the same canvas implementation that supplies Path2D/DOMMatrix. Without these globals and
 * a canvasFactory, render() throws "not a valid enum value of type CanvasFillRule" (observed with @napi-rs/canvas 1.1.0),
 * which made OCR of scanned PDFs fail.
 */
async function loadCanvas(): Promise<CanvasMod | null> {
  if (canvasMod !== undefined) return canvasMod;
  try {
    const nc = (await import('@napi-rs/canvas')) as unknown as CanvasMod;
    const g = globalThis as unknown as Record<string, unknown>;
    g.Path2D ??= nc.Path2D; g.DOMMatrix ??= nc.DOMMatrix; g.ImageData ??= nc.ImageData;
    canvasMod = nc;
  } catch { canvasMod = null; }
  return canvasMod;
}

type CC = { canvas: { width: number; height: number; getContext: (t: string) => unknown; toBuffer: (m: string) => Buffer } | null; context: unknown };
function canvasFactory(nc: CanvasMod) {
  return {
    create(w: number, h: number): CC { const canvas = nc.createCanvas(w, h); return { canvas, context: canvas.getContext('2d') }; },
    reset(cc: CC, w: number, h: number) { if (cc.canvas) { cc.canvas.width = w; cc.canvas.height = h; } },
    destroy(cc: CC) { cc.canvas = null; cc.context = null; },
  };
}

async function ocrBuffers(images: Uint8Array[], startPage: number[], onPage?: OnPage): Promise<{ page: number; text: string; confidence: number }[]> {
  const { createWorker } = await import('tesseract.js');
  const langPath = process.env.OCR_LANG_PATH;
  const worker = await createWorker('eng', 1, langPath ? { langPath } : {});
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

type PdfPage = { getViewport: (o: { scale: number }) => { width: number; height: number }; render: (o: unknown) => { promise: Promise<void> } };
async function rasterise(page: PdfPage): Promise<{ bytes: Uint8Array | null; error?: string }> {
  const nc = await loadCanvas();
  if (!nc) return { bytes: null, error: 'the "@napi-rs/canvas" rasteriser is not available in this runtime' };
  try {
    const vp = page.getViewport({ scale: 2 });
    const { canvas, context } = canvasFactory(nc).create(Math.ceil(vp.width), Math.ceil(vp.height));
    const g = context as { fillStyle: string; fillRect: (x: number, y: number, w: number, h: number) => void };
    g.fillStyle = '#fff'; g.fillRect(0, 0, canvas!.width, canvas!.height);
    await page.render({ canvasContext: context, viewport: vp, canvas }).promise;
    return { bytes: new Uint8Array(canvas!.toBuffer('image/png')) };
  } catch (e) { return { bytes: null, error: `page rendering failed: ${e instanceof Error ? e.message : 'unknown error'}` }; }
}

export async function extractPdf(name: string, bytes: Uint8Array, onPage?: OnPage): Promise<ExtractedDocument> {
  const base: ExtractedDocument = { name, method: 'pdf-text', pages: [], truncated: false, limitation: '' };
  if (bytes.byteLength > MAX_BYTES) return { ...base, limitation: `The PDF is ${(bytes.byteLength / 1048576).toFixed(1)} MB, above the ${MAX_BYTES / 1048576} MB limit. Split the document or upload the relevant pages.` };
  let pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs');
  try { pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'); } catch (e) { return { ...base, limitation: `The PDF reader could not be loaded: ${e instanceof Error ? e.message : 'unknown error'}` }; }
  const nc = await loadCanvas();
  let doc;
  try { doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false, verbosity: 0, ...(nc ? { canvasFactory: canvasFactory(nc) } : {}) } as never).promise; }
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
      const text = tc.items.map((it) => ('str' in it ? it.str + ('hasEOL' in it && it.hasEOL ? '\n' : ' ') : '')).join('').replace(/[ \t]+/g, ' ').trim();
      pages.push({ page: p, text });
      if (text.length < MIN_TEXT_CHARS_PER_PAGE) scanned.push(p);
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
    let renderError = '';
    for (let p of ocrPages) {
      const r = await rasterise((await doc.getPage(p)) as unknown as PdfPage);
      if (!r.bytes) { renderError = r.error ?? 'unknown rendering error'; break; }
      images.push(r.bytes); nums.push(p);
    }
    if (images.length === 0) {
      limitation += `${scanned.length} page(s) have no text layer (scanned) and were NOT read because OCR could not run (${renderError}): pages ${scanned.slice(0, 20).join(', ')}${scanned.length > 20 ? '…' : ''}. `;
    } else {
      try {
        const ocr = await ocrBuffers(images, nums, onPage);
        const stillEmpty: number[] = [];
        for (const o of ocr) { let i = pages.findIndex((x) => x.page === o.page); if (i >= 0) pages[i] = { page: o.page, text: o.text.trim(), confidence: o.confidence }; if (!o.text.trim()) stillEmpty.push(o.page); }
        method = 'ocr';
        const notReached = scanned.length - images.length;
        if (notReached > 0) limitation += `${notReached} further scanned page(s) were NOT OCR'd (${scanned.length > ocrPages.length ? `limit ${MAX_OCR_PAGES} pages per document` : renderError}). `;
        if (stillEmpty.length) limitation += `OCR recognised no text on page(s) ${stillEmpty.slice(0, 20).join(', ')}. `;
        limitation += `OCR was used for ${ocr.length} scanned page(s); OCR text can contain errors and is not used for geometric measurement. `;
      } catch (e) {
        limitation += `OCR failed for ${images.length} scanned page(s): ${e instanceof Error ? e.message : 'unknown error'}. If the server cannot download the OCR language model, set OCR_LANG_PATH to a location that hosts eng.traineddata. `;
      }
    }
  }
  await doc.destroy();
  return { ...base, method, pages, truncated: total > limit, limitation: limitation.trim() };
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
    return { ...base, limitation: `OCR failed: ${e instanceof Error ? e.message : 'unknown error'}. If the server cannot download the OCR language model, set OCR_LANG_PATH to a location that hosts eng.traineddata.` };
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

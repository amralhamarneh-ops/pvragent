/**
 * Extraction core used by the worker. Mirrors the in-app reader (src/lib/drawings/extractServer.ts) but reports
 * per-page status so partial reads are never presented as complete.
 *
 * Result shape (`doc`):
 *  - unitKind: 'page' (PDF/image) | 'section' (DOCX paragraph groups - NOT physical pages)
 *  - units[]: { index, label, text, method: 'text'|'ocr'|'none', status: 'read'|'skipped'|'failed', reason?, confidence? }
 *  - coverage: { total, read, ocr, skipped, failed, complete }
 */

export const LIMITS = {
  maxBytes: Number(process.env.MAX_FILE_BYTES || 40 * 1024 * 1024),
  maxPdfPages: Number(process.env.MAX_PDF_PAGES || 400),
  maxOcrPages: Number(process.env.MAX_OCR_PAGES || 40),
  jobTimeoutMs: Number(process.env.JOB_TIMEOUT_MS || 240_000),
};
const MIN_TEXT = 25;
const ext = (n) => (String(n).match(/\.([a-z0-9]+)$/i) ?? [])[1]?.toLowerCase() ?? '';
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp'];

function coverage(units, extraNote = '') {
  const read = units.filter((u) => u.status === 'read').length;
  const ocr = units.filter((u) => u.status === 'read' && u.method === 'ocr').length;
  const skipped = units.filter((u) => u.status === 'skipped').length;
  const failed = units.filter((u) => u.status === 'failed').length;
  return { total: units.length, read, ocr, skipped, failed, complete: units.length > 0 && read === units.length, note: extraNote };
}

export function sniff(bytes) {
  const h = Buffer.from(bytes.subarray(0, 8));
  if (h.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (h[0] === 0x50 && h[1] === 0x4b) return 'zip';
  if (h.subarray(0, 2).toString('latin1') === 'AC') return 'dwg';
  if (h[0] === 0x89 && h.subarray(1, 4).toString('latin1') === 'PNG') return 'png';
  if (h[0] === 0xff && h[1] === 0xd8) return 'jpg';
  return 'unknown';
}

async function makeOcr(signal) {
  const { createWorker } = await import('tesseract.js');
  const langPath = process.env.OCR_LANG_PATH;
  const worker = await createWorker('eng', 1, langPath ? { langPath } : {});
  signal?.addEventListener('abort', () => { worker.terminate().catch(() => {}); }, { once: true });
  return worker;
}

/**
 * pdfjs-dist 5.x needs the same canvas implementation for its path ops as the one it draws on. Without the
 * Path2D/DOMMatrix globals and a canvasFactory, render() throws "not a valid enum value of type CanvasFillRule"
 * (observed with @napi-rs/canvas 1.1.0), which silently disabled OCR of scanned PDFs.
 */
let napi = null;
export async function loadCanvas() {
  if (napi) return napi;
  try {
    const nc = await import('@napi-rs/canvas');
    globalThis.Path2D ??= nc.Path2D; globalThis.DOMMatrix ??= nc.DOMMatrix; globalThis.ImageData ??= nc.ImageData;
    napi = nc;
  } catch { napi = null; }
  return napi;
}
export const canvasFactory = () => ({
  create(w, h) { const canvas = napi.createCanvas(w, h); return { canvas, context: canvas.getContext('2d') }; },
  reset(cc, w, h) { cc.canvas.width = w; cc.canvas.height = h; },
  destroy(cc) { cc.canvas = null; cc.context = null; },
});

async function rasterise(page) {
  if (!(await loadCanvas())) return null;
  const vp = page.getViewport({ scale: 2 });
  const { canvas, context } = canvasFactory().create(Math.ceil(vp.width), Math.ceil(vp.height));
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport: vp, canvas }).promise;
  return canvas.toBuffer('image/png');
}

export async function extractPdf(bytes, { signal, onProgress } = {}) {
  const units = [];
  if (sniff(bytes) !== 'pdf') return { ok: false, error: 'The file is not a valid PDF (missing %PDF header).', doc: { unitKind: 'page', units, coverage: coverage(units) } };
  await loadCanvas();
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let doc;
  try { doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0, ...(napi ? { canvasFactory: canvasFactory() } : {}) }).promise; }
  catch (e) { return { ok: false, error: `The PDF could not be opened: ${e?.message ?? e}${/password/i.test(String(e)) ? ' (password protected)' : ''}.`, doc: { unitKind: 'page', units, coverage: coverage(units) } }; }
  const total = doc.numPages; const limit = Math.min(total, LIMITS.maxPdfPages);
  const needOcr = [];
  for (let p = 1; p <= limit; p += 1) {
    if (signal?.aborted) throw new Error('cancelled');
    try {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const text = tc.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : ' ') : '')).join('').replace(/[ \t]+/g, ' ').trim();
      if (text.length >= MIN_TEXT) units.push({ index: p, label: `Page ${p}`, text, method: 'text', status: 'read' });
      else { units.push({ index: p, label: `Page ${p}`, text, method: 'none', status: 'skipped', reason: 'No text layer (scanned/image page).' }); needOcr.push(p); }
    } catch (e) { units.push({ index: p, label: `Page ${p}`, text: '', method: 'none', status: 'failed', reason: `Page could not be read: ${e?.message ?? e}` }); }
    onProgress?.({ done: p, total: limit, detail: `PDF text: page ${p} of ${limit}` });
  }
  for (let p = limit + 1; p <= total; p += 1) units.push({ index: p, label: `Page ${p}`, text: '', method: 'none', status: 'skipped', reason: `Beyond the ${LIMITS.maxPdfPages}-page limit.` });
  let note = '';
  if (needOcr.length) {
    const target = needOcr.slice(0, LIMITS.maxOcrPages);
    for (const p of needOcr.slice(LIMITS.maxOcrPages)) { const u = units.find((x) => x.index === p); if (u) u.reason = `Scanned page not OCR'd: beyond the ${LIMITS.maxOcrPages}-page OCR limit.`; }
    let worker;
    try {
      worker = await makeOcr(signal);
      let i = 0;
      for (const p of target) {
        if (signal?.aborted) throw new Error('cancelled');
        const u = units.find((x) => x.index === p);
        try {
          const img = await rasterise(await doc.getPage(p));
          if (!img) { u.reason = 'OCR rasteriser (@napi-rs/canvas) is unavailable in this runtime.'; u.status = 'failed'; continue; }
          const r = await worker.recognize(img);
          const t = (r.data.text ?? '').trim();
          if (t) { u.text = t; u.method = 'ocr'; u.status = 'read'; u.confidence = Math.round(r.data.confidence ?? 0); delete u.reason; }
          else { u.status = 'failed'; u.reason = 'OCR ran but recognised no text.'; }
        } catch (e) { u.status = 'failed'; u.reason = `OCR failed: ${e?.message ?? e}`; }
        i += 1; onProgress?.({ done: i, total: target.length, detail: `OCR: page ${p} (${i} of ${target.length})` });
      }
      note = 'OCR text can contain errors and is never evidence of a geometric measurement.';
    } catch (e) {
      if (String(e?.message) === 'cancelled') throw e;
      for (const p of target) { const u = units.find((x) => x.index === p); if (u && u.status === 'skipped') { u.status = 'failed'; u.reason = `OCR engine could not start: ${e?.message ?? e}. Set OCR_LANG_PATH if the language model cannot be downloaded.`; } }
    } finally { await worker?.terminate().catch(() => {}); }
  }
  await doc.destroy();
  const cov = coverage(units, note);
  return { ok: cov.read > 0, doc: { unitKind: 'page', units, coverage: cov } };
}

export async function extractDocx(bytes) {
  const units = [];
  if (sniff(bytes) !== 'zip') return { ok: false, error: 'The file is not a valid .docx (not a ZIP package). Legacy .doc is not supported; save as .docx.', doc: { unitKind: 'section', units, coverage: coverage(units) } };
  try {
    const mammoth = (await import('mammoth')).default ?? (await import('mammoth'));
    const r = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    const paras = r.value.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    let buf = ''; let n = 1;
    const flush = () => { if (buf.trim()) { units.push({ index: n, label: `Section ${n}`, text: buf.trim(), method: 'text', status: 'read' }); n += 1; buf = ''; } };
    for (const p of paras) { if ((buf + p).length > 3000 && buf) flush(); buf += `${p}\n\n`; }
    flush();
    const msgs = r.messages.slice(0, 5).map((m) => m.message);
    return { ok: units.length > 0, doc: { unitKind: 'section', units, coverage: coverage(units, 'DOCX has no fixed pages: sections are paragraph groups and are not physical page numbers.' + (msgs.length ? ` Reader notes: ${msgs.join('; ')}` : '')) } };
  } catch (e) { return { ok: false, error: `The Word document could not be read: ${e?.message ?? e}`, doc: { unitKind: 'section', units, coverage: coverage(units) } }; }
}

export async function extractImage(bytes, { signal, onProgress } = {}) {
  const units = [];
  const k = sniff(bytes);
  if (k !== 'png' && k !== 'jpg') return { ok: false, error: 'Unrecognised image content (only PNG and JPEG signatures are verified).', doc: { unitKind: 'page', units, coverage: coverage(units) } };
  let worker;
  try {
    worker = await makeOcr(signal);
    const r = await worker.recognize(Buffer.from(bytes));
    const t = (r.data.text ?? '').trim();
    units.push({ index: 1, label: 'Image', text: t, method: 'ocr', status: t ? 'read' : 'failed', confidence: Math.round(r.data.confidence ?? 0), ...(t ? {} : { reason: 'OCR recognised no text.' }) });
    onProgress?.({ done: 1, total: 1, detail: 'OCR: image' });
  } catch (e) { units.push({ index: 1, label: 'Image', text: '', method: 'none', status: 'failed', reason: `OCR failed: ${e?.message ?? e}` }); }
  finally { await worker?.terminate().catch(() => {}); }
  const cov = coverage(units, 'OCR text can contain errors. A scanned drawing has no scale or alignment, so nothing is measured from it.');
  return { ok: cov.read > 0, doc: { unitKind: 'page', units, coverage: cov } };
}

export async function extractByName(name, bytes, opts) {
  const e = ext(name);
  if (e === 'pdf') return { kind: 'text', ...(await extractPdf(bytes, opts)) };
  if (e === 'docx') return { kind: 'text', ...(await extractDocx(bytes)) };
  if (IMAGE_EXT.includes(e)) return { kind: 'text', ...(await extractImage(bytes, opts)) };
  return null;
}

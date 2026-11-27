/**
 * Processing worker HTTP service (no framework; Node >= 20).
 *   GET    /health                 unauthenticated liveness + real dependency probes (no secrets)
 *   POST   /jobs                   multipart: file, caseId, runId  (Bearer auth) -> 202 { job }
 *   GET    /jobs/:id               progress / state
 *   GET    /jobs/:id/result        result (when finished)
 *   DELETE /jobs/:id               cancel
 * Auth: Authorization: Bearer <WORKER_API_TOKEN>. The token is held only by the Next.js server, never the browser.
 */
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { JobManager } from './jobs.mjs';
import { extractByName, sniff, LIMITS, ocrLanguageOptions, scanRasterizerReady } from './extract.mjs';
import { convertDwg, probeDwg } from './dwg.mjs';
import { startRunner, runnerState } from './runner.mjs';
import { storeConfig } from './store.mjs';
import { readDxfForWorker } from './dxf.mjs';

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.WORKER_API_TOKEN || '';
const ALLOWED_EXT = new Set(['pdf', 'docx', 'png', 'jpg', 'jpeg', 'dwg']);
const extOf = (n) => (String(n).match(/\.([a-z0-9]+)$/i) ?? [])[1]?.toLowerCase() ?? '';

const eq = (a, b) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const authed = (req) => { if (!TOKEN) return false; const h = req.headers.authorization || ''; return h.startsWith('Bearer ') && eq(h.slice(7), TOKEN); };
const json = (res, code, body) => { const s = JSON.stringify(body); res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(s); };

const manager = new JobManager(async (job, report) => {
  const e = extOf(job.fileName);
  const signal = job.controller.signal;
  if (e === 'dwg') {
    report({ detail: 'Converting DWG to DXF' });
    const r = await convertDwg(job.bytes, { signal, timeoutMs: LIMITS.jobTimeoutMs });
    if (!r.ok) return { kind: 'dwg', ok: false, error: r.error, converter: r.converter, sourceSha256: r.sourceSha256 };
    const { dxf, ...meta } = r;
    return { kind: 'dwg', ok: true, ...meta, dxfBase64: Buffer.from(dxf).toString('base64'), doc: { coverage: { complete: meta.validation.issues.length === 0 && meta.warnings.length === 0 } } };
  }
  const out = await extractByName(job.fileName, job.bytes, { signal, onProgress: (p) => report(p) });
  return out ?? { kind: 'text', ok: false, error: `.${e} is not a format this service reads.` };
}, { timeoutMs: LIMITS.jobTimeoutMs });
setInterval(() => manager.sweep(), 60_000).unref();

async function readBody(req, max) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw Object.assign(new Error('too_large'), { code: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}

/** Minimal multipart parser (file + text fields). */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || ''); if (!m) return null;
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const fields = {}; let file = null; let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const next = buf.indexOf(boundary, pos + boundary.length); if (next === -1) break;
    const part = buf.subarray(pos + boundary.length + 2, next - 2);
    const hEnd = part.indexOf('\r\n\r\n'); if (hEnd === -1) { pos = next; continue; }
    const head = part.subarray(0, hEnd).toString('utf8'); const body = part.subarray(hEnd + 4);
    const name = /name="([^"]+)"/.exec(head)?.[1]; const fn = /filename="([^"]*)"/.exec(head)?.[1];
    if (fn !== undefined && name === 'file') file = { name: fn, bytes: body }; else if (name) fields[name] = body.toString('utf8');
    pos = next;
  }
  return { fields, file };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/health') {
      const dwg = await probeDwg();
      let pdf = false, docx = false, ocr = false;
      try { await import('pdfjs-dist/legacy/build/pdf.mjs'); pdf = true; } catch {}
      try { await import('mammoth'); docx = true; } catch {}
      const rasterizer = await scanRasterizerReady();
      try { ocrLanguageOptions(); await import('tesseract.js'); ocr = true; } catch {}
      const sc = storeConfig();
      return json(res, 200, { status: 'ok', service: 'pvr-processing-worker', authConfigured: !!TOKEN, limits: LIMITS, running: manager.running, queued: manager.queue.length, durable: { configured: sc.ok, missing: sc.missing, runnerStarted: runnerState.started, workerId: runnerState.workerId, tasksRunning: runnerState.running, tasksProcessed: runnerState.processed, lastClaimAt: runnerState.lastClaimAt, lastError: runnerState.lastError }, dependencies: { pdfText: pdf, docx, rasteriser: rasterizer, ocrEngine: ocr, dwg: dwg.ok ? { ok: true, converter: dwg.converter, version: dwg.version } : { ok: false, reason: dwg.error } } });
    }
    if (!authed(req)) return json(res, TOKEN ? 401 : 503, { error: TOKEN ? 'Unauthorised.' : 'WORKER_API_TOKEN is not configured on the worker.' });

    // Functional tests (authenticated, no persistence): run a REAL operation on supplied bytes and report what happened.
    //   POST /selftest/dwg   body = DWG bytes   -> converts through the configured converter and reads the DXF
    //   POST /selftest/dxf   body = DXF bytes   -> reads geometry and returns coverage
    if (req.method === 'POST' && (url.pathname === '/selftest/dwg' || url.pathname === '/selftest/dxf')) {
      let body; try { body = await readBody(req, LIMITS.maxBytes); } catch { return json(res, 413, { error: 'Too large.' }); }
      const t0 = Date.now();
      if (url.pathname === '/selftest/dxf') {
        const r = await readDxfForWorker('selftest.dxf', body, {});
        return json(res, 200, { operation: 'read DXF geometry', ok: r.ok, state: r.state, error: r.error ?? null, coverage: r.coverage ?? null, durationMs: Date.now() - t0 });
      }
      if (sniff(body) !== 'dwg') return json(res, 415, { error: 'The body is not a DWG (signature check failed).' });
      const c = await convertDwg(body, { timeoutMs: LIMITS.jobTimeoutMs });
      if (!c.ok) return json(res, 200, { operation: 'convert DWG to DXF', ok: false, error: c.error, converter: c.converter ?? null, durationMs: Date.now() - t0 });
      const r = await readDxfForWorker('selftest.dxf', c.dxf, {});
      return json(res, 200, { operation: 'convert DWG to DXF and read geometry', ok: r.ok, converter: c.converter, converterVersion: c.converterVersion, dxfSha256: c.dxfSha256, warnings: c.warnings, coverage: r.coverage ?? null, error: r.error ?? null, durationMs: Date.now() - t0 });
    }

    if (req.method === 'POST' && url.pathname === '/jobs') {
      let body; try { body = await readBody(req, LIMITS.maxBytes + 1_000_000); } catch (e) { return json(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? `Upload exceeds the ${LIMITS.maxBytes / 1048576} MB limit.` : 'Bad request.' }); }
      const mp = parseMultipart(body, req.headers['content-type']);
      if (!mp?.file) return json(res, 400, { error: 'Multipart field "file" is required.' });
      const { file, fields } = mp;
      if (!fields.caseId || !fields.runId) return json(res, 400, { error: '"caseId" and "runId" are required.' });
      if (file.bytes.length === 0) return json(res, 400, { error: 'The file is empty.' });
      if (file.bytes.length > LIMITS.maxBytes) return json(res, 413, { error: `File exceeds the ${LIMITS.maxBytes / 1048576} MB limit.` });
      const e = extOf(file.name);
      if (!ALLOWED_EXT.has(e)) return json(res, 415, { error: `.${e || '(none)'} is not accepted. Allowed: ${[...ALLOWED_EXT].join(', ')}.` });
      const kind = sniff(file.bytes);
      const okSig = (e === 'pdf' && kind === 'pdf') || (e === 'docx' && kind === 'zip') || (e === 'dwg' && kind === 'dwg') || (['png'].includes(e) && kind === 'png') || (['jpg', 'jpeg'].includes(e) && kind === 'jpg');
      if (!okSig) return json(res, 415, { error: `The content of "${file.name}" does not match a .${e} file (signature check failed).` });
      const sha256 = createHash('sha256').update(file.bytes).digest('hex');
      if (fields.sha256 && fields.sha256 !== sha256) return json(res, 422, { error: 'Integrity check failed: the received bytes do not match the declared sha256.' });
      const r = manager.submit({ caseId: fields.caseId, runId: fields.runId, fileName: file.name, sha256, bytes: file.bytes, kind: e });
      if (r.error) return json(res, 429, { error: 'The worker queue is full. Retry later.' });
      return json(res, 202, { job: manager.view(r.job) });
    }

    const m = /^\/jobs\/([0-9a-f-]{36})(\/result)?$/.exec(url.pathname);
    if (m) {
      const job = manager.get(m[1]);
      if (!job) return json(res, 404, { error: 'Job not found (it may have expired).' });
      if (req.method === 'GET' && !m[2]) return json(res, 200, { job: manager.view(job) });
      if (req.method === 'GET' && m[2]) {
        if (['queued', 'running'].includes(job.state)) return json(res, 409, { error: 'Job not finished.', job: manager.view(job) });
        if (job.state === 'cancelled') return json(res, 410, { error: 'Job was cancelled.', job: manager.view(job) });
        return json(res, 200, { job: manager.view(job, { withResult: true }) });
      }
      if (req.method === 'DELETE' && !m[2]) return json(res, 200, { job: manager.view(manager.cancel(m[1])) });
    }
    return json(res, 404, { error: 'Not found.' });
  } catch (e) { return json(res, 500, { error: 'Internal error.' }); }
});

export { server, manager };
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (!TOKEN) console.warn('WARNING: WORKER_API_TOKEN is not set; all job endpoints will refuse requests.');
  server.listen(PORT, () => console.log(`pvr-processing-worker listening on :${PORT}`));
  // The durable runner is the real background execution path. It runs in this same independent process, not in a request.
  if (process.env.DISABLE_RUNNER !== '1') void startRunner();
}

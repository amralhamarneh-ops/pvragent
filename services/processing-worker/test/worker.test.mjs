// Real end-to-end test: starts the actual worker HTTP server and submits generated files over HTTP.
// Run: cd services/processing-worker && npm install && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.WORKER_API_TOKEN = 'test-token-not-a-secret';
process.env.MAX_FILE_BYTES = String(5 * 1024 * 1024);
const { server } = await import('../src/server.mjs');
const { PDFDocument, StandardFonts } = await import('pdf-lib');
const { createCanvas } = await import('@napi-rs/canvas');
const JSZip = (await import('jszip')).default;

let base;
const H = { Authorization: `Bearer ${process.env.WORKER_API_TOKEN}` };
before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());

async function submit(name, bytes, extra = {}) {
  const fd = new FormData();
  fd.append('caseId', 'case-A'); fd.append('runId', extra.runId ?? 'run-1');
  fd.append('file', new Blob([bytes]), name);
  const r = await fetch(`${base}/jobs`, { method: 'POST', headers: extra.noAuth ? {} : H, body: fd });
  return { status: r.status, body: await r.json() };
}
async function finish(id, timeout = 120_000) {
  const t0 = Date.now();
  for (;;) {
    const j = (await (await fetch(`${base}/jobs/${id}`, { headers: H })).json()).job;
    if (!['queued', 'running'].includes(j.state)) return j;
    if (Date.now() - t0 > timeout) throw new Error('job did not finish');
    await new Promise((r) => setTimeout(r, 300));
  }
}
const result = async (id) => (await (await fetch(`${base}/jobs/${id}/result`, { headers: H })).json()).job;

async function textPdf() {
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
  for (const t of ['Variation request: extend road R4 by 2000 m of 7 m wide carriageway as instructed on 20/10/2026.', 'Page two: asphalt wearing course 50 mm thick. Kerb type A both sides of the road.']) d.addPage([595, 842]).drawText(t, { x: 30, y: 780, size: 11, font: f, maxWidth: 520 });
  return Buffer.from(await d.save());
}
async function scannedPdf() {
  const c = createCanvas(1400, 420); const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 1400, 420); g.fillStyle = '#000'; g.font = 'bold 70px sans-serif';
  g.fillText('EXCAVATION 1200 CUBIC METRES', 40, 160); g.fillText('REVISION C ISSUED', 40, 300);
  const d = await PDFDocument.create(); const img = await d.embedPng(c.toBuffer('image/png'));
  d.addPage([600, 180]).drawImage(img, { x: 0, y: 0, width: 600, height: 180 });
  return Buffer.from(await d.save());
}
async function docx() {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const p = (t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
  z.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p('The Engineer instructed an additional 350 m of drainage pipe on 3 March 2026.')}${p('Reported delay of 14 days due to late drawing revision.')}</w:body></w:document>`);
  return Buffer.from(await z.generateAsync({ type: 'nodebuffer' }));
}

test('health reports real dependency probes without secrets', async () => {
  const j = await (await fetch(`${base}/health`)).json();
  console.log('HEALTH', JSON.stringify(j.dependencies));
  assert.equal(j.status, 'ok'); assert.equal(j.dependencies.pdfText, true); assert.equal(j.dependencies.docx, true);
  assert.equal(JSON.stringify(j).includes(process.env.WORKER_API_TOKEN), false);
});

test('rejects unauthenticated and wrong-token requests', async () => {
  assert.equal((await submit('a.pdf', await textPdf(), { noAuth: true })).status, 401);
  const r = await fetch(`${base}/jobs/00000000-0000-0000-0000-000000000000`, { headers: { Authorization: 'Bearer wrong' } });
  assert.equal(r.status, 401);
});

test('1. text PDF: per-page text, complete coverage', async () => {
  const s = await submit('text.pdf', await textPdf()); assert.equal(s.status, 202);
  const j = await finish(s.body.job.id); const r = (await result(j.id)).result;
  console.log('TEXT_PDF', j.state, JSON.stringify(r.doc.coverage));
  assert.equal(j.state, 'completed'); assert.equal(r.doc.coverage.total, 2); assert.equal(r.doc.coverage.read, 2); assert.match(r.doc.units[0].text, /2000 m/);
});

test('2. scanned PDF: OCR run, reported as OCR with confidence', async () => {
  const s = await submit('scanned.pdf', await scannedPdf());
  const j = await finish(s.body.job.id, 180_000); const r = (await result(j.id)).result;
  const u = r.doc.units[0];
  console.log('SCANNED_PDF', j.state, JSON.stringify({ cov: r.doc.coverage, method: u.method, status: u.status, conf: u.confidence, reason: u.reason, text: u.text.slice(0, 80) }));
  // Either OCR genuinely worked, or the limitation is reported explicitly - never a silent empty "complete".
  if (u.status === 'read') { assert.equal(u.method, 'ocr'); assert.match(u.text.toUpperCase(), /EXCAVATION/); assert.equal(j.state, 'completed'); }
  else { assert.ok(u.reason); assert.notEqual(j.state, 'completed'); }
});

test('3. DOCX narrative: sections, not physical pages', async () => {
  const s = await submit('narr.docx', await docx()); const j = await finish(s.body.job.id); const r = (await result(j.id)).result;
  console.log('DOCX', j.state, r.doc.unitKind, JSON.stringify(r.doc.coverage));
  assert.equal(r.doc.unitKind, 'section'); assert.match(r.doc.units[0].label, /^Section/); assert.match(r.doc.units[0].text, /350 m/); assert.match(r.doc.coverage.note, /not physical page/);
});

test('6. unsupported / corrupt / mismatched files are refused or reported, never "processed"', async () => {
  assert.equal((await submit('x.exe', Buffer.from('MZ....'))).status, 415);
  assert.equal((await submit('fake.pdf', Buffer.from('not a pdf at all'))).status, 415);
  const s = await submit('corrupt.pdf', Buffer.from('%PDF-1.4\nthis is truncated garbage')); assert.equal(s.status, 202);
  const j = await finish(s.body.job.id); console.log('CORRUPT_PDF', j.state, j.error);
  assert.equal(j.state, 'failed'); assert.ok(j.error);
  const z = await submit('corrupt.docx', Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('garbage')]));
  const jz = await finish(z.body.job.id); console.log('CORRUPT_DOCX', jz.state, jz.error); assert.equal(jz.state, 'failed');
  const big = await submit('big.pdf', Buffer.alloc(6 * 1024 * 1024, 0x25)); assert.equal(big.status, 413);
});

test('5. DWG: reports not-configured honestly when no converter exists (NOT a pass of conversion)', async () => {
  const s = await submit('plan.dwg', Buffer.concat([Buffer.from('AC1032'), Buffer.alloc(300, 1)]));
  const j = await finish(s.body.job.id); console.log('DWG', j.state, j.error);
  assert.equal(j.state, 'failed'); assert.match(j.error, /DWG_CONVERTER|not found|not set|converter/i);
});

test('7. cancellation: a cancelled job never completes; late result is discarded; retry works', async () => {
  const pdf = await scannedPdf();
  const s = await submit('slow-scan.pdf', pdf, { runId: 'run-A' });
  const del = await (await fetch(`${base}/jobs/${s.body.job.id}`, { method: 'DELETE', headers: H })).json();
  assert.equal(del.job.state, 'cancelled');
  await new Promise((r) => setTimeout(r, 4000));
  const after = (await (await fetch(`${base}/jobs/${s.body.job.id}`, { headers: H })).json()).job;
  console.log('CANCEL', after.state);
  assert.equal(after.state, 'cancelled');
  assert.equal((await fetch(`${base}/jobs/${s.body.job.id}/result`, { headers: H })).status, 410);
  const retry = await submit('slow-scan.pdf', pdf, { runId: 'run-B' });
  assert.notEqual(retry.body.job.id, s.body.job.id); assert.equal(retry.body.job.runId, 'run-B');
  const jr = await finish(retry.body.job.id, 180_000); console.log('RETRY', jr.state); assert.ok(['completed', 'partial'].includes(jr.state));
});

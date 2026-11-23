import { NextRequest, NextResponse } from 'next/server';
import { runFile } from '@/lib/server/execFile';
import { workerConfig, testWorker } from '@/lib/drawings/processingAdapter';
import { dwgStatus } from '@/lib/drawings/dwgConvert';
import { readDxf } from '@/lib/drawings/dxfRead';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Three separate kinds of check, never merged into one green tick:
 *   startup    - dependency / startup check: the component loads or starts. Says NOTHING about correctness.
 *   functional - a real file is processed and a specific, checkable output is observed.
 *   accuracy   - output compared with a known reference; reports the measured score. Not run unless asked (and only
 *                where a reference exists). "Not run" is shown as such, never as passed.
 */
type Tier = 'startup' | 'functional' | 'accuracy';
type State = 'not_configured' | 'not_run' | 'passed' | 'failed' | 'unavailable';
interface Check { id: string; tool: string; tier: Tier; state: State; label: string; detail: string; operation?: string; metric?: string; testedAt?: string; durationMs?: number }

const now = () => new Date().toISOString();
async function timed<T extends { ok: boolean; detail: string; metric?: string }>(fn: () => Promise<T>) {
  const t0 = Date.now();
  try { const r = await fn(); return { ...r, ms: Date.now() - t0 }; } catch (e) { return { ok: false, detail: e instanceof Error ? e.message : 'unknown error', metric: undefined as string | undefined, ms: Date.now() - t0 }; }
}

function tinyPdf(text: string): Uint8Array {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const stream = `BT /F1 14 Tf 10 50 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n'; const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

/** Minimal valid DOCX built with JSZip (a dependency of this app). */
async function tinyDocx(text: string): Promise<Uint8Array> {
  const JSZip = (await import('jszip')).default; const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return new Uint8Array(await z.generateAsync({ type: 'uint8array' }));
}

const dxfBytes = (rows: (string | number)[]) => new TextEncoder().encode(rows.map(String).join('\n') + '\n');
/** A 10 m x 4 m closed rectangle on layer WALL, units metres: known length 28 m, known area 40 m². */
const RECT_DXF = dxfBytes(['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '6', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', '0', 'LWPOLYLINE', '5', 'A1', '8', 'WALL', '90', '4', '70', '1', '10', '0', '20', '0', '10', '10', '20', '0', '10', '10', '20', '4', '10', '0', '20', '4', '0', 'ENDSEC', '0', 'EOF']);

const lev = (a: string, b: string) => { const m = a.length, n = b.length; const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]); for (let j = 0; j <= n; j += 1) d[0][j] = j; for (let i = 1; i <= m; i += 1) for (let j = 1; j <= n; j += 1) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[m][n]; };

/**
 * GET                          -> every check as "not_run" / "not_configured" (configuration only)
 * GET ?run=startup|functional|accuracy|all  -> executes that tier. Credentials are never returned.
 */
export async function GET(req: NextRequest) {
  const want = req.nextUrl.searchParams.get('run') ?? '';
  const tiers = new Set<Tier>(want === 'all' ? ['startup', 'functional', 'accuracy'] : want === 'startup' || want === 'functional' || want === 'accuracy' ? [want] : []);
  const c = workerConfig(); const dwg = dwgStatus();
  const checks: Check[] = [];
  const add = (x: Check) => checks.push(x);
  const NR = (id: string, tool: string, tier: Tier, label: string, detail: string): Check => ({ id, tool, tier, state: 'not_run', label, detail });

  // ---------- PDF ----------
  if (!tiers.has('startup')) add(NR('pdf-startup', 'PDF', 'startup', 'PDF reader loads', 'Not run.'));
  else { const r = await timed(async () => { await import('pdfjs-dist/legacy/build/pdf.mjs'); return { ok: true, detail: 'The PDF library loaded. This does not show that any PDF was read.' }; }); add({ id: 'pdf-startup', tool: 'PDF', tier: 'startup', state: r.ok ? 'passed' : 'failed', label: 'PDF reader loads', detail: r.detail, testedAt: now(), durationMs: r.ms, operation: 'Import the PDF library' }); }
  if (!tiers.has('functional')) add(NR('pdf-functional', 'PDF', 'functional', 'Read text from a PDF', 'Not run.'));
  else { const r = await timed(async () => { const { extractPdf } = await import('@/lib/drawings/extractServer'); const d = await extractPdf('t.pdf', tinyPdf('Road extension 2000 m selftest')); const ok = /2000 m/.test(d.pages.map((p) => p.text).join(' ')); return { ok, detail: ok ? 'Extracted the expected text "2000 m" from a generated one-page PDF.' : `The expected text was not found. ${d.limitation}` }; }); add({ id: 'pdf-functional', tool: 'PDF', tier: 'functional', state: r.ok ? 'passed' : 'failed', label: 'Read text from a PDF', detail: r.detail, testedAt: now(), durationMs: r.ms, operation: 'Extract text from a generated PDF' }); }

  // ---------- DOCX ----------
  if (!tiers.has('startup')) add(NR('docx-startup', 'DOCX', 'startup', 'DOCX reader loads', 'Not run.'));
  else { const r = await timed(async () => { await import('mammoth'); return { ok: true, detail: 'The DOCX library loaded. This does not show that any DOCX was read.' }; }); add({ id: 'docx-startup', tool: 'DOCX', tier: 'startup', state: r.ok ? 'passed' : 'failed', label: 'DOCX reader loads', detail: r.detail, testedAt: now(), durationMs: r.ms, operation: 'Import the DOCX library' }); }
  if (!tiers.has('functional')) add(NR('docx-functional', 'DOCX', 'functional', 'Read text from a DOCX', 'Not run.'));
  else { const r = await timed(async () => { const { extractDocx } = await import('@/lib/drawings/extractServer'); const d = await extractDocx('t.docx', await tinyDocx('Additional 350 m of drainage pipe')); const ok = /350 m/.test(d.pages.map((p) => p.text).join(' ')); return { ok, detail: ok ? 'Extracted the expected text "350 m" from a generated DOCX.' : `The expected text was not found. ${d.limitation}` }; }); add({ id: 'docx-functional', tool: 'DOCX', tier: 'functional', state: r.ok ? 'passed' : 'failed', label: 'Read text from a DOCX', detail: r.detail, testedAt: now(), durationMs: r.ms, operation: 'Extract text from a generated DOCX' }); }

  // ---------- OCR ----------
  if (!tiers.has('startup')) add(NR('ocr-startup', 'OCR', 'startup', 'OCR engine starts', 'Not run.'));
  else { const r = await timed(async () => { let canvasOk = false; try { const nc = await import('@napi-rs/canvas'); canvasOk = typeof nc.createCanvas === 'function'; } catch { canvasOk = false; } if (!canvasOk) return { ok: false, detail: 'The rasteriser did not load, so scanned PDF pages cannot be OCR\'d here.' }; const { createWorker } = await import('tesseract.js'); const w = await createWorker('eng', 1, process.env.OCR_LANG_PATH ? { langPath: process.env.OCR_LANG_PATH } : {}); await w.terminate(); return { ok: true, detail: 'The rasteriser loaded and the OCR engine started. This does NOT show that any text is recognised correctly.' }; }); add({ id: 'ocr-startup', tool: 'OCR', tier: 'startup', state: r.ok ? 'passed' : 'failed', label: 'OCR engine starts', detail: r.detail, testedAt: now(), durationMs: r.ms, operation: 'Start the OCR engine' }); }
  const ocrImage = async (text: string) => { const nc = await import('@napi-rs/canvas'); const cv = nc.createCanvas(1400, 220); const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 1400, 220); g.fillStyle = '#000'; g.font = 'bold 72px sans-serif'; g.fillText(text, 40, 140); const { createWorker } = await import('tesseract.js'); const w = await createWorker('eng', 1, process.env.OCR_LANG_PATH ? { langPath: process.env.OCR_LANG_PATH } : {}); try { let out = await w.recognize(cv.toBuffer('image/png')); return out.data.text; } finally { await w.terminate(); } };
  if (!tiers.has('functional')) add(NR('ocr-functional', 'OCR', 'functional', 'Recognise text in an image', 'Not run.'));
  else { const r = await timed(async () => { const t = await ocrImage('EXCAVATION 1200 CUBIC METRES'); const ok = /EXCAVATION/i.test(t); return { ok, detail: ok ? `Recognised the keyword "EXCAVATION" in a generated image (output: "${t.trim().slice(0, 60)}"). One sample; not an accuracy measure.` : `The keyword was not recognised (output: "${t.trim().slice(0, 60)}").` }; }); add({ id: 'ocr-functional', tool: 'OCR', tier: 'functional', state: r.ok ? 'passed' : 'failed', label: 'Recognise text in an image', detail: r.detail, testedAt: now(), durationMs: r.ms, operation: 'OCR one generated image' }); }
  if (!tiers.has('accuracy')) add(NR('ocr-accuracy', 'OCR', 'accuracy', 'OCR character accuracy (synthetic benchmark)', 'Not run. Runs 3 generated clean-type images and reports a measured character accuracy. Does not represent scanned site drawings.'));
  else { const r = await timed(async () => { const refs = ['EXCAVATION 1200 CUBIC METRES', 'REVISION C ISSUED 20 OCT 2026', 'KERB TYPE A BOTH SIDES']; let dist = 0; let len = 0; for (const ref of refs) { const t = (await ocrImage(ref)).replace(/\s+/g, ' ').trim().toUpperCase(); dist += lev(ref, t); len += ref.length; } const acc = Math.max(0, 1 - dist / len); return { ok: acc >= 0.9, detail: `Measured on ${refs.length} generated clean-type images (${len} characters). Character accuracy ${(acc * 100).toFixed(1)}% (pass threshold 90%). This is a synthetic benchmark, not an accuracy claim for scanned site documents.`, metric: `${(acc * 100).toFixed(1)}% characters correct` }; }); add({ id: 'ocr-accuracy', tool: 'OCR', tier: 'accuracy', state: r.ok ? 'passed' : 'failed', label: 'OCR character accuracy (synthetic benchmark)', detail: r.detail, metric: r.metric, testedAt: now(), durationMs: r.ms, operation: 'Levenshtein character accuracy against known text' }); }

  // ---------- DXF ----------
  if (!tiers.has('startup')) add(NR('dxf-startup', 'DXF', 'startup', 'DXF parser loads', 'Not run.'));
  else { const r = await timed(async () => { await import('dxf-parser'); return { ok: true, detail: 'The DXF parser loaded. This does not show that any drawing was measured.' }; }); add({ id: 'dxf-startup', tool: 'DXF', tier: 'startup', state: r.ok ? 'passed' : 'failed', label: 'DXF parser loads', detail: r.detail, testedAt: now(), durationMs: r.ms, operation: 'Import the DXF parser' }); }
  if (!tiers.has('functional')) add(NR('dxf-functional', 'DXF', 'functional', 'Read DXF geometry', 'Not run.'));
  else { const r = await timed(async () => { const d = await readDxf('rect.dxf', RECT_DXF); const e = d.entities[0]; const ok = d.state === 'read' && !!e && d.metresPerUnit === 1 && d.layers.includes('WALL'); return { ok, detail: ok ? `Read a generated DXF: ${d.entities.length} entity on layer WALL, units metres.` : `Unexpected result: state ${d.state}, ${d.entities.length} entities.` }; }); add({ id: 'dxf-functional', tool: 'DXF', tier: 'functional', state: r.ok ? 'passed' : 'failed', label: 'Read DXF geometry', detail: r.detail, testedAt: now(), durationMs: r.ms, operation: 'Parse a generated DXF' }); }
  if (!tiers.has('accuracy')) add(NR('dxf-accuracy', 'DXF', 'accuracy', 'DXF measurement vs known geometry', 'Not run. Compares measured length and area of a generated 10 m x 4 m rectangle with the exact values.'));
  else { const r = await timed(async () => { const d = await readDxf('rect.dxf', RECT_DXF); const e = d.entities[0]; let len = e?.length ?? NaN; const area = e?.area ?? NaN; const ok = Math.abs(len - 28) < 1e-6 && Math.abs(area - 40) < 1e-6; return { ok, detail: `Measured perimeter ${len} m (exact 28) and area ${area} m² (exact 40) of a generated rectangle.`, metric: `length error ${Math.abs(len - 28).toExponential(1)} m, area error ${Math.abs(area - 40).toExponential(1)} m²` }; }); add({ id: 'dxf-accuracy', tool: 'DXF', tier: 'accuracy', state: r.ok ? 'passed' : 'failed', label: 'DXF measurement vs known geometry', detail: r.detail, metric: r.metric, testedAt: now(), durationMs: r.ms, operation: 'Compare measured length/area with exact values' }); }

  // ---------- DWG ----------
  const dwgLabel = 'DWG not processed: converter unavailable';
  if (!tiers.has('startup')) add(NR('dwg-startup', 'DWG', 'startup', 'DWG converter present', 'Not run.'));
  else if (c.remote) { const t = await testWorker(); const dep = (t.dependencies as { dwg?: { ok?: boolean; reason?: string; converter?: string; version?: string } } | undefined)?.dwg; add({ id: 'dwg-startup', tool: 'DWG', tier: 'startup', state: t.state !== 'passed' ? 'failed' : dep?.ok ? 'passed' : 'unavailable', label: 'DWG converter present (on worker)', detail: t.state !== 'passed' ? t.detail : dep?.ok ? `The worker reports converter ${dep.converter}${dep.version ? ` ${dep.version}` : ''} runs. This does NOT show that a DWG converts.` : `${dwgLabel}. Worker reachable, but ${dep?.reason ?? 'its converter is not usable'}.`, testedAt: t.testedAt, durationMs: t.durationMs, operation: 'Worker /health converter probe' }); }
  else if (!dwg.configured) add({ id: 'dwg-startup', tool: 'DWG', tier: 'startup', state: 'unavailable', label: 'DWG converter present', detail: `${dwgLabel}. ${dwg.reason} Deploy the processing worker (its image builds LibreDWG) or install a converter on this server. Until then DWG files are NOT analysed.`, testedAt: now(), operation: 'Check converter configuration' });
  else { const r = await timed(async () => { if (dwg.converter === 'libredwg') { const o = await runFile(dwg.path, ['--version'], { timeout: 10_000 }); return { ok: true, detail: `Executable runs: ${String(o.stdout || o.stderr).split('\n')[0]}. This does NOT show that a DWG converts.` }; } const { access } = await import('node:fs/promises'); await access(dwg.path); return { ok: true, detail: 'ODA executable exists. This does NOT show that a DWG converts.' }; }); add({ id: 'dwg-startup', tool: 'DWG', tier: 'startup', state: r.ok ? 'passed' : 'unavailable', label: 'DWG converter present', detail: r.ok ? r.detail : `${dwgLabel}. ${r.detail}`, testedAt: now(), durationMs: r.ms, operation: 'Run converter probe' }); }
  add(NR('dwg-functional', 'DWG', 'functional', 'Convert a real DWG', 'Not run. Requires a representative DWG sample file. POST it (as application/octet-stream) to the worker at /selftest/dwg with the worker token; the result reports the converter, DXF hash, warnings and coverage. No sample DWG is bundled, so this is never reported as passed without one.'));
  add(NR('dwg-accuracy', 'DWG', 'accuracy', 'DWG conversion fidelity', 'Not run. Needs a DWG with known quantities. Conversion fidelity is not established by the startup probe.'));

  // ---------- Scheduling ----------
  if (!tiers.has('startup')) add(NR('sched-startup', 'Scheduling', 'startup', 'Scheduling modules load', 'Not run.'));
  else { const r = await timed(async () => { await import('@/lib/mapping/xerParser'); await import('@/lib/assessment/cpmEngine'); return { ok: true, detail: 'The XER parser and CPM engine modules loaded. This does not show that a schedule was parsed or a critical path computed correctly.' }; }); add({ id: 'sched-startup', tool: 'Scheduling', tier: 'startup', state: r.ok ? 'passed' : 'failed', label: 'Scheduling modules load', detail: r.detail, testedAt: now(), durationMs: r.ms, operation: 'Import XER parser and CPM engine' }); }
  if (!tiers.has('functional')) add(NR('sched-functional', 'Scheduling', 'functional', 'Parse an XER file', 'Not run.'));
  else { const r = await timed(async () => { const { parseXer } = await import('@/lib/mapping/xerParser'); const xer = ['ERMHDR\t20.12\t2026-01-01\tProject', '%T\tPROJECT', '%F\tproj_id\tproj_short_name\tlast_recalc_date', '%R\t1\tTEST\t2026-01-01 00:00', '%T\tTASK', '%F\ttask_id\ttask_code\ttask_name\ttask_type\tstatus_code\ttarget_drtn_hr_cnt\tproj_id', '%R\t100\tA1000\tExcavate\tTT_Task\tTK_NotStart\t16\t1', '%R\t101\tA1010\tHandover\tTT_Mile\tTK_NotStart\t0\t1', '%T\tTASKPRED', '%F\ttask_pred_id\ttask_id\tpred_task_id\tpred_type\tlag_hr_cnt', '%R\t1\t101\t100\tPR_FS\t0', '%E'].join('\n'); const m = parseXer(xer, 't.xer'); const ok = m.activityCount === 2 && m.relationships.length === 1; return { ok, detail: ok ? 'Parsed a generated XER: 2 activities, 1 relationship. This is parsing only; it is not a CPM validation.' : `Unexpected: ${m.activityCount} activities, ${m.relationships.length} relationships.` }; }); add({ id: 'sched-functional', tool: 'Scheduling', tier: 'functional', state: r.ok ? 'passed' : 'failed', label: 'Parse an XER file', detail: r.detail, testedAt: now(), durationMs: r.ms, operation: 'Parse a generated XER' }); }
  if (!tiers.has('accuracy')) add(NR('sched-accuracy', 'Scheduling', 'accuracy', 'CPM against a hand-calculated network', 'Not run. Runs a 3-activity network with a known critical path and project duration.'));
  else { const r = await timed(async () => { const { calculateCpm } = await import('@/lib/assessment/cpmEngine'); const act = (id: string, d: number) => ({ id, name: id, type: 'task' as const, calendarId: 'std', remainingDuration: d, originalDuration: d }); const res = calculateCpm({ activities: [act('A', 5), act('B', 3), act('C', 2), act('D', 4)], relationships: [{ from: 'A', to: 'B', type: 'FS', lag: 0 }, { from: 'A', to: 'C', type: 'FS', lag: 0 }, { from: 'B', to: 'D', type: 'FS', lag: 0 }, { from: 'C', to: 'D', type: 'FS', lag: 0 }], calendars: [{ id: 'std', name: 'Mon-Fri', workDays: [1, 2, 3, 4, 5], holidays: [] }], dataDate: '2026-01-05', projectCalendarId: 'std', settings: { progressMode: 'retained_logic', resourceLevelling: false, criticalDefinition: 'total_float_lte_zero' } }); const path = res.criticalPath.join('>'); const cFloat = res.activities.C?.totalFloat; const ok = res.ok && path === 'A>B>D' && res.projectFinish === '2026-01-20' && cFloat === 1; return { ok, detail: `Hand-calculated network (A5, B3, C2, D4; Mon-Fri; start 5 Jan 2026). Expected critical path A>B>D, finish 2026-01-20, float of C = 1 day. Observed path ${path || 'none'}, finish ${res.projectFinish}, float of C = ${cFloat}.`, metric: ok ? 'critical path, finish date and float all match' : 'mismatch with hand calculation' }; }); add({ id: 'sched-accuracy', tool: 'Scheduling', tier: 'accuracy', state: r.ok ? 'passed' : 'failed', label: 'CPM against a hand-calculated network', detail: r.detail, metric: r.metric, testedAt: now(), durationMs: r.ms, operation: 'calculateCpm on a 4-activity network with known answer' }); }

  // ---------- Worker / queue ----------
  if (!c.url) add({ id: 'worker-startup', tool: 'Worker', tier: 'startup', state: 'not_configured', label: 'Processing worker connection', detail: 'PROCESSING_WORKER_URL is not set: the background worker is NOT connected. Accepted jobs are stored in the database queue but nothing will run them until a worker is deployed and connected.' });
  else if (!tiers.has('startup')) add(NR('worker-startup', 'Worker', 'startup', 'Processing worker connection', `Worker URL is set${c.token ? ' and a token is present' : ' but the token is missing'}. Connection not tested.`));
  else { const t = await testWorker(); add({ id: 'worker-startup', tool: 'Worker', tier: 'startup', state: t.state === 'passed' ? 'passed' : t.state === 'not_configured' ? 'not_configured' : 'failed', label: 'Processing worker connection', detail: t.detail, testedAt: t.testedAt, durationMs: t.durationMs, operation: 'GET /health and authenticated job lookup' }); }

  // ---------- AI ----------
  const ai = !!process.env.OPENAI_API_KEY && !/your-|YOUR_/.test(process.env.OPENAI_API_KEY ?? '');
  add({ id: 'ai-startup', tool: 'AI matching', tier: 'startup', state: ai ? 'not_run' : 'not_configured', label: 'AI key configured', detail: ai ? 'An OpenAI key is present on the server. No live call is made by this panel, so the key is not verified.' : 'No OpenAI key is configured. Matching uses the deterministic engine only.' });

  return NextResponse.json({ ran: [...tiers], checks }, { headers: { 'Cache-Control': 'no-store' } });
}

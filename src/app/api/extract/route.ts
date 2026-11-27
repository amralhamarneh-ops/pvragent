import { NextRequest, NextResponse } from 'next/server';
import { extractByExtension, MAX_BYTES, ocrLanguageOptions, scanRasterizerReady } from '@/lib/drawings/extractServer';
import { convertDwg, dwgStatus } from '@/lib/drawings/dwgConvert';
import { validateUpload, workerConfig, submitJob, getJob, cancelJob } from '@/lib/drawings/processingAdapter';
import { verifyUser } from '@/lib/boq/supabaseStore';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** GET -> which processors are really available here (used so the UI never overstates support). Reports capability, not a passed test. */
export async function GET() {
  const dwg = dwgStatus();
  const c = workerConfig();
  let ocr = false;
  try { ocrLanguageOptions(); ocr = true; } catch { /* no packaged or configured language data */ }
  const rasterizer = !c.remote && ocr && await scanRasterizerReady();
  return NextResponse.json({
    pdfText: true, docx: true, ocrImages: c.remote || ocr, ocrScannedPdf: c.remote || rasterizer,
    processing: c.remote ? 'remote_worker' : 'in_process',
    dwg: c.remote ? { configured: true, converter: 'remote worker (verify with the Processing Tools test)' } : dwg.configured ? { configured: true, converter: dwg.converter } : { configured: false, reason: dwg.reason, requirement: dwg.requirement },
  });
}

/**
 * POST multipart: file (required), caseId, runId. Streams newline-delimited JSON: progress events, then one `result` line.
 * Validates type, size and file signature. In remote mode the file is forwarded to the configured worker with a
 * server-held token; otherwise it is processed in this runtime. Nothing is sent to any third party converter.
 * Client disconnect cancels the work.
 */
export async function POST(req: NextRequest) {
  // Same identity rules as the case API; refuses requests when the server is not configured.
  let user: Awaited<ReturnType<typeof verifyUser>>;
  try { user = await verifyUser(req.headers.get('authorization'), process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY); }
  catch { return NextResponse.json({ error: 'The server is not configured to authorise this request.' }, { status: 503 }); }
  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: 'Expected multipart form data.' }, { status: 400 }); }
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'No file was sent.' }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: `File is larger than ${MAX_BYTES / 1048576} MB.` }, { status: 413 });
  const name = String(form.get('name') ?? file.name);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = (name.match(/\.([a-z0-9]+)$/i) ?? [])[1]?.toLowerCase() ?? '';
  const bad = validateUpload(name, bytes);
  if (bad && ["dwg", "pdf", "docx", "png", "jpg", "jpeg"].includes(ext)) return NextResponse.json({ error: bad }, { status: 415 });
  const caseId = String(form.get('caseId') ?? 'adhoc'); const runId = String(form.get('runId') ?? crypto.randomUUID());
  const enc = new TextEncoder();
  const aborted = () => req.signal.aborted;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => { try { controller.enqueue(enc.encode(`${JSON.stringify(o)}\n`)); } catch { /* client gone */ } };
      try {
        if (workerConfig().remote) {
          const job = await submitJob({ caseId, runId, fileName: name, bytes, userId: user.id });
          send({ type: 'progress', detail: `Submitted to the processing worker (job ${job.id.slice(0, 8)})` });
          for (;;) {
            if (aborted()) { await cancelJob(job.id); send({ type: 'result', ok: false, error: 'Cancelled.' }); break; }
            const r = await getJob(job.id, { withResult: true });
            if ('error' in r) { send({ type: 'result', ok: false, error: r.error }); break; }
            if (r.job.progress?.detail) send({ type: 'progress', detail: r.job.progress.detail });
            if (['completed', 'partial', 'failed', 'cancelled'].includes(r.job.state)) {
              const res = r.result as { kind?: string; ok?: boolean; error?: string; doc?: unknown; dxfBase64?: string; converter?: string; converterVersion?: string; sourceSha256?: string; dxfSha256?: string; warnings?: string[]; validation?: { issues: string[] } } | undefined;
              if (!res) send({ type: 'result', ok: false, error: r.job.error ?? `Job ${r.job.state}.` });
              else if (res.kind === 'dwg') send({ type: 'result', kind: 'dwg', ok: !!res.ok, error: res.error, converter: res.converter, dxfBase64: res.dxfBase64, conversion: { converter: res.converter, converterVersion: res.converterVersion, sourceSha256: res.sourceSha256, dxfSha256: res.dxfSha256, warnings: res.warnings ?? [], validationIssues: res.validation?.issues ?? [] } });
              else send({ type: 'result', kind: 'text', ok: !!res.ok, error: res.error, doc: toLegacyDoc(name, res.doc) });
              break;
            }
            await new Promise((x) => setTimeout(x, 700));
          }
        } else if (ext === 'dwg') {
          send({ type: 'progress', detail: 'Converting DWG to DXF with the configured converter' });
          const r = await convertDwg(bytes);
          if (!r.ok || !r.dxf) send({ type: 'result', kind: 'dwg', ok: false, error: r.error ?? 'Conversion failed.' });
          else send({ type: 'result', kind: 'dwg', ok: true, converter: r.converter, dxfBase64: Buffer.from(r.dxf).toString('base64'), conversion: { converter: r.converter, converterVersion: r.converterVersion, sourceSha256: r.sourceSha256, dxfSha256: r.dxfSha256, warnings: r.warnings ?? [] } });
        } else {
          const doc = await extractByExtension(name, bytes, (p) => { if (!aborted()) send({ type: 'progress', ...p, detail: `${p.method}: page ${p.page} of ${p.total} (${p.chars} characters)` }); });
          if (aborted()) send({ type: 'result', ok: false, error: 'Cancelled.' });
          else if (!doc) send({ type: 'result', kind: 'text', ok: false, error: `.${ext} is not a document format this service reads.` });
          else send({ type: 'result', kind: 'text', ok: doc.pages.some((p) => p.text.trim()), doc });
        }
      } catch (e) {
        send({ type: 'result', ok: false, error: e instanceof Error ? e.message : 'Extraction failed.' });
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/** Worker results carry per-unit status; convert to the ExtractedDocument shape the analysis already consumes, keeping the limitation text honest. */
function toLegacyDoc(name: string, doc: unknown) {
  const d = doc as { unitKind?: string; units?: { index: number; text: string; confidence?: number; status: string; reason?: string; method: string }[]; coverage?: { total: number; read: number; ocr: number; skipped: number; failed: number; note?: string } } | undefined;
  if (!d?.units) return doc;
  const cov = d.coverage; const notRead = d.units.filter((u) => u.status !== 'read');
  const limitation = [
    cov && cov.read < cov.total ? `${cov.total - cov.read} of ${cov.total} unit(s) were NOT read (${cov.skipped} skipped, ${cov.failed} failed): ${notRead.slice(0, 10).map((u) => `${u.index}${u.reason ? ` (${u.reason})` : ''}`).join('; ')}.` : '',
    cov?.note ?? '',
  ].filter(Boolean).join(' ');
  const hasOcr = d.units.some((u) => u.method === 'ocr' && u.status === 'read');
  return { name, method: d.unitKind === 'section' ? 'docx' : hasOcr ? 'ocr' : 'pdf-text', unitKind: d.unitKind === 'section' ? 'section' : 'page', pages: d.units.map((u) => ({ page: u.index, text: u.text, ...(u.confidence !== undefined ? { confidence: u.confidence } : {}) })), truncated: !!cov && cov.read < cov.total, limitation };
}

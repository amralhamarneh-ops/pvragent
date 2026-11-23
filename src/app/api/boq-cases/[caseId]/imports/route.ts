import { NextRequest, NextResponse } from 'next/server';
import { SupabaseRestStore, failureResponse, verifyUser } from '@/lib/boq/supabaseStore';
import { bodyBytes, MAX_BATCH_BYTES, type BatchPayload, type InitPayload } from '@/lib/boq/importBatches';

export const dynamic = 'force-dynamic';

const URL_ = () => process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY_ = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function fail(e: unknown) {
  const f = failureResponse(e);
  return NextResponse.json(f.body, { status: f.status });
}

async function storeFor(req: NextRequest): Promise<SupabaseRestStore> {
  const user = await verifyUser(req.headers.get('authorization'), URL_(), KEY_());
  return new SupabaseRestStore(URL_(), KEY_(), user);
}

/** Read the body as text and refuse anything above the batch ceiling with a message the client can act on. */
async function readLimited(req: NextRequest): Promise<{ text: string } | { response: NextResponse }> {
  const text = await req.text();
  const n = bodyBytes(text);
  if (n > MAX_BATCH_BYTES) {
    // Size only. No document contents are logged.
    console.error('[boq-import]', JSON.stringify({ op: 'request_too_large', bytes: n, limit: MAX_BATCH_BYTES }));
    return { response: NextResponse.json({ error: `This request is ${n} bytes, above the ${MAX_BATCH_BYTES}-byte batch limit.`, blocker: 'batch_too_large', bytes: n, limit: MAX_BATCH_BYTES }, { status: 413 }) };
  }
  return { text };
}

/**
 * POST { action: 'init' | 'batch' | 'finalize' }
 *  - init:     metadata only (no rows). Idempotent for the same import id and checksum.
 *  - batch:    one bounded batch of rows with a stable id and checksum. Idempotent.
 *  - finalize: verifies completeness and publishes atomically.
 * Every action enforces case ownership. Every response is a small acknowledgement, never the BOQ.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await ctx.params;
    const read = await readLimited(req);
    if ('response' in read) return read.response;
    const s = await storeFor(req);
    let body: { action?: string; init?: InitPayload; batch?: BatchPayload; importId?: string; importChecksum?: string };
    try { body = JSON.parse(read.text); } catch { return NextResponse.json({ error: 'The request body is not valid JSON.' }, { status: 400 }); }

    if (body.action === 'init') {
      const p = body.init;
      if (!p || typeof p.importId !== 'string' || !Number.isInteger(p.expectedRows) || !Number.isInteger(p.expectedBatches) || p.expectedRows < 0 || p.expectedBatches < 0 || !/^[a-f0-9]{64}$/.test(p.importChecksum ?? '') || !p.meta || typeof p.meta.sha256 !== 'string') return NextResponse.json({ error: 'The import header is malformed.' }, { status: 400 });
      return NextResponse.json(await s.initImport(caseId, p));
    }
    if (body.action === 'batch') {
      if (!body.batch) return NextResponse.json({ error: 'The batch is missing.' }, { status: 400 });
      return NextResponse.json(await s.saveImportBatch(caseId, body.batch));
    }
    if (body.action === 'finalize') {
      if (!body.importId || !/^[a-f0-9]{64}$/.test(body.importChecksum ?? '')) return NextResponse.json({ error: 'importId and importChecksum are required.' }, { status: 400 });
      const r = await s.finalizeImport(caseId, body.importId, body.importChecksum as string);
      return NextResponse.json(r, { status: r.ok ? 200 : 409 });
    }
    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
  } catch (e) {
    return fail(e);
  }
}

/** GET ?importId=: small progress for resume (saved batch ids and counts). Owner only. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await ctx.params;
    const importId = req.nextUrl.searchParams.get('importId') ?? '';
    if (!importId) return NextResponse.json({ error: 'importId is required.' }, { status: 400 });
    const s = await storeFor(req);
    return NextResponse.json(await s.getImportStatus(caseId, importId));
  } catch (e) {
    return fail(e);
  }
}

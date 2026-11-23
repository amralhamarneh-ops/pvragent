import { NextRequest, NextResponse } from 'next/server';
import { SupabaseRestStore, failureResponse, verifyUser } from '@/lib/boq/supabaseStore';

export const dynamic = 'force-dynamic';

const URL_ = () => process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY_ = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const MAX_BYTES = 25 * 1024 * 1024;

function fail(e: unknown) {
  const f = failureResponse(e);
  return NextResponse.json(f.body, { status: f.status });
}

async function storeFor(req: NextRequest): Promise<SupabaseRestStore> {
  const user = await verifyUser(req.headers.get('authorization'), URL_(), KEY_());
  return new SupabaseRestStore(URL_(), KEY_(), user);
}

/**
 * POST: store the ORIGINAL uploaded file in the private bucket under <user>/<case>/... .
 * Body is the raw file bytes. Query: importId, fileName, sha256. The server recomputes the SHA-256 and refuses a mismatch,
 * so the stored object is provably the file whose hash the import records.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await ctx.params;
    const s = await storeFor(req);
    const q = req.nextUrl.searchParams;
    const importId = q.get('importId') ?? '';
    const fileName = q.get('fileName') ?? '';
    const claimed = (q.get('sha256') ?? '').toLowerCase();
    if (!importId || !fileName || !/^[a-f0-9]{64}$/.test(claimed)) return NextResponse.json({ error: 'importId, fileName and a 64-character sha256 are required.' }, { status: 400 });
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength === 0) return NextResponse.json({ error: 'The file is empty.' }, { status: 400 });
    if (bytes.byteLength > MAX_BYTES) return NextResponse.json({ error: 'The file is larger than the 25 MB limit.' }, { status: 413 });
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const actual = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    if (actual !== claimed) return NextResponse.json({ error: 'The uploaded bytes do not match the recorded SHA-256. Nothing was stored.' }, { status: 422 });
    // Reuse an already-stored original (verified by case, owner and hash) instead of creating a second object.
    const reused = await s.existingOriginal(caseId, importId, actual);
    if (reused) return NextResponse.json({ storagePath: reused.storagePath, uploadedAt: reused.uploadedAt, sha256: actual, reused: true });
    try {
      const path = await s.uploadOriginal(caseId, importId, fileName, bytes, req.headers.get('content-type') ?? 'application/octet-stream');
      return NextResponse.json({ storagePath: path, uploadedAt: new Date().toISOString(), sha256: actual });
    } catch (e) {
      // The object path is deterministic per import id. If an earlier attempt already wrote these exact bytes (the
      // route verified the hash above), reuse that object rather than failing the retry.
      if (e instanceof Error && /already stored/i.test(e.message)) {
        return NextResponse.json({ storagePath: s.storagePathFor(caseId, importId, fileName), uploadedAt: new Date().toISOString(), sha256: actual, reused: true });
      }
      throw e;
    }
  } catch (e) {
    return fail(e);
  }
}

/** GET ?importId=: a short-lived signed URL for evidence review. Owner only. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await ctx.params;
    const importId = req.nextUrl.searchParams.get('importId') ?? '';
    if (!importId) return NextResponse.json({ error: 'importId is required.' }, { status: 400 });
    const s = await storeFor(req);
    const link = await s.signedOriginalUrl(caseId, importId);
    return NextResponse.json(link);
  } catch (e) {
    return fail(e);
  }
}

/** PATCH: record that the stored file now exists for an import that was already saved. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await ctx.params;
    const s = await storeFor(req);
    const body = (await req.json()) as { importId?: string; storagePath?: string; uploadedAt?: string };
    if (!body.importId || !body.storagePath || !body.uploadedAt) return NextResponse.json({ error: 'importId, storagePath and uploadedAt are required.' }, { status: 400 });
    await s.markFileStored(caseId, body.importId, body.storagePath, body.uploadedAt);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

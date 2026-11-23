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

function safeMeta(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k.slice(0, 40), String(v).slice(0, 200)]));
  } catch { return {}; }
}

async function storeFor(req: NextRequest): Promise<SupabaseRestStore> {
  const user = await verifyUser(req.headers.get('authorization'), URL_(), KEY_());
  return new SupabaseRestStore(URL_(), KEY_(), user);
}

/** GET: the case's active document registry (metadata). With ?docId= returns that document's bytes; with ?docId=&link=1 a short-lived signed URL. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await ctx.params;
    const s = await storeFor(req);
    const docId = req.nextUrl.searchParams.get('docId');
    if (docId && req.nextUrl.searchParams.get('link') === '1') {
      return NextResponse.json(await s.signedDocumentUrl(caseId, docId));
    }
    if (docId) {
      const f = await s.readDocument(caseId, docId);
      const body = new Uint8Array(f.bytes.byteLength);
      body.set(f.bytes);
      return new NextResponse(body, { headers: { 'Content-Type': 'application/octet-stream', 'X-Doc-Sha256': f.sha256, 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json({ documents: await s.listDocuments(caseId) });
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST: store one document's actual bytes. Query: docId, path, name, role, sha256, version.
 * The server recomputes the SHA-256 and refuses a mismatch, so the stored object is provably the registered file.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await ctx.params;
    const s = await storeFor(req);
    const q = req.nextUrl.searchParams;
    const meta = { id: q.get('docId') ?? '', path: q.get('path') ?? '', name: q.get('name') ?? '', role: q.get('role') ?? 'unused', sha256: (q.get('sha256') ?? '').toLowerCase(), version: Number(q.get('version') ?? '1') || 1 };
    if (!meta.id || !meta.path || !meta.name || !/^[a-f0-9]{64}$/.test(meta.sha256)) return NextResponse.json({ error: 'docId, path, name and a 64-character sha256 are required.' }, { status: 400 });
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength === 0) return NextResponse.json({ error: 'The file is empty.' }, { status: 400 });
    if (bytes.byteLength > MAX_BYTES) return NextResponse.json({ error: 'The file is larger than the 25 MB limit.' }, { status: 413 });
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const actual = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    if (actual !== meta.sha256) return NextResponse.json({ error: 'The uploaded bytes do not match the registered SHA-256. Nothing was stored.' }, { status: 422 });
    const rec = await s.storeDocument(caseId, { ...meta, subrole: q.get('subrole') ?? '', manual: q.get('manual') === '1', metadata: safeMeta(q.get('metadata')) }, bytes, req.headers.get('x-original-type') ?? 'application/octet-stream');
    return NextResponse.json({ document: rec });
  } catch (e) {
    return fail(e);
  }
}

/** PATCH: change a document's category (with audit history), sub-role and metadata, or its processing state. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await ctx.params;
    const s = await storeFor(req);
    const b = (await req.json()) as { docId?: string; role?: string; subrole?: string; metadata?: Record<string, string>; manual?: boolean; state?: string; stateDetail?: string; markStale?: string };
    if (!b.docId) return NextResponse.json({ error: 'docId is required.' }, { status: 400 });
    if (b.role && b.manual) await s.reclassifyDocument(caseId, b.docId, { role: b.role, subrole: b.subrole, metadata: b.metadata });
    else if (b.role) await s.setDocumentRole(caseId, b.docId, b.role);
    if (b.state) await s.setDocumentState(caseId, b.docId, b.state, b.stateDetail ?? '');
    if (b.markStale) await s.markEvidenceStale(caseId, b.markStale);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

/**
 * DELETE: remove documents from THIS PVR only. Body: { docIds: string[], reason?: string, replacedBy?: string }.
 * Rows are unlinked (soft removal) and the stored originals are kept, because other cases, libraries or historical
 * assessment versions may still reference them. The case's current analysis evidence is marked stale.
 * Returns the ids actually unlinked so the client can tell a partial failure from success.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await ctx.params;
    const s = await storeFor(req);
    const b = (await req.json().catch(() => ({}))) as { docIds?: string[]; reason?: string; replacedBy?: string };
    const ids = Array.isArray(b.docIds) ? b.docIds.filter((i) => typeof i === 'string' && i.length > 0) : [];
    if (ids.length === 0) return NextResponse.json({ error: 'docIds is required.' }, { status: 400 });
    const removed = await s.unlinkDocuments(caseId, ids, b.replacedBy);
    if (removed.length > 0) await s.markEvidenceStale(caseId, b.reason ?? 'Documents were removed from this PVR.');
    return NextResponse.json({ removed, requested: ids.length });
  } catch (e) {
    return fail(e);
  }
}

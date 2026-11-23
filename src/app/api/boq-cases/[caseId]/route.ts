import { NextRequest, NextResponse } from 'next/server';
import { SupabaseRestStore, failureResponse, verifyUser } from '@/lib/boq/supabaseStore';
import type { BoqImport } from '@/lib/boq/types';
import { bodyBytes, MAX_BATCH_BYTES } from '@/lib/boq/importBatches';

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

function validImport(x: unknown, caseId: string): x is BoqImport {
  const i = x as BoqImport;
  return !!i && typeof i.id === 'string' && i.caseId === caseId && typeof i.revision === 'number' && !!i.source && typeof i.source.sha256 === 'string' && Array.isArray(i.rows) && Array.isArray(i.mappings);
}

/**
 * GET: the case and SMALL import summaries (no rows), only for its owner. Anyone else gets 404, so ids cannot be probed.
 * Rows are loaded separately through the paginated /imports/[importId]/rows endpoint, so this response stays small
 * however large the BOQ is. Pending (incomplete) imports are listed with status 'pending' so a save can be resumed.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await ctx.params;
    const s = await storeFor(req);
    const c = await s.getCase(caseId);
    if (!c) return NextResponse.json({ error: `Case ${caseId} was not found.`, blocker: 'not_found' }, { status: 404 });
    const summaries = await s.listImportSummaries(caseId);
    return NextResponse.json({ case: c, summaries });
  } catch (e) {
    return fail(e);
  }
}

/**
 * PUT: legacy single-request save, kept only for small imports. A body larger than one batch is refused with a clear
 * message that points to the staged import, instead of failing at the hosting gateway.
 */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await ctx.params;
    const s = await storeFor(req);
    const raw = await req.text();
    if (bodyBytes(raw) > MAX_BATCH_BYTES) return NextResponse.json({ error: 'This import is too large for one request. Use the staged import (initialise, batches, finalise).', blocker: 'use_staged_import' }, { status: 413 });
    const body = JSON.parse(raw) as { import?: unknown };
    if (!validImport(body.import, caseId)) return NextResponse.json({ error: 'The import is malformed or belongs to another case.' }, { status: 400 });
    const saved = await s.saveImport(body.import);
    return NextResponse.json({ import: { id: saved.id, revision: saved.revision, rows: saved.rows.length } });
  } catch (e) {
    return fail(e);
  }
}

/** PATCH: explicitly select which confirmed, COMPLETE import revision calculations use. Owner only. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await ctx.params;
    const s = await storeFor(req);
    const body = (await req.json()) as { selectImportId?: string };
    if (!body.selectImportId) return NextResponse.json({ error: 'selectImportId is required.' }, { status: 400 });
    const c = await s.selectImport(caseId, body.selectImportId);
    return NextResponse.json({ case: c });
  } catch (e) {
    return fail(e);
  }
}

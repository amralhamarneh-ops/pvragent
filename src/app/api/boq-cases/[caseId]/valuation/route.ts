import { NextRequest, NextResponse } from 'next/server';
import { SupabaseRestStore, failureResponse, verifyUser } from '@/lib/boq/supabaseStore';

export const dynamic = 'force-dynamic';

const URL_ = () => process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY_ = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const MAX_BYTES = 2_000_000;

function fail(e: unknown) {
  const f = failureResponse(e);
  return NextResponse.json(f.body, { status: f.status });
}

async function storeFor(req: NextRequest): Promise<SupabaseRestStore> {
  const user = await verifyUser(req.headers.get('authorization'), URL_(), KEY_());
  return new SupabaseRestStore(URL_(), KEY_(), user);
}

/** GET: the persisted valuation state (decisions, items, groups, fingerprint, stale flag) for a case the caller owns. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await ctx.params;
    const s = await storeFor(req);
    return NextResponse.json({ valuation: await s.getValuation(caseId) });
  } catch (e) {
    return fail(e);
  }
}

/** PUT: save valuation state. A save made against an outdated version is rejected, never merged over newer decisions. */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await ctx.params;
    const raw = await req.text();
    if (raw.length > MAX_BYTES) return NextResponse.json({ error: 'The valuation state is too large to save.' }, { status: 413 });
    let b: { decisions?: unknown; items?: unknown; groups?: unknown; replacements?: unknown; fingerprint?: unknown; stale?: boolean; staleReasons?: unknown; expectedVersion?: number };
    try { b = JSON.parse(raw); } catch { return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 }); }
    if (b.decisions !== undefined && (typeof b.decisions !== 'object' || b.decisions === null || Array.isArray(b.decisions))) return NextResponse.json({ error: 'decisions must be an object.' }, { status: 400 });
    for (const k of ['items', 'groups', 'replacements'] as const) if (b[k] !== undefined && !Array.isArray(b[k])) return NextResponse.json({ error: `${k} must be a list.` }, { status: 400 });
    const s = await storeFor(req);
    const saved = await s.saveValuation(caseId, {
      decisions: b.decisions as Record<string, unknown> | undefined, items: b.items as unknown[] | undefined, groups: b.groups as unknown[] | undefined, replacements: b.replacements as unknown[] | undefined,
      fingerprint: b.fingerprint, stale: b.stale, staleReasons: Array.isArray(b.staleReasons) ? (b.staleReasons as unknown[]).filter((x): x is string => typeof x === 'string') : undefined,
    }, typeof b.expectedVersion === 'number' ? b.expectedVersion : undefined);
    return NextResponse.json({ valuation: saved });
  } catch (e) {
    if (e instanceof Error && /changed elsewhere/.test(e.message)) return NextResponse.json({ error: e.message, blocker: 'version_conflict' }, { status: 409 });
    return fail(e);
  }
}

/** PATCH: mark the saved valuation stale because an input (BOQ, scope, mapping, documents) changed. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await ctx.params;
    let b = (await req.json()) as { reasons?: unknown };
    const reasons = Array.isArray(b.reasons) ? (b.reasons as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 8) : [];
    const s = await storeFor(req);
    await s.markValuationStale(caseId, reasons);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { SupabaseRestStore, failureResponse, verifyUser } from '@/lib/boq/supabaseStore';

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

/** GET: the persisted evidence for the case (original narrative, structured handoff, applied answers). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await ctx.params;
    const s = await storeFor(req);
    return NextResponse.json({ evidence: await s.getEvidence(caseId) });
  } catch (e) {
    return fail(e);
  }
}

/** PUT: save evidence. The original narrative is stored exactly as typed; it is never replaced by a generated summary. */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await ctx.params;
    const s = await storeFor(req);
    const b = (await req.json()) as { narrative?: string; handoff?: unknown; answers?: Record<string, string> };
    if (b.narrative !== undefined && typeof b.narrative !== 'string') return NextResponse.json({ error: 'narrative must be text.' }, { status: 400 });
    if (b.narrative && b.narrative.length > 200_000) return NextResponse.json({ error: 'The narrative is too long.' }, { status: 413 });
    const saved = await s.saveEvidence(caseId, { narrative: b.narrative, handoff: b.handoff, answers: b.answers });
    return NextResponse.json({ evidence: saved });
  } catch (e) {
    return fail(e);
  }
}

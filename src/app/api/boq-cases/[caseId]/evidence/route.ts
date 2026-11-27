import { hasReplaySources, readSavedDrawingReplay } from '@/lib/drawings/replay';
import { readMatchSnapshot } from '@/lib/boq/matchSnapshot';
import { NextRequest, NextResponse } from 'next/server';
import { SupabaseRestStore, failureResponse, GUEST_USER_ID, verifyUser } from '@/lib/boq/supabaseStore';

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
    const b = (await req.json()) as { narrative?: string; handoff?: unknown; answers?: Record<string, string>; matchSnapshot?: string };
    if (b.narrative !== undefined && typeof b.narrative !== 'string') return NextResponse.json({ error: 'narrative must be text.' }, { status: 400 });
    if (b.narrative && b.narrative.length > 200_000) return NextResponse.json({ error: 'The narrative is too long.' }, { status: 413 });
    if (b.matchSnapshot !== undefined && !readMatchSnapshot(b.matchSnapshot)) return NextResponse.json({ error: 'Invalid BOQ match snapshot.' }, { status: 400 });
    const user = await verifyUser(req.headers.get('authorization'), URL_(), KEY_());
    if (b.matchSnapshot !== undefined && user.id === GUEST_USER_ID) return NextResponse.json({ error: 'Sign in to save the BOQ match preview privately.' }, { status: 401 });
    let handoff = b.handoff;
    if (hasReplaySources(handoff)) {
      const { drawingReplay, ...rest } = handoff;
      const replay = user.id === GUEST_USER_ID ? null : readSavedDrawingReplay(drawingReplay);
      handoff = replay ? { ...rest, drawingReplay: replay } : rest;
    }
    const s = new SupabaseRestStore(URL_(), KEY_(), user);
    const saved = await s.saveEvidence(caseId, { narrative: b.narrative, handoff, answers: b.answers, matchSnapshot: b.matchSnapshot });
    return NextResponse.json({ evidence: saved });
  } catch (e) {
    return fail(e);
  }
}

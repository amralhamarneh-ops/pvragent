import { NextRequest, NextResponse } from 'next/server';
import { SupabaseRestStore, failureResponse, verifyUser } from '@/lib/boq/supabaseStore';
import type { SavedCalculation } from '@/lib/boq/revisions';

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

function validCalc(x: unknown, caseId: string): x is SavedCalculation {
  const c = x as SavedCalculation;
  return !!c && typeof c.id === 'string' && c.caseId === caseId && typeof c.importId === 'string' && typeof c.signedAmount === 'string' && typeof c.itemId === 'string' && typeof c.importRevision === 'number' && !!c.conversion;
}

/** GET: saved calculations for a case the caller owns. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await ctx.params;
    const s = await storeFor(req);
    return NextResponse.json({ calculations: await s.listCalculations(caseId) });
  } catch (e) {
    return fail(e);
  }
}

/** POST: save a new calculation as immutable evidence. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await ctx.params;
    const s = await storeFor(req);
    const body = (await req.json()) as { calculation?: unknown };
    if (!validCalc(body.calculation, caseId)) return NextResponse.json({ error: 'The calculation is malformed or belongs to another case.' }, { status: 400 });
    return NextResponse.json({ calculation: await s.saveCalculation(body.calculation) });
  } catch (e) {
    return fail(e);
  }
}

/** PATCH: mark a calculation as reviewed against the selected import. Numbers are never changed. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await ctx.params;
    const s = await storeFor(req);
    const body = (await req.json()) as { calculationId?: string; importId?: string };
    if (!body.calculationId || !body.importId) return NextResponse.json({ error: 'calculationId and importId are required.' }, { status: 400 });
    await s.markCalculationReviewed(caseId, body.calculationId, body.importId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

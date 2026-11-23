import { NextRequest, NextResponse } from 'next/server';
import { SupabaseRestStore, failureResponse, verifyUser } from '@/lib/boq/supabaseStore';
import { newCase } from '@/lib/boq/store';

export const dynamic = 'force-dynamic';

const URL_ = () => process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY_ = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function fail(e: unknown) {
  const f = failureResponse(e);
  return NextResponse.json(f.body, { status: f.status });
}

/** GET: storage + session health. Requires a signed-in user; reports the exact blocker otherwise. */
export async function GET(req: NextRequest) {
  try {
    const user = await verifyUser(req.headers.get('authorization'), URL_(), KEY_());
    const s = new SupabaseRestStore(URL_(), KEY_(), user);
    await s.getCase('__health_check__');
    return NextResponse.json({ ok: true, storage: 'supabase', signedInAs: user.email });
  } catch (e) {
    return fail(e);
  }
}

/** POST: create a real case owned by the verified user. The owner always comes from the session, never the body. */
export async function POST(req: NextRequest) {
  try {
    const user = await verifyUser(req.headers.get('authorization'), URL_(), KEY_());
    const body = (await req.json()) as { title?: string; currency?: string };
    const title = (body.title ?? '').trim() || 'Untitled PVR';
    const currency = (body.currency ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return NextResponse.json({ error: 'Currency must be a three-letter code, for example AED.' }, { status: 400 });
    const created = await new SupabaseRestStore(URL_(), KEY_(), user).createCase(newCase(title.slice(0, 200), currency));
    return NextResponse.json({ case: created });
  } catch (e) {
    return fail(e);
  }
}

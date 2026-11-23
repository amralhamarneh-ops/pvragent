import { NextRequest, NextResponse } from 'next/server';
import { SupabaseRestStore, failureResponse, verifyUser } from '@/lib/boq/supabaseStore';

export const dynamic = 'force-dynamic';

const URL_ = () => process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY_ = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** GET ?offset=&limit=: one page of a COMPLETE import's rows, ordered by sheet then row number. Owner only. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ caseId: string; importId: string }> }) {
  try {
    const { caseId, importId } = await ctx.params;
    const user = await verifyUser(req.headers.get('authorization'), URL_(), KEY_());
    const s = new SupabaseRestStore(URL_(), KEY_(), user);
    const q = req.nextUrl.searchParams;
    const page = await s.listImportRows(caseId, importId, Number(q.get('offset') ?? 0), Number(q.get('limit') ?? 500));
    return NextResponse.json(page);
  } catch (e) {
    const f = failureResponse(e);
    return NextResponse.json(f.body, { status: f.status });
  }
}

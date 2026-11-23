import { NextRequest, NextResponse } from 'next/server';
import { failureResponse, verifyUser } from '@/lib/boq/supabaseStore';
import { ReferenceStore } from '@/lib/reference/referenceStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET ?sourceId=: a short-lived signed link to inspect a preserved source file. Owner only. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const sourceId = req.nextUrl.searchParams.get('sourceId') ?? '';
    if (!sourceId) return NextResponse.json({ error: 'sourceId is required.' }, { status: 400 });
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const user = await verifyUser(req.headers.get('authorization'), url, key);
    return NextResponse.json(await new ReferenceStore(url, key, user).signedSourceUrl(id, sourceId));
  } catch (e) {
    const f = failureResponse(e);
    return NextResponse.json(f.body, { status: f.status });
  }
}

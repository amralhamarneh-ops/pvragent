import { NextRequest, NextResponse } from 'next/server';
import { classifyFiles, type IncomingFile } from '@/lib/intake/triage';

/** Server-side triage: classify files by role, group sets, find PVRs. Content is treated as data. */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { files?: IncomingFile[] };
    const files = Array.isArray(body.files) ? body.files.slice(0, 2000) : [];
    // An empty list is valid: the user may describe the change in text only.
    return NextResponse.json(classifyFiles(files));
  } catch (error) {
    return NextResponse.json({ error: 'Could not read the upload', details: error instanceof Error ? error.message : 'Unknown error' }, { status: 400 });
  }
}

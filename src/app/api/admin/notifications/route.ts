import { GET as notifyGet, POST as notifyPost } from '../notify/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// This route moved to /api/admin/notify. Kept as a thin delegate so nothing references a missing handler.
export const GET = notifyGet;
export const POST = notifyPost;

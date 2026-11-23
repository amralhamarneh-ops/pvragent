import { NextRequest, NextResponse } from 'next/server';
import { failureResponse, verifyUser } from '@/lib/boq/supabaseStore';
import { ReferenceStore } from '@/lib/reference/referenceStore';
import { newDraft } from '@/lib/reference/demo';
import { missingEvidence, partitionMoveBlock, transition, withdraw, checkLeakage } from '@/lib/reference/lifecycle';
import { retrieveReferences, precedentPromptBlock } from '@/lib/reference/retrieve';
import { runEvaluation } from '@/lib/reference/evaluate';
import type { CurrentContext, LearningRecord, PipelineOutput, ReferenceCase, ReferencePartition, ReferenceSource, SourceRole } from '@/lib/reference/types';
import { SOURCE_ROLES } from '@/lib/reference/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const URL_ = () => process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY_ = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const MAX_BYTES = 25 * 1024 * 1024;

function fail(e: unknown) { const f = failureResponse(e); return NextResponse.json(f.body, { status: f.status }); }
async function storeFor(req: NextRequest) { const user = await verifyUser(req.headers.get('authorization'), URL_(), KEY_()); return new ReferenceStore(URL_(), KEY_(), user); }
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** Strip contact details from free text before it is stored in a learning record. */
function minimise(s: string): string {
  return s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]').replace(/\+?\d[\d\s().-]{8,}\d/g, '[phone]').slice(0, 2000);
}
function minimiseRecord(r: LearningRecord): LearningRecord {
  const m = (s: string) => minimise(String(s ?? ''));
  return { ...r, changeType: m(r.changeType), workType: m(r.workType), location: m(r.location), projectContext: m(r.projectContext), reasoning: m(r.reasoning), assumptions: (r.assumptions ?? []).map(m), specifications: (r.specifications ?? []).map(m), corrections: (r.corrections ?? []).map((c) => ({ field: m(c.field), was: m(c.was), shouldBe: m(c.shouldBe), why: m(c.why) })) };
}

/** GET: the library, plus recent evaluation runs. Only the caller's own cases are returned. */
export async function GET(req: NextRequest) {
  try {
    const s = await storeFor(req);
    const cases = await s.list();
    const evaluations = await s.listEvaluations().catch(() => []);
    return NextResponse.json({ cases, evaluations, leakage: checkLeakage(cases) });
  } catch (e) { return fail(e); }
}

/**
 * POST { action, ... }:
 *  create | updateRecord | transition | withdraw | movePartition | retrieve | evaluate
 * Human corrections stay on the case; they never change global rules, rates or quantities.
 */
export async function POST(req: NextRequest) {
  try {
    const s = await storeFor(req);
    const body = (await req.json()) as Record<string, unknown>;
    const action = String(body.action ?? '');
    const now = new Date().toISOString();

    if (action === 'create') {
      const title = String(body.title ?? '').trim(); if (!title) return bad('A title is required.');
      const id = `ref-${crypto.randomUUID().slice(0, 8)}`;
      const group = String(body.caseGroup ?? '').trim() || id;
      const existing = (await s.list()).filter((c) => c.caseGroup === group);
      const draft = newDraft(id, minimise(title), group, now, String(body.reviewer ?? 'Admin'));
      draft.version = existing.reduce((m, c) => Math.max(m, c.version), 0) + 1;
      draft.partition = existing[0]?.partition ?? 'learning';
      return NextResponse.json({ case: await s.save(draft) });
    }

    if (action === 'updateRecord') {
      const c = await s.get(String(body.id));
      if (c.status === 'approved' || c.status === 'retired') return bad('An approved or retired case cannot be edited. Create a new version instead.', 409);
      const next: ReferenceCase = { ...c, title: body.title ? minimise(String(body.title)) : c.title, record: minimiseRecord(body.record as LearningRecord), missingEvidence: missingEvidence(c.sources), updatedAt: now, reviewHistory: [...c.reviewHistory, { at: now, action: 'edited', reviewer: String(body.reviewer ?? 'Admin'), version: c.version, note: 'Learning record edited.', evidence: [] }] };
      return NextResponse.json({ case: await s.save(next) });
    }

    if (action === 'transition') {
      const c = await s.get(String(body.id));
      const r = transition(c, { to: body.to as ReferenceCase['status'], reviewer: String(body.reviewer ?? ''), note: String(body.note ?? ''), evidence: Array.isArray(body.evidence) ? (body.evidence as unknown[]).map(String) : [], at: now });
      if (!r.ok || !r.next) return bad(r.error ?? 'Not allowed.', 409);
      return NextResponse.json({ case: await s.save({ ...r.next, missingEvidence: missingEvidence(c.sources) }) });
    }

    if (action === 'withdraw') {
      const c = await s.get(String(body.id));
      const r = withdraw(c, String(body.reviewer ?? ''), String(body.reason ?? ''), now, body.replacedBy ? String(body.replacedBy) : null);
      if (!r.ok || !r.next) return bad(r.error ?? 'Not allowed.', 409);
      return NextResponse.json({ case: await s.save(r.next) });
    }

    if (action === 'movePartition') {
      const all = await s.list(); const id = String(body.id); const to = body.to as ReferencePartition;
      if (to !== 'learning' && to !== 'evaluation') return bad('Unknown partition.');
      const block = partitionMoveBlock(all, id, to); if (block) return bad(block, 409);
      const group = all.find((c) => c.id === id)?.caseGroup;
      for (const c of all.filter((x) => x.caseGroup === group)) await s.save({ ...c, partition: to, updatedAt: now, reviewHistory: [...c.reviewHistory, { at: now, action: 'moved_partition', reviewer: String(body.reviewer ?? 'Admin'), version: c.version, note: `Moved to ${to} set.`, evidence: [] }] });
      return NextResponse.json({ cases: await s.list() });
    }

    if (action === 'retrieve') {
      const q = body.query as CurrentContext;
      if (!q || typeof q !== 'object') return bad('A query is required.');
      const result = retrieveReferences(await s.list(), q, { includeIneligible: !!body.includeIneligible });
      return NextResponse.json({ result, promptBlock: precedentPromptBlock(result) });
    }

    if (action === 'evaluate') {
      const outputs = Array.isArray(body.outputs) ? (body.outputs as PipelineOutput[]) : [];
      const run = runEvaluation(await s.list(), outputs, String(body.actualSource ?? 'pipeline output supplied with the request'), now, `eval-${crypto.randomUUID().slice(0, 8)}`);
      await s.saveEvaluation(run).catch(() => undefined);
      return NextResponse.json({ run });
    }

    return bad('Unknown action.');
  } catch (e) { return fail(e); }
}

/**
 * PUT multipart: id, role, file, sha256 (optional). Preserves the original file in the private bucket with its hash,
 * reads text with the existing extractor where supported, and registers provenance. Identical content is reused.
 * Nothing is sent to any external training service.
 */
export async function PUT(req: NextRequest) {
  try {
    const s = await storeFor(req);
    const form = await req.formData();
    const id = String(form.get('id') ?? ''); const role = String(form.get('role') ?? '') as SourceRole; const file = form.get('file');
    if (!id || !(file instanceof File)) return bad('id and file are required.');
    if (!SOURCE_ROLES.some((r) => r.role === role)) return bad('Unknown source role.');
    if (file.size === 0) return bad('The file is empty.');
    if (file.size > MAX_BYTES) return bad('The file is larger than the 25 MB limit.', 413);
    const c = await s.get(id);
    if (c.status === 'approved' || c.status === 'retired') return bad('Sources cannot be added to an approved or retired case. Create a new version.', 409);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    const claimed = String(form.get('sha256') ?? '').toLowerCase();
    if (claimed && claimed !== sha) return bad('The uploaded bytes do not match the recorded SHA-256. Nothing was stored.', 422);

    // Read with the existing extractor. Unsupported types are recorded as not read, never silently skipped.
    let readStatus: ReferenceSource['readStatus'] = 'not_read'; let readDetail = 'Stored as an original file; this type is not read by the text extractor.'; let excerpt = '';
    const ext = (file.name.match(/\.([a-z0-9]+)$/i) ?? [])[1]?.toLowerCase() ?? '';
    try {
      if (['pdf', 'docx', 'png', 'jpg', 'jpeg'].includes(ext)) {
        const { extractByExtension } = await import('@/lib/drawings/extractServer');
        const doc = await extractByExtension(file.name, bytes);
        if (doc) { const text = doc.pages.map((p) => p.text).join('\n'); excerpt = text.slice(0, 4000); readStatus = doc.truncated ? 'partial' : text.trim() ? 'read' : 'partial'; readDetail = doc.limitation || `Read ${doc.pages.length} ${doc.unitKind ?? 'page'}(s) by ${doc.method}.`; }
      } else if (['csv', 'txt', 'xer'].includes(ext)) {
        excerpt = new TextDecoder().decode(bytes).slice(0, 4000); readStatus = 'read'; readDetail = `Read as text (${ext}).`;
      } else if (['xlsx', 'xls'].includes(ext)) {
        readStatus = 'partial'; readDetail = 'Workbook preserved. Its rows are read by the BOQ importer when the case is linked to an assessment.';
      } else if (['dxf', 'dwg'].includes(ext)) {
        readStatus = 'partial'; readDetail = ext === 'dwg' ? 'Not processed: converter unavailable. Original preserved.' : 'Original preserved. Geometry is read by the drawing processor during evaluation.';
      }
    } catch (e) { readStatus = 'not_read'; readDetail = `Read failed: ${e instanceof Error ? e.message.slice(0, 120) : 'error'}. Original preserved.`; }

    const sourceId = `src-${crypto.randomUUID().slice(0, 8)}`;
    const reg = await s.addSource(id, { id: sourceId, role, fileName: file.name, sha256: sha, sizeBytes: file.size, stored: false, storagePath: null, readStatus, readDetail, textExcerpt: minimise(excerpt), uploadedAt: new Date().toISOString() });
    if (reg.reused) return NextResponse.json({ source: reg.source, reused: true });
    try {
      const path = await s.uploadSourceFile(id, reg.source.id, file.name, bytes, file.type);
      await s.markSourceStored(reg.source.id, id, path);
      return NextResponse.json({ source: { ...reg.source, stored: true, storagePath: path }, reused: false });
    } catch (e) {
      const f = failureResponse(e);
      return NextResponse.json({ source: reg.source, reused: false, storageError: String((f.body as { error?: string }).error ?? 'Original file was not stored.') });
    }
  } catch (e) { return fail(e); }
}

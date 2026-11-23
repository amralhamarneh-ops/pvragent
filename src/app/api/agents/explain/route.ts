import { NextRequest, NextResponse } from 'next/server';
import { completion } from '@rocketnew/llm-sdk';
import { safeParseJson, validateRationales } from '@/lib/mapping/schemas';
import { verifyUser } from '@/lib/boq/supabaseStore';
import { AdminStore, resolveConfig } from '@/lib/admin/adminStore';
import { EXPLAIN_SYSTEM } from '@/lib/admin/prompts';
import { applyRules } from '@/lib/admin/rules';

/**
 * Single provider interface for agent reasoning. Quantities and measurements are computed by code
 * and passed in as facts; the model only ranks, explains and asks questions. Uploaded text is
 * wrapped as untrusted data and never treated as instructions.
 *
 * Each call resolves the PUBLISHED configuration once at the start and keeps it for the whole call, so a version
 * published mid-call affects only later calls. The version used is recorded against the run.
 */

interface ExplainItem {
  id: string;
  facts: string;
}

function buildPrompt(stage: string, items: ExplainItem[], pvrText: string, precedents: string, maxChars: number): string {
  const lines = items.map((i) => `- id=${i.id}: ${i.facts}`).join('\n');
  return `Stage: ${stage}\nExplain why each item belongs in this change.\n<untrusted_document>\n${pvrText.slice(0, maxChars)}\n</untrusted_document>\n${precedents ? `${precedents.slice(0, 2500)}\n` : ''}FACTS:\n${lines}`;
}

const PRECEDENT_ID = /\[(R\d+)\]/g;

export async function POST(request: NextRequest) {
  const started = Date.now();
  let body: { stage?: string; items?: ExplainItem[]; pvrText?: string; precedents?: string; caseId?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body', details: 'Expected JSON' }, { status: 400 });
  }
  const { stage = 'mapping', items = [], pvrText = '', precedents = '' } = body;
  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: 'No items to explain', details: 'items must be a non-empty array' }, { status: 400 });
  }

  // Resolve configuration and open a run record. Admin Kit storage being unavailable never blocks the agent.
  let store: AdminStore | null = null;
  try {
    const user = await verifyUser(request.headers.get('authorization'), process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
    store = new AdminStore(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, user);
  } catch { store = null; }
  const cfg = await resolveConfig(store, 'explain');
  const applied = applyRules('explain', EXPLAIN_SYSTEM, cfg.rules);
  const precedentText = typeof precedents === 'string' ? precedents : '';
  const cited = precedentText ? Array.from(new Set(precedentText.match(/\bR\d+\b/g) ?? [])) : [];

  const record = async (status: 'completed' | 'fallback' | 'failed' | 'blocked', model: string | null, error: string | null, extra: Record<string, unknown> = {}) => {
    if (!store) return;
    try {
      await store.recordRun({ agentId: 'explain', caseId: body.caseId ?? null, configVersion: cfg.version, configSource: cfg.source, kind: 'live', status, model, tool: 'openai', error, precedentIds: cited, summary: { stage, items: Math.min(items.length, applied.maxItems), guidanceApplied: applied.guidanceApplied, configNote: cfg.note, ...extra }, durationMs: Date.now() - started });
    } catch { /* recording is best-effort and never breaks the agent */ }
  };

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-5.6-terra';
  if (!apiKey) {
    await record('blocked', null, 'OPENAI_API_KEY is not configured.');
    return NextResponse.json({ source: 'fallback', rationales: [], note: 'Model key is not configured. Showing rule-based reasons.', config: { version: cfg.version, source: cfg.source } });
  }
  try {
    const response = (await completion({
      model,
      messages: [
        { role: 'system', content: applied.system },
        { role: 'user', content: buildPrompt(stage, items.slice(0, applied.maxItems), pvrText, precedentText, Math.min(1500, applied.maxChars)) },
      ],
      stream: false,
      api_key: apiKey,
      max_completion_tokens: 1500,
      response_format: { type: 'json_object' },
    } as never)) as unknown as { choices?: { message?: { content?: string } }[] };
    const text = response?.choices?.[0]?.message?.content ?? '';
    const parsed = validateRationales(safeParseJson(text), items.map((i) => i.id));
    if (!parsed) {
      await record('fallback', model, 'The model reply did not pass validation.');
      return NextResponse.json({ source: 'fallback', rationales: [], note: 'The model reply did not pass validation. Showing rule-based reasons.', config: { version: cfg.version, source: cfg.source } });
    }
    const used = Array.from(new Set(parsed.rationales.flatMap((r) => Array.from(r.text.matchAll(PRECEDENT_ID)).map((m) => m[1]))));
    await record('completed', model, null, { rationales: parsed.rationales.length, precedentsCitedInOutput: used });
    return NextResponse.json({ source: 'model', rationales: parsed.rationales, config: { version: cfg.version, source: cfg.source } });
  } catch (error) {
    console.error('Agent explain error:', error instanceof Error ? error.message : 'unknown');
    await record('failed', model, error instanceof Error ? error.message : 'model call failed');
    return NextResponse.json({ source: 'fallback', rationales: [], note: 'The model could not be reached. Showing rule-based reasons.', config: { version: cfg.version, source: cfg.source } });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { completion } from '@rocketnew/llm-sdk';
import { AccessDeniedError, StorageUnavailableError, verifyUser } from '@/lib/boq/supabaseStore';
import { sanitiseScope, sanitiseMatch, type ScopeEvidenceInput } from '@/lib/boq/agentSchemas';
import type { CandidateBrief, ChangeScope } from '@/lib/boq/scope';
import { AdminStore, resolveConfig } from '@/lib/admin/adminStore';
import { SCOPE_SYSTEM, MATCH_SYSTEM } from '@/lib/admin/prompts';
import { applyRules } from '@/lib/admin/rules';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const URL_ = () => process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY_ = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** Process-local cache. Identical evidence or identical shortlist is never sent to the model twice. */
const CACHE = new Map<string, { at: number; value: unknown }>();
const TTL_MS = 60 * 60 * 1000;
function cached<T>(key: string): T | null {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) { CACHE.delete(key); return null; }
  return hit.value as T;
}
function remember(key: string, value: unknown) {
  if (CACHE.size > 200) CACHE.delete(CACHE.keys().next().value as string);
  CACHE.set(key, { at: Date.now(), value });
}
const hash = (o: unknown) => createHash('sha256').update(JSON.stringify(o)).digest('hex');

const SCOPE_SCHEMA_HINT = `{"summary":string,"location":string,"packageName":string,"components":[{"id":"c1","name":string,"action":"add|omit|replace|rework","discipline":string,"workType":string,"material":string,"specification":string,"location":string,"searchTerms":[string],"expectedUnit":string,"quantity":null|{"value":string,"unit":string,"origin":"stated_in_document","source":string,"quote":string},"missingInputs":[string],"potential":boolean,"potentialReason":string,"evidence":[string]}],"contradictions":[string],"missingInformation":[string],"limitations":[string]}`;

async function callModel(system: string, user: string, apiKey: string, model: string): Promise<string> {
  const response = (await completion({
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    stream: false,
    api_key: apiKey,
    max_completion_tokens: 6000,
    response_format: { type: 'json_object' },
  } as never)) as unknown as { choices?: { message?: { content?: string } }[] };
  return response?.choices?.[0]?.message?.content ?? '';
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
}

export async function POST(req: NextRequest) {
  const started = Date.now();
  const events: { at: string; step: string; detail: string }[] = [];
  const log = (step: string, detail: string) => events.push({ at: new Date().toISOString(), step, detail });
  let user;
  try {
    user = await verifyUser(req.headers.get('authorization'), URL_(), KEY_());
  } catch (e) {
    if (e instanceof AccessDeniedError) return NextResponse.json({ error: e.message, blocker: 'not_signed_in' }, { status: e.status });
    if (e instanceof StorageUnavailableError) return NextResponse.json({ error: e.message, blocker: e.kind }, { status: 503 });
    return NextResponse.json({ error: 'Could not verify your session.' }, { status: 500 });
  }

  let body: { phase?: 'scope' | 'match'; evidence?: ScopeEvidenceInput[]; narrative?: string; scope?: ChangeScope; candidates?: Record<string, CandidateBrief[]>; caseId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 }); }

  // Resolve the PUBLISHED configuration once, now. This request keeps it to the end; later publishes affect later requests.
  let store: AdminStore | null = null;
  try { store = new AdminStore(URL_(), KEY_(), user); } catch { store = null; }
  const agentId = body.phase === 'match' ? 'boq_mapping' : 'scope';
  const cfg = await resolveConfig(store, agentId);
  const applied = applyRules(agentId, agentId === 'scope' ? SCOPE_SYSTEM : MATCH_SYSTEM, cfg.rules);
  const record = async (status: 'completed' | 'fallback' | 'failed' | 'blocked', model: string | null, error: string | null, extra: Record<string, unknown> = {}) => {
    if (!store) return;
    try { await store.recordRun({ agentId, caseId: body.caseId ?? null, configVersion: cfg.version, configSource: cfg.source, kind: 'live', status, model, tool: 'openai', error, precedentIds: [], summary: { phase: body.phase, guidanceApplied: applied.guidanceApplied, limits: { maxItems: applied.maxItems, maxChars: applied.maxChars }, configNote: cfg.note, ...extra }, durationMs: Date.now() - started }); } catch { /* best effort */ }
  };
  const configInfo = { version: cfg.version, source: cfg.source };

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-5.6-terra';
  if (!apiKey) {
    await record('blocked', null, 'OPENAI_API_KEY is not configured.');
    return NextResponse.json({ error: 'The AI model is not configured (OPENAI_API_KEY is missing). Manual search and selection still work.', blocker: 'not_configured', events, config: configInfo }, { status: 503 });
  }

  try {
    if (body.phase === 'scope') {
      const evidence = (body.evidence ?? []).slice(0, applied.maxItems).map((e) => ({
        ...e, text: e.extracted ? e.text : '',
      }));
      const narrative = (body.narrative ?? '').slice(0, 6000);
      if (!narrative.trim() && !evidence.some((e) => e.extracted && e.text.trim())) {
        await record('blocked', model, 'No readable change evidence.');
        return NextResponse.json({ error: 'There is no readable change evidence. Enter a narrative or add a PVR document whose text can be read.', blocker: 'no_evidence', events, config: configInfo }, { status: 422 });
      }
      // The config version and rules hash are part of the cache key, so publishing a new version is never answered from an older version's cache.
      const key = `scope:${hash({ evidence, narrative, model, v: cfg.version, g: cfg.rules?.additionalInstructions ?? '', l: [applied.maxItems, applied.maxChars] })}`;
      const hit = cached<{ scope: ChangeScope }>(key);
      if (hit) { log('scope', `Reused cached scope for identical evidence and configuration version ${cfg.version}. No model call.`); await record('completed', model, null, { cached: true }); return NextResponse.json({ ...hit, cached: true, events, config: configInfo }); }
      const docs = evidence.map((e) => `[${e.kind}] ${e.name}: ${e.extracted ? e.text : `NO TEXT EXTRACTED (${e.note || 'unsupported file type'}).`}`).join('\n---\n');
      log('scope', `Sent ${evidence.length} evidence item(s) and a ${narrative.length}-character narrative to ${model} using configuration ${cfg.source === 'published' ? `version ${cfg.version}` : 'built-in rules'}.`);
      const user_ = `<untrusted_document>\nNARRATIVE:\n${narrative}\n\nDOCUMENTS:\n${docs}\n</untrusted_document>\nSCHEMA:\n${SCOPE_SCHEMA_HINT}`;
      const raw = await callModel(applied.system, user_, apiKey, model);
      const parsed = sanitiseScope(parseJson(raw), evidence, narrative);
      if (!parsed.scope) { await record('failed', model, 'The model reply was not a valid change scope.'); return NextResponse.json({ error: 'The model reply was not a valid change scope.', details: parsed.problems.join('; '), events, config: configInfo }, { status: 502 }); }
      log('scope', `Model returned ${parsed.scope.components.length} component(s). ${parsed.problems.length} problem(s) corrected by validation.`);
      const out = { scope: parsed.scope, problems: parsed.problems };
      remember(key, out);
      await record('completed', model, null, { components: parsed.scope.components.length, corrected: parsed.problems.length });
      return NextResponse.json({ ...out, cached: false, events, config: configInfo });
    }

    if (body.phase === 'match') {
      const scope = body.scope;
      const candidates = body.candidates ?? {};
      if (!scope || !Array.isArray(scope.components)) return NextResponse.json({ error: 'A change scope is required.' }, { status: 400 });
      const withCands = scope.components.filter((c) => (candidates[c.id] ?? []).length > 0 && !c.potential);
      if (withCands.length === 0) {
        log('match', 'No component had retrieved candidates, so the model was not called.');
        await record('completed', null, null, { modelCalled: false });
        return NextResponse.json({ match: { lines: [], potentiallyAffected: [], unmatched: scope.components.map((c) => ({ componentId: c.id, reason: 'No candidate BOQ lines were retrieved.' })), overlaps: [] }, problems: [], cached: false, events, config: configInfo });
      }
      const key = `match:${hash({ scope, candidates, model, v: cfg.version, g: cfg.rules?.additionalInstructions ?? '', l: [applied.maxItems, applied.maxChars] })}`;
      const hit = cached<{ match: unknown }>(key);
      if (hit) { log('match', `Reused cached matching for identical scope, candidates and configuration version ${cfg.version}. No model call.`); await record('completed', model, null, { cached: true }); return NextResponse.json({ ...hit, cached: true, events, config: configInfo }); }
      const blocks = withCands.map((c) => `COMPONENT ${c.id}: ${c.name} | action=${c.action} | discipline=${c.discipline} | work=${c.workType} | material=${c.material} | spec=${c.specification} | expectedUnit=${c.expectedUnit} | location=${c.location}\nCANDIDATES:\n${(candidates[c.id] ?? []).slice(0, applied.maxItems).map((k) => `  rowId=${k.rowId} | ref=${k.ref} | "${k.description}" | unit=${k.unit} | bill=${k.bill} | section=${k.section} | file=${k.file}`).join('\n')}`).join('\n\n');
      const potentials = scope.components.filter((c) => c.potential).map((c) => `${c.id}: ${c.name} (${c.potentialReason})`).join('\n');
      log('match', `Sent ${withCands.length} component(s) with ${withCands.reduce((n, c) => n + Math.min((candidates[c.id] ?? []).length, applied.maxItems), 0)} retrieved candidate line(s) to ${model}. The full BOQ was not sent.`);
      const user_ = `<untrusted_document>\nCHANGE SUMMARY: ${scope.summary}\n</untrusted_document>\n${blocks}\n${potentials ? `\nALREADY MARKED POTENTIAL:\n${potentials}` : ''}`;
      const raw = await callModel(applied.system, user_, apiKey, model);
      const allowed: Record<string, string[]> = Object.create(null);
      for (const c of scope.components) allowed[c.id] = c.potential ? [] : (candidates[c.id] ?? []).slice(0, applied.maxItems).map((k) => k.rowId);
      const parsed = sanitiseMatch(parseJson(raw), allowed);
      if (!parsed.match) { await record('failed', model, 'The model reply was not a valid matching result.'); return NextResponse.json({ error: 'The model reply was not a valid matching result.', details: parsed.problems.join('; '), events, config: configInfo }, { status: 502 }); }
      log('match', `Model proposed ${parsed.match.lines.length} line(s). ${parsed.problems.length} reference(s) discarded by validation.`);
      const out = { match: parsed.match, problems: parsed.problems };
      remember(key, out);
      await record('completed', model, null, { lines: parsed.match.lines.length, discarded: parsed.problems.length });
      return NextResponse.json({ ...out, cached: false, events, config: configInfo });
    }

    return NextResponse.json({ error: 'phase must be "scope" or "match".' }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error';
    console.error('boq-match error:', msg);
    await record('failed', model, msg);
    return NextResponse.json({ error: `The AI model call failed: ${msg}`, blocker: 'model_error', events, config: configInfo }, { status: 502 });
  }
}

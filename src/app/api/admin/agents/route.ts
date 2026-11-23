import { NextRequest, NextResponse } from 'next/server';
import { failureResponse, verifyUser } from '@/lib/boq/supabaseStore';
import { AdminStore, type ConfigTestResult } from '@/lib/admin/adminStore';
import { AGENTS, agentById } from '@/lib/admin/registry';
import { CEILINGS, RULE_AGENTS, applyRules, defaultRules, validateRules } from '@/lib/admin/rules';
import { PROTECTED_PROMPTS } from '@/lib/admin/prompts';
import { sanitiseMatch } from '@/lib/boq/agentSchemas';
import { workerConfig, testWorker } from '@/lib/drawings/processingAdapter';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const URL_ = () => process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY_ = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function fail(e: unknown) { const f = failureResponse(e); return NextResponse.json(f.body, { status: f.status }); }
const bad = (error: string, status = 400, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status });
async function storeFor(req: NextRequest) { const u = await verifyUser(req.headers.get('authorization'), URL_(), KEY_()); return { store: new AdminStore(URL_(), KEY_(), u), user: u }; }

/** Verify every code file named by the registry exists on the server. Anything missing is reported, not hidden. */
function traceCode() {
  return AGENTS.map((a) => {
    const files = a.code.map((f) => ({ file: f, exists: existsSync(join(process.cwd(), f)) }));
    return { id: a.id, status: a.status, files, traced: a.code.length > 0 && files.every((f) => f.exists) };
  });
}

/**
 * GET                      -> registry trace, tools status, and per-agent published version
 * GET ?agent=<id>          -> versions, runs for that agent
 * GET ?runs=1              -> recent runs across agents
 * GET ?tools=1             -> live tool checks (dependency/startup level only)
 */
export async function GET(req: NextRequest) {
  try {
    const q = req.nextUrl.searchParams;
    if (q.get('trace') === '1') return NextResponse.json({ trace: traceCode() });
    const { store } = await storeFor(req);
    const agent = q.get('agent');
    if (agent) {
      if (!agentById(agent)) return bad('Unknown agent.', 404);
      const versions = RULE_AGENTS.includes(agent) ? await store.listVersions(agent) : [];
      const published = RULE_AGENTS.includes(agent) ? await store.publishedVersion(agent) : null;
      const runs = await store.listRuns(agent, 30);
      return NextResponse.json({ versions, publishedVersion: published?.version ?? null, runs, ruleCapable: RULE_AGENTS.includes(agent), defaults: RULE_AGENTS.includes(agent) ? defaultRules(agent) : null, ceilings: CEILINGS[agent] ?? null });
    }
    if (q.get('runs') === '1') return NextResponse.json({ runs: await store.listRuns(null, 100) });
    if (q.get('tools') === '1') {
      const w = workerConfig();
      const worker = await testWorker();
      return NextResponse.json({ tools: [
        { id: 'database', level: 'dependency', state: 'passed', detail: 'This request reached Supabase and read the Admin Kit tables.' },
        { id: 'openai', level: 'dependency', state: process.env.OPENAI_API_KEY ? 'configured_untested' : 'not_configured', detail: process.env.OPENAI_API_KEY ? 'OPENAI_API_KEY is set. No model call was made by this check, so it has not been shown to work.' : 'OPENAI_API_KEY is not set.', model: process.env.OPENAI_MODEL ? 'set' : 'default' },
        { id: 'worker', level: 'dependency', state: worker.state, detail: worker.detail, testedAt: worker.testedAt, configured: { url: !!w.url, token: !!w.token } },
      ] });
    }
    return NextResponse.json({ trace: traceCode() });
  } catch (e) { return fail(e); }
}

function runConfigTest(agentId: string, rulesInput: unknown): ConfigTestResult {
  const at = new Date().toISOString();
  const checks: ConfigTestResult['checks'] = [];
  const v = validateRules(agentId, rulesInput);
  checks.push({ name: 'Rules pass structural validation', ok: v.ok, detail: v.ok ? 'All fields valid and within built-in ceilings.' : v.issues.map((i) => `${i.field}: ${i.message}`).join(' ') });
  const protectedPrompt = PROTECTED_PROMPTS[agentId];
  if (protectedPrompt) {
    const applied = applyRules(agentId, protectedPrompt, v.rules);
    checks.push({ name: 'Protected prompt is intact and first', ok: applied.system.startsWith(protectedPrompt), detail: 'The protected system prompt is unchanged at the start of the composed prompt.' });
    checks.push({ name: 'Protected prompt is restated after guidance', ok: !applied.guidanceApplied || applied.system.trimEnd().endsWith('take precedence over the administrator guidance.'), detail: 'Administrator guidance sits between protected blocks and is never the last word.' });
    checks.push({ name: 'Guidance reaches the composed prompt', ok: !v.rules.additionalInstructions || applied.system.includes(v.rules.additionalInstructions), detail: v.rules.additionalInstructions ? 'The guidance text appears in the prompt a new run would send.' : 'No guidance set; the built-in prompt is used unchanged.' });
    checks.push({ name: 'Limits do not exceed built-in ceilings', ok: applied.maxItems <= (CEILINGS[agentId]?.maxItems ?? 0) && applied.maxChars <= (CEILINGS[agentId]?.maxCharsPerItem ?? 0), detail: `Effective limits: ${applied.maxItems} items, ${applied.maxChars} characters each.` });
  }
  if (agentId === 'boq_mapping') {
    const out = sanitiseMatch({ lines: [{ componentId: 'c1', rowId: 'INVENTED', role: 'primary', why: 'x', preambleNote: '' }], potentiallyAffected: [], unmatched: [], overlaps: [] }, { c1: ['r1'] });
    const kept = out.match?.lines.length ?? 0;
    checks.push({ name: 'Protected validator still rejects an invented row id', ok: kept === 0, detail: kept === 0 ? 'A row id not in the candidate list was discarded by the code validator.' : 'The validator kept an invented row id.' });
  }
  return { at, ok: checks.every((c) => c.ok), checks };
}

/**
 * POST { action, agentId, ... }:
 *   saveDraft { rules, note, author, version? }   create a new draft, or edit an existing draft
 *   test      { version }                          run the executed checks; stores the result
 *   publish   { version, by }                      only a tested version can be published
 *   rollback  { version, by }                      re-point to an earlier published/superseded version
 */
export async function POST(req: NextRequest) {
  try {
    const { store } = await storeFor(req);
    const b = (await req.json()) as Record<string, unknown>;
    const action = String(b.action ?? ''); const agentId = String(b.agentId ?? '');
    if (!RULE_AGENTS.includes(agentId)) return bad(`Agent "${agentId}" has no editable rules. Only agents that make a model call read published rules.`, 400);
    const author = String(b.author ?? b.by ?? 'Admin');

    if (action === 'saveDraft') {
      const v = validateRules(agentId, b.rules);
      if (!v.ok) return bad('The rules did not pass validation.', 422, { issues: v.issues });
      const note = String(b.note ?? '');
      const version = typeof b.version === 'number' ? b.version : null;
      const saved = version ? await store.updateDraft(agentId, version, v.rules, note) : await store.createDraft(agentId, v.rules, author, note);
      return NextResponse.json({ version: saved });
    }

    if (action === 'test') {
      const version = Number(b.version);
      const cur = await store.getVersion(agentId, version);
      if (!cur) return bad('Version not found.', 404);
      const result = runConfigTest(agentId, cur.rules);
      return NextResponse.json({ version: await store.recordTest(agentId, version, result), result });
    }

    if (action === 'publish') {
      const version = Number(b.version);
      const cur = await store.getVersion(agentId, version);
      if (!cur) return bad('Version not found.', 404);
      if (cur.status !== 'tested') return bad(cur.status === 'published' ? 'That version is already published.' : 'Only a version whose test passed can be published. Run the test first.', 409);
      const recheck = validateRules(agentId, cur.rules);
      if (!recheck.ok) return bad('The rules no longer pass validation.', 422, { issues: recheck.issues });
      return NextResponse.json({ version: await store.publish(agentId, version, author) });
    }

    if (action === 'rollback') {
      const version = Number(b.version);
      const target = await store.getVersion(agentId, version);
      if (!target) return bad('Version not found.', 404);
      if (!target.testResult?.ok && target.status !== 'superseded' && target.status !== 'published') return bad('Only a previously tested or published version can be rolled back to.', 409);
      const current = await store.publishedVersion(agentId);
      if (current?.version === version) return bad('That version is already published.', 409);
      return NextResponse.json({ version: await store.publish(agentId, version, author, current?.version ?? null) });
    }

    return bad('Unknown action.');
  } catch (e) {
    if (e instanceof Error && /immutable/.test(e.message)) return bad(e.message, 409);
    return fail(e);
  }
}

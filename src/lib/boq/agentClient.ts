import { getAccessToken } from '@/lib/supabase/client';
import { assemble, buildBoqSet, briefFor, shortlistForScope, type AssessmentOutcome, type BoqSet, type UserAnswers, EMPTY_ANSWERS } from './matchEngine';
import type { BoqImport } from './types';
import type { ChangeScope, EvidenceDoc, ModelMatchResult } from './scope';
import type { RetrievedCandidate } from './retrieve';

/** One real processing event. Only things that actually happened are recorded. */
export interface AgentEvent { at: string; step: string; detail: string; ms?: number }

export interface AgentRun {
  scope: ChangeScope;
  proposal: ModelMatchResult;
  shortlist: Record<string, RetrievedCandidate[]>;
  set: BoqSet;
  events: AgentEvent[];
  problems: string[];
  cached: { scope: boolean; match: boolean };
  importSignature: string;
}

const TEXT_EXT = /\.(txt|md|csv|json|eml|log)$/i;
export const MAX_TEXT_BYTES = 200_000;

/** Read supporting files. Only plain-text formats can be read here; every other type is labelled as not extracted. */
export async function readEvidenceFile(file: File): Promise<EvidenceDoc> {
  const lower = file.name.toLowerCase();
  const kind: EvidenceDoc['kind'] = /drawing|dwg|dxf|\.rev|sketch/.test(lower) || /\.(dwg|dxf)$/.test(lower) ? 'drawing' : /spec/.test(lower) ? 'specification' : /pvr|variation|change|request|instruction/.test(lower) ? 'pvr' : 'other';
  if (TEXT_EXT.test(lower)) {
    const buf = await file.arrayBuffer();
    const text = new TextDecoder('utf-8').decode(buf.slice(0, MAX_TEXT_BYTES));
    return { name: file.name, kind, text, extracted: text.trim().length > 0, note: text.trim() ? (buf.byteLength > MAX_TEXT_BYTES ? `Only the first ${MAX_TEXT_BYTES / 1000} KB were read.` : '') : 'The file is empty.' };
  }
  if (/\.(dwg|dxf)$/.test(lower)) return { name: file.name, kind: 'drawing', text: '', extracted: false, note: 'Drawing geometry is not analysed in this pass, so quantities cannot be measured from it.' };
  if (/\.pdf$/.test(lower)) return { name: file.name, kind, text: '', extracted: false, note: 'PDF text extraction is not implemented here. Paste the relevant text into the narrative to include it.' };
  if (/\.(docx?|xlsx?)$/.test(lower)) return { name: file.name, kind, text: '', extracted: false, note: 'This document type cannot be read here yet. Paste the relevant text into the narrative to include it.' };
  return { name: file.name, kind, text: '', extracted: false, note: 'Unsupported file type for text extraction.' };
}

async function authedPost<T>(body: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string; blocker?: string }> {
  const token = await getAccessToken();
  let res: Response;
  try {
    res = await fetch('/api/boq-match', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  } catch (e) {
    return { ok: false, error: `Could not reach the server: ${e instanceof Error ? e.message : 'network error'}.`, blocker: 'network' };
  }
  let data: Record<string, unknown> = {};
  try { data = (await res.json()) as Record<string, unknown>; } catch { /* ignore */ }
  if (!res.ok) return { ok: false, error: String(data.error ?? `HTTP ${res.status}`) + (data.details ? ` (${String(data.details)})` : ''), blocker: typeof data.blocker === 'string' ? data.blocker : undefined };
  return { ok: true, data: data as T };
}

export function importSignatureOf(imports: BoqImport[]): string {
  return imports.map((i) => `${i.id}:${i.source.sha256}`).sort().join('|');
}

/**
 * Run the real workflow: understand the change -> retrieve candidates from the whole active BOQ set -> ask the model
 * to relate components to those candidates. Throws an Error with the exact reason when a step cannot run.
 */
export async function runAgent(args: { imports: BoqImport[]; narrative: string; evidence: EvidenceDoc[]; onEvent?: (e: AgentEvent) => void }): Promise<AgentRun> {
  const events: AgentEvent[] = [];
  const push = (step: string, detail: string, started?: number) => { const e: AgentEvent = { at: new Date().toISOString(), step, detail, ms: started ? Math.round(performance.now() - started) : undefined }; events.push(e); args.onEvent?.(e); };

  let t = performance.now();
  const set = buildBoqSet(args.imports);
  if (set.items.length === 0) throw new Error('The active BOQ set has no items. Import and confirm a BOQ first.');
  push('Read BOQ set', `${set.files.length} file(s), ${set.items.length} item(s), ${set.files.reduce((n, f) => n + f.unpriced, 0)} without a rate. ${set.files.map((f) => `${f.fileName} (revision ${f.revision})`).join('; ')}.`, t);

  const readable = args.evidence.filter((e) => e.extracted).length;
  const unread = args.evidence.filter((e) => !e.extracted);
  push('Read change evidence', `${readable} readable document(s), narrative ${args.narrative.trim().length} characters.${unread.length ? ` Not readable: ${unread.map((u) => u.name).join(', ')}.` : ''}`);

  t = performance.now();
  const sc = await authedPost<{ scope: ChangeScope; problems: string[]; cached: boolean; events: AgentEvent[] }>({ phase: 'scope', narrative: args.narrative, evidence: args.evidence });
  if (!sc.ok) { push('Understand change', `Failed: ${sc.error}`, t); throw new Error(sc.error); }
  sc.data.events?.forEach((e) => push(e.step, e.detail));
  push('Understand change', `${sc.data.scope.components.length} component(s) identified${sc.data.cached ? ' (cached result reused)' : ''}.${sc.data.problems.length ? ` ${sc.data.problems.length} model claim(s) corrected: ${sc.data.problems.join(' ')}` : ''}`, t);

  t = performance.now();
  const shortlist = shortlistForScope(set, sc.data.scope);
  push('Search BOQ set', sc.data.scope.components.map((c) => `${c.name}: ${shortlist[c.id]?.length ?? 0} candidate(s)`).join('; '), t);

  const candidates: Record<string, ReturnType<typeof briefFor>[]> = {};
  for (const c of sc.data.scope.components) candidates[c.id] = (shortlist[c.id] ?? []).map((r) => briefFor(r.item, set.context));

  t = performance.now();
  const mt = await authedPost<{ match: ModelMatchResult; problems: string[]; cached: boolean; events: AgentEvent[] }>({ phase: 'match', scope: sc.data.scope, candidates });
  if (!mt.ok) { push('Relate to BOQ items', `Failed: ${mt.error}`, t); throw new Error(mt.error); }
  mt.data.events?.forEach((e) => push(e.step, e.detail));
  push('Relate to BOQ items', `${mt.data.match.lines.length} line(s) proposed${mt.data.cached ? ' (cached result reused)' : ''}.${mt.data.problems.length ? ` ${mt.data.problems.length} reference(s) discarded: ${mt.data.problems.join(' ')}` : ''}`, t);

  return { scope: sc.data.scope, proposal: mt.data.match, shortlist, set, events, problems: [...sc.data.problems, ...mt.data.problems], cached: { scope: sc.data.cached, match: mt.data.cached }, importSignature: importSignatureOf(args.imports) };
}

export function outcomeOf(run: AgentRun, answers: UserAnswers = EMPTY_ANSWERS): AssessmentOutcome {
  return assemble(run.set, run.scope, run.proposal, run.shortlist, answers);
}

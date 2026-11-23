import type { EvidenceDoc } from '@/lib/boq/scope';
import type { AnalysisResult } from './types';
import { fingerprintChanges } from './snapshot';

const KEY = (caseId: string) => `pvr-agent-change-handoff-v1:${caseId}`;
const HISTORY_KEY = (caseId: string) => `pvr-agent-change-handoff-history-v1:${caseId}`;

/**
 * One structured quantity record for BOQ mapping. Each one is a separate addition, omission or modification so the
 * valuation can price them separately. Values carry their basis and the geometry they came from. The BOQ stage reads
 * these records directly; it does not re-derive quantities from prose.
 */
export interface HandoffRecord {
  id: string;
  component: string;
  change: 'added' | 'removed' | 'modified' | 'stated';
  unit: string;
  originalQty: string;
  revisedQty: string;
  addedQty: string;
  omittedQty: string;
  netQty: string;
  basis: AnalysisResult['changes'][number]['basis'];
  /** Exact formula and revision the figure came from. Null for values that were not measured. */
  formula: string | null;
  drawingRevision: string | null;
  measurementBasis: string;
  entityRefs: AnalysisResult['changes'][number]['entityRefs'] | null;
  /** True when the record needs a person to confirm it before it is priced. */
  needsReview: boolean;
  reviewReasons: string[];
  /** Other sources' values for the same component; never merged into the figure above. */
  alternatives: AnalysisResult['changes'][number]['alternatives'];
  relocationEvidence: { source: string; sentence: string } | null;
}

export interface ChangeHandoff {
  savedAt: string;
  /** Version of the analysis these records came from, and a fingerprint so dependants can detect a change. */
  analysisVersion?: number;
  fingerprint?: string;
  /** The user's narrative exactly as typed. Never replaced by a generated summary. */
  originalNarrative: string;
  /** Text extracted from readable PVR/correspondence documents, with the document each came from. */
  extractedText: { name: string; sha256: string; text: string }[];
  /** Document references and versions used in the analysis. */
  documents: { id: string; name: string; sha256: string; version: number; role: string }[];
  /** Plain-language lines for the BOQ agent: only changes without an unresolved conflict. Derived; not the user's words. */
  narrative: string;
  /** Structured, evidence-linked changes shown to the user on the BOQ stage. */
  changes: AnalysisResult['changes'];
  /** Structured quantity records passed directly to BOQ mapping. */
  records?: HandoffRecord[];
  /** Dates are carried as classified labels. The event date stays unresolved unless the evidence proposed one. */
  dates: AnalysisResult['dates'];
  proposedEventDate: AnalysisResult['proposedEventDate'];
  /** A date the user typed. It is labelled user-entered and is never merged into the evidence-proposed date. */
  userEnteredDate: string;
  /** Items the analysis could not settle, so the BOQ stage does not pretend they were. */
  openQuestions: { id: string; title: string; issue: string }[];
  /** Answers applied so far, and the alternatives that were on offer when each was recorded. */
  appliedAnswers: { questionId: string; optionId: string; optionLabel: string; alternatives: string[] }[];
  limitations: string[];
}

export interface HandoffInputs {
  originalNarrative: string;
  extractedText?: ChangeHandoff['extractedText'];
  documents?: ChangeHandoff['documents'];
  analysisVersion?: number;
}

/** Turn reconciled changes into structured records. Numbers are copied, never recomputed or re-read from text. */
export function recordsFromChanges(changes: AnalysisResult['changes']): HandoffRecord[] {
  return changes.map((c) => {
    const reasons: string[] = [];
    if (c.conflict) reasons.push(c.conflictNote || 'Sources disagree.');
    if (c.ambiguity) reasons.push(c.ambiguity.reason);
    if (c.basis !== 'measured' && c.basis !== 'derived') reasons.push(`Quantity is ${c.basis.replace('_', '-')}, not measured from the drawings.`);
    const q = Number(c.changeQty);
    const added = c.addedQty ?? (c.change === 'added' ? String(Math.abs(q)) : '0');
    const omitted = c.omittedQty ?? (c.change === 'removed' ? String(Math.abs(q)) : '0');
    return {
      id: c.id, component: c.component, change: c.change ?? 'stated', unit: c.unit, originalQty: c.originalQty, revisedQty: c.revisedQty,
      addedQty: added, omittedQty: omitted, netQty: c.netQty ?? c.changeQty, basis: c.basis,
      formula: c.trace?.formula ?? null, drawingRevision: c.trace?.drawingRevision ?? (c.entityRefs ? `${c.entityRefs.originalRevision} → ${c.entityRefs.revisedRevision}` : null),
      measurementBasis: c.measurementBasis, entityRefs: c.entityRefs ?? null, needsReview: reasons.length > 0, reviewReasons: reasons,
      alternatives: c.alternatives, relocationEvidence: c.relocationEvidence ? { source: c.relocationEvidence.source, sentence: c.relocationEvidence.sentence } : null,
    };
  });
}

export function buildHandoff(r: AnalysisResult, answers: Record<string, string>, userEnteredDate = '', inputs: HandoffInputs = { originalNarrative: '' }): ChangeHandoff {
  return {
    savedAt: new Date().toISOString(),
    analysisVersion: inputs.analysisVersion,
    fingerprint: fingerprintChanges(r.changes),
    originalNarrative: inputs.originalNarrative,
    extractedText: inputs.extractedText ?? [],
    documents: inputs.documents ?? [],
    narrative: r.agentNarrative,
    changes: r.changes,
    records: recordsFromChanges(r.changes),
    dates: r.dates,
    proposedEventDate: r.proposedEventDate,
    userEnteredDate,
    openQuestions: r.questions.filter((q) => !answers[q.id]).map((q) => ({ id: q.id, title: q.title, issue: q.issue })),
    appliedAnswers: r.questions.filter((q) => answers[q.id]).map((q) => ({ questionId: q.id, optionId: answers[q.id], optionLabel: q.options.find((o) => o.id === answers[q.id])?.label ?? answers[q.id], alternatives: q.options.map((o) => o.label) })),
    limitations: r.capability.unsupported.map((u) => `${u.fileName}: ${u.reason}`),
  };
}

/** Session copy: a convenience cache only. The case record on the server is the source of evidence. Earlier versions are kept. */
export function saveHandoff(caseId: string, h: ChangeHandoff): boolean {
  try {
    const prev = window.sessionStorage.getItem(KEY(caseId));
    if (prev) {
      const hist = JSON.parse(window.sessionStorage.getItem(HISTORY_KEY(caseId)) ?? '[]') as ChangeHandoff[];
      const old = JSON.parse(prev) as ChangeHandoff;
      if (old.fingerprint !== h.fingerprint) window.sessionStorage.setItem(HISTORY_KEY(caseId), JSON.stringify([...hist, old].slice(-6)));
    }
    window.sessionStorage.setItem(KEY(caseId), JSON.stringify(h));
    return true;
  } catch { return false; }
}

export function loadHandoff(caseId: string): ChangeHandoff | null {
  try {
    const raw = window.sessionStorage.getItem(KEY(caseId));
    if (!raw) return null;
    return normaliseHandoff(JSON.parse(raw));
  } catch { return null; }
}

/** Earlier handoff versions for the case, oldest first. */
export function loadHandoffHistory(caseId: string): ChangeHandoff[] {
  try { const raw = window.sessionStorage.getItem(HISTORY_KEY(caseId)); return raw ? (JSON.parse(raw) as ChangeHandoff[]).map((h) => normaliseHandoff(h)).filter((h): h is ChangeHandoff => !!h) : []; } catch { return []; }
}

/**
 * A mapping or calculation built from `builtFrom` is stale when the current handoff has a different fingerprint. The
 * stale one is not deleted: the caller marks it stale and keeps it as a previous version.
 */
export function mappingIsStale(builtFrom: string | null | undefined, current: ChangeHandoff | null): boolean {
  if (!current?.fingerprint) return false;
  return !!builtFrom && builtFrom !== current.fingerprint;
}

/** Accepts a handoff from the server or an older session copy and fills fields added later. */
export function normaliseHandoff(x: unknown): ChangeHandoff | null {
  const h = x as Partial<ChangeHandoff> | null;
  if (!h || typeof h.narrative !== 'string' || !Array.isArray(h.changes)) return null;
  return {
    savedAt: h.savedAt ?? '',
    analysisVersion: h.analysisVersion,
    fingerprint: h.fingerprint ?? fingerprintChanges(h.changes),
    originalNarrative: typeof h.originalNarrative === 'string' ? h.originalNarrative : '',
    extractedText: Array.isArray(h.extractedText) ? h.extractedText : [],
    documents: Array.isArray(h.documents) ? h.documents : [],
    narrative: h.narrative,
    changes: h.changes,
    records: Array.isArray(h.records) ? h.records : recordsFromChanges(h.changes),
    dates: Array.isArray(h.dates) ? h.dates : [],
    proposedEventDate: h.proposedEventDate ?? null,
    userEnteredDate: h.userEnteredDate ?? '',
    openQuestions: Array.isArray(h.openQuestions) ? h.openQuestions : [],
    appliedAnswers: Array.isArray(h.appliedAnswers) ? h.appliedAnswers : [],
    limitations: Array.isArray(h.limitations) ? h.limitations : [],
  };
}

/**
 * Evidence for the BOQ agent. The user's own narrative and every extracted document text are passed as themselves;
 * the generated change summary is added as a separate, clearly named document and never stands in for them. The
 * structured `records` travel alongside in the handoff itself and are the source of quantities.
 */
export function handoffAsEvidence(h: ChangeHandoff): EvidenceDoc[] {
  const docs: EvidenceDoc[] = [];
  if (h.originalNarrative.trim()) docs.push({ name: 'Original narrative', kind: 'pvr', text: h.originalNarrative, extracted: true, note: '' });
  for (const t of h.extractedText) if (t.text.trim()) docs.push({ name: t.name, kind: 'pvr', text: t.text, extracted: true, note: '' });
  if (h.narrative.trim()) docs.push({ name: 'Automatic change analysis', kind: 'pvr', text: h.narrative, extracted: true, note: '' });
  return docs;
}

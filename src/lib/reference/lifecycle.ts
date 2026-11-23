import type { ReferenceCase, ReferencePartition, ReferenceStatus, ReviewEntry, SourceRole } from './types';
import { SOURCE_ROLES } from './types';

/** Allowed lifecycle moves. Retired is terminal; a retired case is replaced by a new version, not re-opened. */
const TRANSITIONS: Record<ReferenceStatus, ReferenceStatus[]> = {
  draft: ['under_review'],
  under_review: ['approved', 'draft'],
  approved: ['retired'],
  retired: [],
};

export function canTransition(from: ReferenceStatus, to: ReferenceStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Roles with no source attached. Incomplete cases are allowed but their gaps are always listed. */
export function missingEvidence(sources: { role: SourceRole }[]): string[] {
  const have = new Set(sources.map((s) => s.role));
  return SOURCE_ROLES.filter((r) => r.required && !have.has(r.role)).map((r) => `${r.label} not provided`);
}

export interface TransitionInput {
  to: ReferenceStatus;
  reviewer: string;
  note: string;
  evidence: string[];
  at: string;
}

export interface TransitionResult { ok: boolean; error?: string; next?: ReferenceCase }

/** Approval needs a named reviewer, a note and at least one supporting evidence reference. It never edits quantities, rates or rules. */
export function transition(c: ReferenceCase, t: TransitionInput): TransitionResult {
  if (!canTransition(c.status, t.to)) return { ok: false, error: `A case that is "${c.status.replace('_', ' ')}" cannot move to "${t.to.replace('_', ' ')}".` };
  if (t.to === 'approved') {
    if (!t.reviewer.trim()) return { ok: false, error: 'Approval needs a named reviewer.' };
    if (!t.note.trim()) return { ok: false, error: 'Approval needs a recorded reason.' };
    if (t.evidence.length === 0) return { ok: false, error: 'Approval needs at least one supporting evidence reference.' };
    if (c.sources.length === 0) return { ok: false, error: 'A case with no source files cannot be approved.' };
  }
  if (t.to === 'retired' && !t.note.trim()) return { ok: false, error: 'Retiring a case needs a reason.' };
  const action: ReviewEntry['action'] = t.to === 'approved' ? 'approved' : t.to === 'retired' ? 'retired' : t.to === 'under_review' ? 'submitted' : 'returned';
  const entry: ReviewEntry = { at: t.at, action, reviewer: t.reviewer.trim(), version: c.version, note: t.note.trim(), evidence: t.evidence };
  return { ok: true, next: { ...c, status: t.to, reviewHistory: [...c.reviewHistory, entry], updatedAt: t.at } };
}

/** Only approved learning-partition cases may inform a new assessment by default. */
export function isRetrievable(c: ReferenceCase): boolean {
  return c.status === 'approved' && c.partition === 'learning' && c.replacedBy === null;
}

/** Retire an incorrect precedent and, optionally, link the replacement version. */
export function withdraw(c: ReferenceCase, reviewer: string, reason: string, at: string, replacedBy: string | null): TransitionResult {
  const r = transition(c, { to: 'retired', reviewer, note: reason, evidence: [], at });
  if (!r.ok || !r.next) return r;
  const next: ReferenceCase = { ...r.next, replacedBy };
  if (replacedBy) next.reviewHistory = [...next.reviewHistory, { at, action: 'replaced', reviewer: reviewer.trim(), version: c.version, note: `Replaced by ${replacedBy}.`, evidence: [] }];
  return { ok: true, next };
}

export interface LeakageReport { ok: boolean; issues: string[] }

/**
 * Versions of the same case group must sit in ONE partition, and a source file (by hash) must not appear in both
 * partitions. Either would let evaluation cases leak into what the assessment retrieves.
 */
export function checkLeakage(cases: ReferenceCase[]): LeakageReport {
  const issues: string[] = [];
  const groupPartitions = new Map<string, Set<ReferencePartition>>();
  const hashPartitions = new Map<string, Map<ReferencePartition, string>>();
  for (const c of cases) {
    const g = groupPartitions.get(c.caseGroup) ?? new Set<ReferencePartition>();
    g.add(c.partition); groupPartitions.set(c.caseGroup, g);
    for (const s of c.sources) {
      const h = hashPartitions.get(s.sha256) ?? new Map<ReferencePartition, string>();
      if (!h.has(c.partition)) h.set(c.partition, `${c.title} (${s.fileName})`);
      hashPartitions.set(s.sha256, h);
    }
  }
  groupPartitions.forEach((p, g) => { if (p.size > 1) issues.push(`Versions of case group "${g}" are in both the learning and evaluation sets.`); });
  hashPartitions.forEach((h) => { if (h.size > 1) issues.push(`An identical file appears in both sets: ${Array.from(h.values()).join(' and ')}.`); });
  return { ok: issues.length === 0, issues };
}

/** Whether moving a case to a partition would create leakage. Returns the reason, or null when allowed. */
export function partitionMoveBlock(all: ReferenceCase[], id: string, to: ReferencePartition): string | null {
  const target = all.find((c) => c.id === id);
  if (!target) return 'Case not found.';
  const moved = all.map((c) => (c.caseGroup === target.caseGroup ? { ...c, partition: to } : c));
  const report = checkLeakage(moved);
  return report.ok ? null : report.issues[0];
}

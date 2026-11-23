/**
 * Case-scoped browser draft storage.
 *
 * Every PVR draft lives under its own key (pvr-agent-draft-v2:<scopeId>). A small index records the known drafts and
 * which one is active in THIS tab. The legacy global keys (pvr-agent-draft-v1, pvr-agent-real-case-id) are never
 * auto-restored: they are only offered through an explicit "Resume previous draft" action.
 */

import type { IncomingFile } from '@/lib/intake/triage';

const LEGACY_DRAFT_KEY = 'pvr-agent-draft-v1';
const LEGACY_CASE_KEY = 'pvr-agent-real-case-id';
const DRAFT_PREFIX = 'pvr-agent-draft-v2:';
const INDEX_KEY = 'pvr-agent-draft-index-v2';
const ACTIVE_KEY = 'pvr-agent-active-scope-v2';

export interface ScopedDraft {
  scopeId: string;
  files: IncomingFile[];
  roleOverride: Record<string, string>;
  subroles: Record<string, string>;
  narrative: string;
  scheduleChoice: string;
  sample: boolean;
  /** Server case id when this draft is linked to one. */
  caseId: string;
  /** True when the current analysis no longer matches the document set. */
  stale: boolean;
  staleReason: string;
  savedAt: string;
  updatedAtIso: string;
}

export interface DraftSummary { scopeId: string; label: string; files: number; updatedAtIso: string; caseId: string }

function newScopeId(): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `d-${rnd.slice(0, 12)}`;
}

function emptyDraft(scopeId: string): ScopedDraft {
  return { scopeId, files: [], roleOverride: {}, subroles: {}, narrative: '', scheduleChoice: '', sample: false, caseId: '', stale: false, staleReason: '', savedAt: '', updatedAtIso: new Date().toISOString() };
}

function readIndex(): DraftSummary[] {
  try { const raw = window.localStorage.getItem(INDEX_KEY); return raw ? (JSON.parse(raw) as DraftSummary[]) : []; } catch { return []; }
}
function writeIndex(list: DraftSummary[]): void {
  try { window.localStorage.setItem(INDEX_KEY, JSON.stringify(list.slice(0, 20))); } catch { /* storage full */ }
}

function loadDraft(scopeId: string): ScopedDraft | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_PREFIX + scopeId);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<ScopedDraft>;
    return { ...emptyDraft(scopeId), ...d, scopeId, files: Array.isArray(d.files) ? d.files : [], roleOverride: d.roleOverride ?? {}, subroles: d.subroles ?? {} };
  } catch { return null; }
}

function saveDraft(d: ScopedDraft): boolean {
  try {
    const stamped = { ...d, updatedAtIso: new Date().toISOString() };
    window.localStorage.setItem(DRAFT_PREFIX + d.scopeId, JSON.stringify(stamped));
    const label = d.narrative.trim().split(/[.\n]/)[0].slice(0, 60) || (d.files[0]?.path ?? 'Untitled PVR');
    const idx = readIndex().filter((i) => i.scopeId !== d.scopeId);
    idx.unshift({ scopeId: d.scopeId, label, files: d.files.length, updatedAtIso: stamped.updatedAtIso, caseId: d.caseId });
    writeIndex(idx);
    return true;
  } catch { return false; }
}

function discardDraft(scopeId: string): void {
  try { window.localStorage.removeItem(DRAFT_PREFIX + scopeId); } catch { /* ignore */ }
  writeIndex(readIndex().filter((i) => i.scopeId !== scopeId));
}

function getActiveScope(): string {
  try { return window.sessionStorage.getItem(ACTIVE_KEY) ?? ''; } catch { return ''; }
}
function setActiveScope(scopeId: string): void {
  try { window.sessionStorage.setItem(ACTIVE_KEY, scopeId); } catch { /* ignore */ }
}

/** Drafts that exist but are NOT the active one: offered explicitly, never opened silently. */
function resumableDrafts(activeScope: string): DraftSummary[] {
  const list = readIndex().filter((i) => i.scopeId !== activeScope && (i.files > 0 || i.label !== 'Untitled PVR'));
  // Surface a legacy global draft as an explicit option only.
  try {
    const legacy = window.localStorage.getItem(LEGACY_DRAFT_KEY);
    if (legacy) {
      const d = JSON.parse(legacy) as { files?: IncomingFile[]; narrative?: string };
      const n = Array.isArray(d.files) ? d.files.length : 0;
      if (n > 0 || (d.narrative ?? '').trim()) list.push({ scopeId: '__legacy__', label: (d.narrative ?? '').trim().split(/[.\n]/)[0].slice(0, 60) || 'Earlier draft', files: n, updatedAtIso: '', caseId: '' });
    }
  } catch { /* ignore */ }
  return list;
}

function dropLegacy(): void {
  try { window.localStorage.removeItem(LEGACY_DRAFT_KEY); window.sessionStorage.removeItem(LEGACY_CASE_KEY); } catch { /* ignore */ }
}

/** Turn the legacy global draft into a scoped one when the user explicitly resumes it. */
function adoptLegacyDraft(): ScopedDraft | null {
  try {
    const raw = window.localStorage.getItem(LEGACY_DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as { files?: IncomingFile[]; narrative?: string; scheduleChoice?: string; sample?: boolean };
    const draft: ScopedDraft = { ...emptyDraft(newScopeId()), files: Array.isArray(d.files) ? d.files : [], narrative: d.narrative ?? '', scheduleChoice: d.scheduleChoice ?? '', sample: !!d.sample };
    try { draft.caseId = window.sessionStorage.getItem(LEGACY_CASE_KEY) ?? ''; } catch { /* ignore */ }
    saveDraft(draft);
    if (draft.caseId) setCaseFor(draft.scopeId, draft.caseId);
    dropLegacy();
    return draft;
  } catch { return null; }
}

/** The pointer to the server case, scoped by draft so a new PVR never reopens the previous case. */
function caseKeyFor(scopeId: string): string { return `pvr-agent-case-id-v2:${scopeId}`; }
function getCaseFor(scopeId: string): string {
  try { return window.localStorage.getItem(caseKeyFor(scopeId)) ?? ''; } catch { return ''; }
}
function setCaseFor(scopeId: string, caseId: string): void {
  try { if (caseId) window.localStorage.setItem(caseKeyFor(scopeId), caseId); else window.localStorage.removeItem(caseKeyFor(scopeId)); } catch { /* ignore */ }
}

export { newScopeId, emptyDraft, loadDraft, saveDraft, discardDraft, getActiveScope, setActiveScope, resumableDrafts, adoptLegacyDraft, getCaseFor, setCaseFor };

function DraftSummary(...args: any[]): any {
  // eslint-disable-next-line no-console
  console.warn('Placeholder: DraftSummary is not implemented yet.', args);
  return null;
}

export { DraftSummary };
function ScopedDraft(...args: any[]): any {
  // eslint-disable-next-line no-console
  console.warn('Placeholder: ScopedDraft is not implemented yet.', args);
  return null;
}

export { ScopedDraft };
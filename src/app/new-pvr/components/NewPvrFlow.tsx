'use client';

import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Save } from 'lucide-react';
import { toast } from 'sonner';
import DocumentsStep from '@/app/new-pvr/components/DocumentsStep';
import EvidencePack from '@/app/new-pvr/components/EvidencePack';
import TriageStep, { type ProjectChoice } from '@/app/new-pvr/components/TriageStep';
import PrerequisitesStep from '@/app/new-pvr/components/PrerequisitesStep';
import { buildSavedDrawingReplay } from '@/lib/drawings/replay';
import { AnalysisReadCache, analyseDocuments, type AnalysisOutput, type InputFile } from '@/lib/drawings/analyse';
import DrawingAnalysisPanel, { type PanelDoc } from '@/app/case-workspace/components/DrawingAnalysisPanel';
import BackgroundJobPanel from '@/app/case-workspace/components/BackgroundJobPanel';
import { serverExtractor } from '@/lib/drawings/extractClient';
import { buildHandoff, saveHandoff } from '@/lib/drawings/handoff';
import { nextVersion } from '@/lib/drawings/snapshot';
import EvidenceDrawer from '@/components/EvidenceDrawer';
import Modal from '@/components/ui/Modal';
import JourneyStepper from '@/components/JourneyStepper';
import BoqImportPanel from '@/app/new-pvr/components/BoqImportPanel';
import CoverageRegister from '@/app/new-pvr/components/CoverageRegister';
import { buildBoqModel, EMPTY_INCLUSION, INCLUSION_ANSWER_KEY, parseInclusion, REVISION_LABEL_TEXT, serialiseInclusion, type BoqInclusionState } from '@/lib/boq/documents';
import { buildCoverage } from '@/lib/boq/coverage';
import { importSignatureOf } from '@/lib/boq/agentClient';
import { readRunRecord } from '@/lib/boq/runRecord';
import RequireSignIn from '@/components/RequireSignIn';
import { isProcessedPvrFile } from '@/lib/intake/processedReference';
import { classifyOne, demoPack, type ClassifiedFile, type FileRole, type IncomingFile, type TriageResult } from '@/lib/intake/triage';
import { computeReadiness, primaryAction } from '@/lib/intake/readiness';
import type { DocGroup } from '@/lib/intake/docGroups';
import { createCase } from '@/lib/mapping/useCaseStore';
import { createRealCase, saveImport, saveImportStaged, loadRealCase, storeOriginalFile, getOriginalFileLink, selectImportRevision, type Persistence, type PendingImport, type SaveProgress } from '@/lib/boq/caseClient';
import type { BoqImport, CaseRecord } from '@/lib/boq/types';
import DocumentManager, { type DocActions, type ManagedDoc } from '@/app/new-pvr/components/DocumentManager';
import { DocumentRegistry, DOC_STATE_LABEL, type DocRecord } from '@/lib/docs/registry';
import { loadEvidence, reclassifyOnServer, removeOnServer, restoreDocuments, saveEvidence, setDocRole, signedDocLink, storeAllDocuments } from '@/lib/docs/caseDocsClient';
import { CATEGORY_OPTIONS, categoryLabel, subroleLabel } from '@/lib/docs/categories';
import { adoptLegacyDraft, discardDraft, emptyDraft, getActiveScope, getCaseFor, loadDraft, newScopeId, resumableDrafts, saveDraft as persistDraft, setActiveScope, setCaseFor, type DraftSummary, type ScopedDraft } from '@/lib/docs/scopedDraft';
import { resolutionsFrom } from '@/lib/drawings/resolve';

type Sub = 'pack' | 'triage' | 'prereq';

const CURRENCY = 'AED';
const STAGE_TEXT = (n: number) => ['Reading ' + n + ' files', 'Working out what each file is', 'Matching to a project'];

const STATE_TONE: Record<string, string> = {
  uploaded: 'bg-muted text-muted-foreground',
  stored: 'bg-secondary text-secondary-foreground',
  parsed: 'bg-success/15 text-success',
  needs_clarification: 'bg-warning/20 text-foreground',
  failed: 'bg-destructive/10 text-destructive',
};

function stamp(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function NewPvrFlow() {
  const router = useRouter();
  const [sub, setSub] = useState<Sub>('pack');
  const [incoming, setIncoming] = useState<IncomingFile[]>([]);
  const [roleOverride, setRoleOverride] = useState<Record<string, FileRole>>({});
  const roleOverrideRef = useRef<Record<string, FileRole>>({});
  useEffect(() => { roleOverrideRef.current = roleOverride; }, [roleOverride]);
  const [narrative, setNarrative] = useState('');
  const [scheduleChoice, setScheduleChoice] = useState('');
  const [sample, setSample] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState('');
  /** Identifies the current PVR draft. All browser state is stored under this scope. */
  const [scopeId, setScopeId] = useState('');
  const scopeRef = useRef('');
  /**
   * Bumped whenever the document set changes or a different PVR is opened. Every async job captures it at start and
   * discards its output if it changed, so a late response can never repopulate removed files or a new PVR.
   */
  const epochRef = useRef(0);
  const [subroles, setSubroles] = useState<Record<string, string>>({});
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [docBusy, setDocBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [staleReason, setStaleReason] = useState('');
  const [resumable, setResumable] = useState<DraftSummary[]>([]);
  const [confirm, setConfirm] = useState<null | { kind: 'clear' } | { kind: 'remove'; ids: string[] } | { kind: 'new' }>(null);

  const [result, setResult] = useState<TriageResult | null>(null);
  const [files, setFiles] = useState<ClassifiedFile[]>([]);
  const [processedPaths, setProcessedPaths] = useState<string>('');
  const [progress, setProgress] = useState(0);
  const [stageText, setStageText] = useState('');
  const [triaging, setTriaging] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [baseline, setBaseline] = useState('');
  const [project, setProject] = useState<ProjectChoice | null>(null);
  const [separate, setSeparate] = useState(true);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisOutput | null>(null);
  const [analysing, setAnalysing] = useState(false);
  const [analysisError, setAnalysisError] = useState('');
  const [qAnswers, setQAnswers] = useState<Record<string, string>>({});
  const [manualOpen, setManualOpen] = useState(false);
  const [manualQty, setManualQty] = useState('');
  const [manualUnit, setManualUnit] = useState('m');
  const [manualComponent, setManualComponent] = useState('');
  const [manualDate, setManualDate] = useState('');
  /** One shared registry for every upload path. Bytes live here (and in IndexedDB / authorised storage), never in a loose ref. */
  const registry = useRef<DocumentRegistry>(new DocumentRegistry());
  const reads = useRef(new AnalysisReadCache());
  const [registryVersion, setRegistryVersion] = useState(0);
  const bump = useCallback(() => setRegistryVersion((v) => v + 1), []);
  const [missingBytes, setMissingBytes] = useState<Set<string>>(new Set());
  const [processedBoqKeys, setProcessedBoqKeys] = useState<Set<string>>(new Set());
  const [docMessage, setDocMessage] = useState('');
  const [lastExtracted, setLastExtracted] = useState<{ name: string; text: string }[]>([]);
  const [lastExtractedState, setLastExtractedState] = useState(0);
  const analysisRef = useRef<AnalysisOutput | null>(null);
  const lastExtractedRef = useRef<{ name: string; text: string }[]>([]);
  useEffect(() => { analysisRef.current = analysis; }, [analysis]);
  useEffect(() => { lastExtractedRef.current = lastExtracted; setLastExtractedState((n) => n + 1); }, [lastExtracted]);
  const [drawer, setDrawer] = useState(false);
  const [realCase, setRealCase] = useState<CaseRecord | null>(null);
  const [boqImports, setBoqImports] = useState<BoqImport[]>([]);
  const [persistence, setPersistence] = useState<Persistence | null>(null);
  const [saveError, setSaveError] = useState('');
  /** Staged-save state per import id: the file is stored, rows are saved N of M, complete, or interrupted (resumable). */
  const [saveState, setSaveState] = useState<Record<string, { fileStored: boolean; fileError: string; progress: SaveProgress | null; interrupted: boolean; tooLarge: boolean; message: string; fileName: string }>>({});
  /** The exact import (rows and the user's sheet and rate-column choices) held in memory so Resume save re-sends the same data. */
  const interruptedRef = useRef<Map<string, { imp: BoqImport; bytes: Uint8Array }>>(new Map());
  /** Imports saved on the server that were interrupted in an earlier session (summary only; rows were not kept). */
  const [serverPending, setServerPending] = useState<PendingImport[]>([]);
  /** Which BOQ documents are excluded and which revision is selected per document. Persisted with the case evidence. */
  const [inclusion, setInclusion] = useState<BoqInclusionState>(EMPTY_INCLUSION);

  // Local classification so grouped rows show before processing. "Processed" is separate.
  // The registry's category (including a manual correction) is the processing role; the override map mirrors it for rows without bytes.
  const localFiles: ClassifiedFile[] = useMemo(
    () => incoming.map((f) => { let c = classifyOne(f); const o = roleOverride[f.path]; return o ? { ...c, role: o, reason: roleOverride[f.path] !== c.role ? 'Moved by you' : c.reason } : c; }),
    [incoming, roleOverride],
  );
  const signature = useMemo(() => incoming.map((f) => `${f.path}:${f.size}`).join('|'), [incoming]);
  const processed = !!result && processedPaths === signature && !triaging;
  const shownFiles = processed ? files : localFiles;

  /** Open a draft scope: restore only that scope's state. Nothing else is read from browser storage. */
  const openScope = useCallback((id: string, draft: ScopedDraft | null) => {
    epochRef.current += 1;
    scopeRef.current = id;
    setScopeId(id);
    setActiveScope(id);
    const d = draft ?? emptyDraft(id);
    registry.current.clear();
    reads.current = new AnalysisReadCache();
    setIncoming(d.files);
    setRoleOverride(d.roleOverride as Record<string, FileRole>);
    roleOverrideRef.current = d.roleOverride as Record<string, FileRole>;
    setSubroles(d.subroles);
    setNarrative(d.narrative);
    setScheduleChoice(d.scheduleChoice);
    setSample(d.sample);
    setStaleReason(d.stale ? d.staleReason : '');
    setDraftSavedAt(d.savedAt);
    setMissingBytes(new Set(d.files.map((f) => f.path)));
    setSelectedDocs(new Set());
    setResult(null); setFiles([]); setProcessedPaths(''); setProject(null); setBaseline('');
    setAnalysis(null); analysisRef.current = null; setLastExtracted([]); lastExtractedRef.current = [];
    setQAnswers({}); setProcessedBoqKeys(new Set());
    setRealCase(null); setBoqImports([]); setPersistence(null); setSaveError(''); setStartNotes([]); setInclusion(EMPTY_INCLUSION);
    setSub('pack');
    bump();
  }, [bump]);

  // Mount: open THIS tab's active draft if there is one, otherwise a fresh empty PVR. Older drafts are only offered, never opened.
  useEffect(() => {
    const active = getActiveScope();
    const draft = active ? loadDraft(active) : null;
    const id = draft ? active : newScopeId();
    openScope(id, draft);
    setResumable(resumableDrafts(id));
    setHydrated(true);
  }, [openScope]);

  // Restore the server case linked to THIS scope (documents, evidence, imports). Late results from a previous scope are discarded.
  useEffect(() => {
    if (!hydrated || !scopeId) return;
    const myEpoch = epochRef.current;
    const stillCurrent = () => epochRef.current === myEpoch && scopeRef.current === scopeId;
    const id = getCaseFor(scopeId);
    if (!id) return;
    void loadRealCase(id).then(async (loaded) => {
      if (!stillCurrent()) return;
      if (!loaded.case) { setSaveError(loaded.error); setCaseFor(scopeId, ''); return; }
      setRealCase(loaded.case);
      setBoqImports(loaded.imports);
      setServerPending(loaded.pending);
      setPersistence(loaded.persistence);
      const ev = await loadEvidence(loaded.case.id);
      if (!stillCurrent()) return;
      if (ev.evidence) {
        setNarrative((cur) => (cur.trim() ? cur : ev.evidence!.narrative));
        const { [INCLUSION_ANSWER_KEY]: _inclusion, ...plainAnswers } = ev.evidence.answers ?? {};
        void _inclusion;
        setQAnswers(plainAnswers);
        setInclusion(parseInclusion(ev.evidence.answers));
      }
      const rs = await restoreDocuments(loaded.case.id, registry.current);
      if (!stillCurrent()) return;
      if (rs.error) setDocMessage(`Could not restore stored documents: ${rs.error}`);
      else if (rs.restored > 0) setDocMessage(`Restored ${rs.restored} document(s) from storage.`);
      // The server list is authoritative for which documents are active: a locally listed file the server no longer has was removed.
      const docs = registry.current.list();
      const serverPaths = new Set(docs.map((d) => d.path));
      const needs = new Set(rs.needReconnect.map((n) => n.path));
      setIncoming((prev) => {
        const kept = loaded.persistence.mode === 'server' && !rs.error ? prev.filter((p) => serverPaths.has(p.path)) : prev;
        const seen = new Set(kept.map((p) => p.path));
        return [...kept, ...docs.filter((d) => !seen.has(d.path)).map((d) => ({ path: d.path, size: d.size }))];
      });
      setMissingBytes((s) => {
        const next = new Set(Array.from(s).filter((p) => loaded.persistence.mode !== 'server' || rs.error ? true : serverPaths.has(p) && needs.has(p)));
        needs.forEach((p) => next.add(p));
        docs.forEach((d) => { if (!needs.has(d.path) && registry.current.hasBytes(d.path)) next.delete(d.path); });
        return next;
      });
      const ro: Record<string, FileRole> = {};
      const sr: Record<string, string> = {};
      docs.forEach((d) => { if (d.role && d.role !== 'unused') ro[d.path] = d.role as FileRole; if (d.subrole) sr[d.path] = d.subrole; });
      setRoleOverride((r) => ({ ...r, ...ro }));
      setSubroles((r) => ({ ...r, ...sr }));
      bump();
    });
  }, [hydrated, scopeId, bump]);

  const buildDraft = useCallback((): ScopedDraft => ({
    scopeId, files: incoming, roleOverride, subroles, narrative, scheduleChoice, sample,
    caseId: realCase?.id ?? getCaseFor(scopeId), stale: !!staleReason, staleReason, savedAt: stamp(), updatedAtIso: new Date().toISOString(),
  }), [scopeId, incoming, roleOverride, subroles, narrative, scheduleChoice, sample, realCase, staleReason]);

  const saveDraft = useCallback((silent = false) => {
    if (!scopeId) return;
    const d = buildDraft();
    if (persistDraft(d)) {
      setDraftSavedAt(d.savedAt);
      if (!silent) toast.success('Draft saved in this browser only.');
    } else toast.error('Could not save the draft. Browser storage is unavailable or full.');
  }, [scopeId, buildDraft]);

  // Autosave after hydration, always into this scope's key.
  useEffect(() => {
    if (!hydrated || !scopeId) return;
    const t = window.setTimeout(() => saveDraft(true), 800);
    return () => window.clearTimeout(t);
  }, [hydrated, scopeId, saveDraft]);

  const addFiles = useCallback((list: IncomingFile[]) => {
    setIncoming((prev) => {
      const seen = new Set(prev.map((p) => p.path));
      return [...prev, ...list.filter((l) => !seen.has(l.path))];
    });
    setError('');
  }, []);

  const loadSample = () => {
    epochRef.current += 1;
    setIncoming(demoPack());
    setRoleOverride({});
    setSubroles({});
    setSample(true);
    setResult(null);
    setProcessedPaths('');
    setScheduleChoice('');
    setAnalysis(null);
    setSelectedDocs(new Set());
    setStaleReason('');
    registry.current.clear();
    reads.current = new AnalysisReadCache();
    setMissingBytes(new Set());
    if (narrative.trim().length === 0) setNarrative('Extend access road R4 from 5.0 km to 7.0 km, including pavement, kerbs and lighting.');
  };

  /**
   * The document set changed. Disconnect everything derived from it from the ACTIVE assessment (analysis, extracted text,
   * triage result, mappings, drawing pairs, answers, selected programme) and cancel any in-flight job by bumping the epoch.
   * Historical assessment versions are not touched; the current results are only marked stale.
   */
  const invalidateDerived = useCallback((reason: string) => {
    epochRef.current += 1;
    setAnalysis(null); analysisRef.current = null;
    setLastExtracted([]); lastExtractedRef.current = [];
    setResult(null); setFiles([]); setProcessedPaths('');
    setAnalysing(false); setAnalysisError('');
    setTriaging(false);
    setQAnswers({});
    setBaseline('');
    setProcessedBoqKeys(new Set());
    setStaleReason(reason);
    setSub((s) => (s === 'pack' ? s : 'pack'));
  }, []);

  /** Pull the registry-derived lists back into React state after a mutation so both lists and readiness agree. */
  const syncFromRegistry = useCallback((removedPaths: string[]) => {
    const gone = new Set(removedPaths);
    setIncoming((prev) => prev.filter((p) => !gone.has(p.path)));
    setRoleOverride((prev) => { const n = { ...prev }; removedPaths.forEach((p) => delete n[p]); roleOverrideRef.current = n; return n; });
    setSubroles((prev) => { const n = { ...prev }; removedPaths.forEach((p) => delete n[p]); return n; });
    setMissingBytes((s) => { const n = new Set(s); removedPaths.forEach((p) => n.delete(p)); return n; });
    setScheduleChoice((c) => (gone.has(c) ? '' : c));
    setBaseline((b) => (gone.has(b) ? '' : b));
    setSelectedDocs(new Set());
    bump();
  }, [bump]);

  const activeCaseId = (): string => realCase?.id ?? getCaseFor(scopeRef.current);

  /**
   * Remove documents from THIS PVR. For a server case the unlink is persisted first; on failure nothing local changes and
   * the reason is shown. Stored originals are kept on the server (they may be referenced elsewhere).
   */
  const removeDocs = useCallback(async (ids: string[], message?: string): Promise<boolean> => {
    const recs = ids.map((id) => registry.current.get(id)).filter((d): d is DocRecord => !!d);
    const metaOnly = ids.filter((id) => !registry.current.get(id));
    if (recs.length === 0 && metaOnly.length === 0) return true;
    setDocBusy(true);
    try {
      const caseId = activeCaseId();
      if (caseId) {
        const res = await removeOnServer(caseId, recs.map((d) => d.id), 'Documents were removed from this PVR.');
        if (!res.ok) {
          setFeedback(`Could not remove ${recs.length === 1 ? 'the document' : 'the documents'}: ${res.error} Nothing was changed.`);
          toast.error(`Removal failed: ${res.error}`);
          return false;
        }
      }
      const paths = recs.map((d) => d.path);
      registry.current.remove(recs.map((d) => d.id));
      syncFromRegistry(paths);
      invalidateDerived('documents were removed from this PVR.');
      const text = message ?? (recs.length === 1 ? 'Document removed.' : `${recs.length} documents removed.`);
      setFeedback(text);
      toast.success(text);
      return true;
    } finally {
      setDocBusy(false);
    }
  }, [syncFromRegistry, invalidateDerived, realCase, persistence]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Remove ALL active documents (every upload path) but keep the narrative. Server failure leaves everything as it was. */
  const clearAllDocs = useCallback(async () => {
    setDocBusy(true);
    try {
      const caseId = activeCaseId();
      const ids = registry.current.list().map((d) => d.id);
      if (caseId && ids.length > 0) {
        const res = await removeOnServer(caseId, ids, 'All documents were cleared from this PVR.');
        if (!res.ok) {
          setFeedback(`Could not clear the documents: ${res.error} Nothing was changed.`);
          toast.error(`Clearing failed: ${res.error}`);
          return;
        }
      }
      epochRef.current += 1;
      registry.current.clear();
      reads.current = new AnalysisReadCache();
      setIncoming([]);
      setRoleOverride({}); roleOverrideRef.current = {};
      setSubroles({});
      setScheduleChoice('');
      setSample(false);
      setSelectedDocs(new Set());
      setMissingBytes(new Set());
      setDocMessage('');
      invalidateDerived('all documents were cleared from this PVR.');
      // Persist the emptied state immediately so a refresh cannot bring the files back. The narrative is kept.
      persistDraft({ ...buildDraft(), files: [], roleOverride: {}, subroles: {}, scheduleChoice: '', sample: false, stale: true, staleReason: 'all documents were cleared from this PVR.', savedAt: stamp(), updatedAtIso: new Date().toISOString() });
      bump();
      setFeedback('Documents cleared; narrative retained.');
      toast.success('Documents cleared; narrative retained.');
    } finally {
      setDocBusy(false);
    }
  }, [invalidateDerived, buildDraft, bump, realCase, persistence]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Change category (and drawing / programme sub-role). Updates the processing role, drops stale derived data, never claims parsing. */
  const reclassifyDocs = useCallback(async (ids: string[], categoryKey: string, subrole: string, metadata: Record<string, string>) => {
    const cat = CATEGORY_OPTIONS.find((c) => c.key === categoryKey);
    if (!cat) return;
    const recs = ids.map((id) => registry.current.get(id)).filter((d): d is DocRecord => !!d);
    if (recs.length === 0) return;
    setDocBusy(true);
    try {
      const caseId = activeCaseId();
      if (caseId) {
        for (const d of recs) {
          const res = await reclassifyOnServer(caseId, d.id, cat.role, subrole, { ...(d.metadata ?? {}), ...metadata });
          if (!res.ok) { setFeedback(`Could not change the category of ${d.name}: ${res.error} No categories were changed.`); toast.error(`Reclassification failed: ${res.error}`); return; }
        }
      }
      const ro = { ...roleOverrideRef.current };
      const sr: Record<string, string> = {};
      for (const d of recs) {
        registry.current.reclassify(d.id, cat.role, subrole, metadata);
        ro[d.path] = cat.role;
        if (subrole) sr[d.path] = subrole;
      }
      roleOverrideRef.current = ro;
      setRoleOverride(ro);
      setSubroles((prev) => { const n = { ...prev }; recs.forEach((d) => { if (sr[d.path]) n[d.path] = sr[d.path]; else delete n[d.path]; }); return n; });
      // A programme that is no longer a programme must stop being the selected assessment programme.
      setScheduleChoice((c) => (recs.some((d) => d.path === c) && cat.role !== 'schedule' ? '' : c));
      setBaseline((b) => (recs.some((d) => d.path === b) && cat.role !== 'schedule' ? '' : b));
      // A BOQ workbook that moved into BOQ becomes available to the automatic BOQ interpretation again.
      setProcessedBoqKeys((s) => { const n = new Set(s); recs.forEach((d) => n.delete(d.id)); return n; });
      invalidateDerived('document categories were changed.');
      bump();
      const text = recs.length === 1 ? `Category changed to ${cat.label}.` : `${recs.length} documents reclassified.`;
      setFeedback(text);
      toast.success(text);
    } finally {
      setDocBusy(false);
    }
  }, [invalidateDerived, bump, realCase, persistence]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Replace a document's file. The new version becomes active, the old one is unlinked, affected results need recalculation. */
  const replaceDoc = useCallback((id: string) => {
    const old = registry.current.get(id);
    if (!old) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      setDocBusy(true);
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const caseId = activeCaseId();
        const newPath = old.path.includes('/') ? `${old.path.slice(0, old.path.lastIndexOf('/') + 1)}${f.name}` : f.name;
        if (caseId) {
          const res = await removeOnServer(caseId, [old.id], 'A document was replaced.');
          if (!res.ok) { setFeedback(`Could not replace ${old.name}: ${res.error} Nothing was changed.`); toast.error(`Replace failed: ${res.error}`); return; }
        }
        const keepRole = old.role;
        const keepSub = old.subrole ?? '';
        const keepMeta = old.metadata;
        registry.current.remove([old.id]);
        const doc = await registry.current.add(newPath, bytes, keepRole);
        if (old.roleManual || keepSub) registry.current.reclassify(doc.id, keepRole, keepSub, keepMeta);
        setIncoming((prev) => [...prev.filter((p) => p.path !== old.path && p.path !== newPath), { path: newPath, size: f.size }]);
        const ro = { ...roleOverrideRef.current }; delete ro[old.path]; ro[newPath] = keepRole as FileRole; roleOverrideRef.current = ro; setRoleOverride(ro);
        setSubroles((prev) => { const n = { ...prev }; delete n[old.path]; if (keepSub) n[newPath] = keepSub; return n; });
        setScheduleChoice((c) => (c === old.path ? newPath : c));
        setMissingBytes((s) => { const n = new Set(s); n.delete(old.path); n.delete(newPath); return n; });
        setSelectedDocs(new Set());
        invalidateDerived('a document was replaced with a new version.');
        bump();
        setFeedback(`Replaced ${old.name} with ${f.name}. The new version is active; affected results need recalculation.`);
        toast.success('File replaced.');
      } finally {
        setDocBusy(false);
      }
    };
    input.click();
  }, [invalidateDerived, bump, realCase, persistence]); // eslint-disable-line react-hooks/exhaustive-deps

  /** View/download: a signed link for a stored document, or the in-browser bytes otherwise. */
  const viewDoc = useCallback(async (id: string) => {
    const d = registry.current.get(id);
    if (!d) return;
    const bytes = registry.current.bytesOf(id);
    if (bytes) {
      const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
      const url = URL.createObjectURL(new Blob([copy]));
      const a = document.createElement('a'); a.href = url; a.download = d.name; document.body.appendChild(a); a.click(); a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return;
    }
    const caseId = activeCaseId();
    if (!caseId || !d.storagePath) { toast.error('The contents of this file are not available. Reconnect the file first.'); return; }
    const link = await signedDocLink(caseId, id);
    if (link.error) { toast.error(link.error); return; }
    window.open(link.url, '_blank', 'noopener,noreferrer');
  }, [realCase]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Start a fresh PVR context. The previous draft stays saved as its own draft (or is discarded when the user chose to). */
  const startNewPvr = useCallback((saveCurrent: boolean) => {
    if (saveCurrent) persistDraft(buildDraft()); else if (scopeRef.current) discardDraft(scopeRef.current);
    const id = newScopeId();
    openScope(id, null);
    persistDraft(emptyDraft(id));
    setResumable(resumableDrafts(id));
    setFeedback(saveCurrent ? 'New PVR started. Your previous PVR was kept as a separate draft.' : 'New PVR started. The previous unsaved draft was discarded.');
    setConfirm(null);
  }, [buildDraft, openScope]);

  const resumeDraft = useCallback((targetScope: string) => {
    persistDraft(buildDraft());
    const draft = targetScope === '__legacy__' ? adoptLegacyDraft() : loadDraft(targetScope);
    if (!draft) { toast.error('That draft could not be opened.'); return; }
    openScope(draft.scopeId, draft);
    setResumable(resumableDrafts(draft.scopeId));
    setFeedback('Previous draft resumed.');
  }, [buildDraft, openScope]);

  /** Single entry point for real bytes from every upload path. Registers content, hash, version and role. */
  const rememberFiles = useCallback(async (m: Map<string, File>) => {
    const myEpoch = epochRef.current;
    for (const [path, f] of Array.from(m.entries())) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (epochRef.current !== myEpoch) return; // the PVR was cleared or replaced while reading; discard this upload
      const role = (roleOverrideRef.current[path] as string | undefined) ?? classifyOne({ path, size: f.size }).role;
      await registry.current.add(path, bytes, role);
    }
    if (epochRef.current !== myEpoch) return;
    setMissingBytes((s) => { const n = new Set(s); m.forEach((_, p) => n.delete(p)); return n; });
    setAnalysis(null);
    setStaleReason((r) => r || 'documents were added since the last analysis.');
    bump();
  }, [bump]);

  /** Reconnect a single file whose contents are missing. The recovered file must match the registered hash when one exists. */
  const reconnect = useCallback((path: string) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const bytes = new Uint8Array(await f.arrayBuffer());
      const known = registry.current.byPath(path);
      const doc = await registry.current.add(path, bytes, known?.role ?? classifyOne({ path, size: f.size }).role);
      if (known && known.sha256 !== doc.sha256) toast.warning(`This file differs from the one originally registered for ${path}. It was added as version ${doc.version}.`);
      setMissingBytes((s) => { const n = new Set(s); n.delete(path); return n; });
      setAnalysis(null);
      bump();
      toast.success(`Reconnected ${path}.`);
    };
    input.click();
  }, [bump]);

  const docActions: DocActions = useMemo(() => ({
    onView: (id) => { void viewDoc(id); },
    onReplace: replaceDoc,
    onRemove: (id) => setConfirm({ kind: 'remove', ids: [id] }),
    onReclassify: (ids, c, s, m) => { void reclassifyDocs(ids, c, s, m); },
    onReconnect: reconnect,
  }), [viewDoc, replaceDoc, reclassifyDocs, reconnect]);

  /** Rows for BOTH document lists, derived from the one registry (plus metadata-only entries without bytes). */
  const managedDocs: ManagedDoc[] = useMemo(() => {
    const out: ManagedDoc[] = [];
    for (const d of registry.current.list()) {
      if (!incoming.some((i) => i.path === d.path)) continue;
      out.push({
        id: d.id, path: d.path, name: d.name, role: d.role, subrole: d.subrole ?? '', metadata: d.metadata ?? {}, roleManual: !!d.roleManual,
        hasBytes: !missingBytes.has(d.path) && registry.current.hasBytes(d.path), stateLabel: DOC_STATE_LABEL[d.state], stateDetail: d.stateDetail,
        stateTone: STATE_TONE[d.state] ?? STATE_TONE.uploaded, version: d.version, size: d.size, sha256: d.sha256,
        categoryLabel: categoryLabel(d.role, d.metadata, d.path), subroleLabel: subroleLabel(d.role, d.subrole),
      });
    }
    return out;
    // registryVersion makes the memo refresh whenever the registry mutates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming, missingBytes, registryVersion]);

  /** Documents handed to the drawing analysis panel: the same registry rows, with their real bytes. */
    const panelDocs: PanelDoc[] = useMemo(() => managedDocs.filter((d) => d.role !== 'reference' && !isProcessedPvrFile(d.path)).map((d) => ({ id: d.id, name: d.path, sha256: d.sha256, role: d.role, bytes: registry.current.bytesOf(d.id) })), [managedDocs]); // eslint-disable-line react-hooks/exhaustive-deps
  const docByPath = useMemo(() => new Map(managedDocs.map((d) => [d.path, d])), [managedDocs]);

  /** Read the actual uploaded files and analyse them. Nothing typed is required. */
  const runAnalysis = useCallback(async (answers: Record<string, string> = qAnswers): Promise<AnalysisOutput | null> => {
    const myEpoch = epochRef.current;
    let current = () => epochRef.current === myEpoch;
    setAnalysing(true);
    setAnalysisError('');
    try {
      const inputs: InputFile[] = [];
      for (const f of files) {
        if (f.role === 'reference' || isProcessedPvrFile(f.path)) continue;
        inputs.push({ name: f.name, bytes: registry.current.bytesByPath(f.path), role: f.role });
      }
      const manual = manualQty.trim() && manualComponent.trim() ? { quantity: [{ componentId: manualComponent.trim(), value: manualQty.trim(), unit: manualUnit }] } : undefined;
      // Answers are applied as typed resolutions to the inputs, then the whole comparison is re-run.
      const readCache = reads.current;
      const first = await analyseDocuments({ files: inputs, narrative, manual, extractor: serverExtractor, readCache });
      if (!current()) return null; // the document set changed while this ran: its output is obsolete
      const resolutions = resolutionsFrom(first.questions, answers);
      const hasResolutions = Object.keys(resolutions.pairOverride).length + Object.keys(resolutions.unitOverride).length + Object.keys(resolutions.quantitySource).length > 0 || !!resolutions.eventDate;
      const res = hasResolutions ? await analyseDocuments({ files: inputs, narrative, manual, resolutions, extractor: serverExtractor, readCache }) : first;
      if (!current()) return null;
      setAnalysis(res);
      analysisRef.current = res;
      lastExtractedRef.current = res.extracted;
      setLastExtracted(res.extracted);
      setStaleReason('');
      // A changed interpretation invalidates answers that no longer correspond to a question.
      const live = new Set(res.questions.map((q) => q.id));
      const kept = Object.fromEntries(Object.entries(answers).filter(([k]) => live.has(k)));
      if (Object.keys(kept).length !== Object.keys(answers).length) setQAnswers(kept);
      // Mark parsed documents.
      for (const r of res.files) {
        const d = registry.current.byPath(files.find((x) => x.name === r.fileName || x.path.endsWith(`/${r.fileName}`))?.path ?? r.fileName);
        if (d) registry.current.setState(d.id, r.state === 'unsupported' ? 'needs_clarification' : r.state === 'failed' ? 'failed' : r.state === 'read' || r.state === 'validated' ? 'parsed' : d.state, r.detail);
      }
      bump();
      return res;
    } catch (e) {
      if (current()) setAnalysisError(e instanceof Error ? `The analysis failed: ${e.message}` : 'The analysis failed.');
      return null;
    } finally {
      if (current()) setAnalysing(false);
    }
  }, [files, narrative, manualQty, manualComponent, manualUnit, qAnswers, bump]);

  /** An answer changes the interpretation: record it, persist it, and re-run the comparison with it applied. */
  const answerQuestion = useCallback((id: string, opt: string) => {
    const next = { ...qAnswers, [id]: opt };
    setQAnswers(next);
    if (realCase) void saveEvidence(realCase.id, { answers: next });
    void runAnalysis(next);
  }, [qAnswers, realCase, runAnalysis]);

  /** Create the real case on first need, independent of any BOQ confirmation. */
  const ensureRealCase = useCallback(async (): Promise<string> => {
    if (realCase) return realCase.id;
    const myEpoch = epochRef.current;
    const myScope = scopeRef.current;
    const title = narrative.trim().split(/[.\n]/)[0].slice(0, 90) || 'New PVR';
    const created = await createRealCase(title, CURRENCY);
    if (!created.case) {
      setPersistence(created.persistence);
      throw new Error(created.error || 'The case could not be created.');
    }
    // Always link the new case to the scope that asked for it, but only touch the screen if that scope is still open.
    setCaseFor(myScope, created.case.id);
    if (epochRef.current === myEpoch && scopeRef.current === myScope) {
      setPersistence(created.persistence);
      setRealCase(created.case);
    }
    return created.case.id;
  }, [realCase, narrative]);

  /**
   * Save one import. Server cases use the staged path (initialise, bounded batches, finalise): the original file is stored
   * once (reused on retry), batches are sent by size, and the import only becomes Ready when finalisation succeeds.
   * A failure keeps the exact import in memory so "Resume save" re-sends only the missing batches.
   */
  const persistImport = useCallback(async (c: CaseRecord, imp: BoqImport, originalBytes: Uint8Array): Promise<void> => {
    const setState = (patch: Partial<{ fileStored: boolean; fileError: string; progress: SaveProgress | null; interrupted: boolean; tooLarge: boolean; message: string }>) =>
      setSaveState((s) => {
        const base = { fileStored: false, fileError: '', progress: null as SaveProgress | null, interrupted: false, tooLarge: false, message: '', fileName: imp.source.fileName };
        const prev = s[imp.id] ?? base;
        return { ...s, [imp.id]: { ...prev, ...patch } };
      });
    setSaveError('');
    // 1. Original file: stored once. On retry the server verifies case, owner and hash and reuses the stored object.
    const prior = saveState[imp.id];
    let withFile = imp;
    let fileStored = !!prior?.fileStored || !!imp.source.fileStored;
    let fileError = prior?.fileError ?? '';
    if (!fileStored) {
      const file = await storeOriginalFile(imp.caseId, imp, originalBytes);
      fileStored = file.stored;
      fileError = file.error;
      if (file.stored) withFile = { ...imp, source: { ...imp.source, storagePath: file.storagePath, fileStored: true, uploadedAt: file.uploadedAt } };
    } else if (prior?.fileStored) {
      withFile = interruptedRef.current.get(imp.id)?.imp ?? imp;
    }
    setState({ fileStored, fileError, interrupted: false, tooLarge: false, message: '' });
    interruptedRef.current.set(imp.id, { imp: withFile, bytes: originalBytes });

    if (c.id.startsWith('session-')) {
      const res = await saveImport(c, withFile, boqImports);
      setPersistence(res.persistence);
      if (res.error) { setState({ interrupted: true, message: res.error }); setSaveError(res.error); throw new Error(`The BOQ import was not saved. ${res.error}`); }
      interruptedRef.current.delete(imp.id);
      setState({ progress: { phase: 'complete', savedRows: withFile.rows.length, totalRows: withFile.rows.length, savedBatches: 1, totalBatches: 1 } });
    } else {
      const res = await saveImportStaged(c, withFile, (p) => setState({ progress: p }));
      setPersistence(res.persistence);
      if (!res.complete) {
        const msg = res.tooLarge && res.oversized.length === 0
          ? res.error
          : res.error;
        setState({ progress: res.progress, interrupted: res.resumable, tooLarge: res.tooLarge, message: msg });
        setSaveError(msg);
        toast.error(res.resumable ? 'BOQ rows were only partly saved. Use Resume save.' : 'The BOQ import was not saved. ' + msg);
        throw new Error(`The BOQ import was not saved. ${msg}`);
      }
      interruptedRef.current.delete(imp.id);
      setState({ progress: res.progress, interrupted: false, tooLarge: false, message: '' });
    }
    // Ready only now: the server confirmed every batch and row.
    setBoqImports((list) => [...list.filter((i) => i.id !== imp.id), withFile]);
    setServerPending((l) => l.filter((p) => p.id !== imp.id));
    setRealCase((cur) => (cur ? { ...cur, selectedImportId: cur.selectedImportId ?? imp.id } : { ...c, selectedImportId: c.selectedImportId ?? imp.id }));
    if (!fileStored) toast.warning(`BOQ revision ${imp.revision} was saved, but the original file was NOT stored: ${fileError}`);
    else toast.success(`BOQ revision ${imp.revision} confirmed: ${imp.rows.filter((r) => r.included).length} rows from ${imp.source.fileName}. Original file stored privately.`);
  }, [boqImports, saveState]);

  const onBoqConfirmed = useCallback(async (imp: BoqImport, originalBytes: Uint8Array) => {
    // Idempotence: identical content for the same document is never saved as another import. Retried or restored
    // uploads reuse the import that already exists. Nothing is deleted.
    const dup = boqImports.find((i) => i.id !== imp.id && i.confirmedAt && i.source.sha256 === imp.source.sha256 && i.source.fileName.trim().toLowerCase() === imp.source.fileName.trim().toLowerCase());
    if (dup) { toast.info(`${imp.source.fileName} is identical to revision ${dup.revision} already on this case, so it was not imported again.`); return; }
    let c = realCase;
    if (!c || c.id !== imp.caseId) {
      // The case was created during this confirm. Re-read it so a session-only case keeps its stored record.
      const reloaded = await loadRealCase(imp.caseId);
      c = reloaded.case ?? { id: imp.caseId, title: narrative.trim().split(/[.\n]/)[0].slice(0, 90) || 'New PVR', mode: 'real', currency: CURRENCY, createdAt: new Date().toISOString(), selectedImportId: null };
    }
    await persistImport(c, imp, originalBytes);
  }, [realCase, narrative, persistImport, boqImports]);

  /** Re-send only the missing batches of an interrupted import, using the same import id and the same data. */
  const resumeSave = useCallback(async (importId: string) => {
    const held = interruptedRef.current.get(importId);
    let c = realCase;
    if (!held || !c) { toast.error('The interrupted import is no longer in memory. Upload the BOQ again; rows already saved are not lost.'); return; }
    try { await persistImport(c, held.imp, held.bytes); } catch { /* the failure is already shown */ }
  }, [realCase, persistImport]);

  /** BOQ set -> documents -> revisions. Different bills are all included; only revisions of one document compete. */
  const boqModel = useMemo(() => buildBoqModel(boqImports, inclusion, realCase?.selectedImportId ?? null), [boqImports, inclusion, realCase?.selectedImportId]);

  /** Persist the inclusion state. The in-memory state only changes after the server confirmed (or for a temporary case). */
  const saveInclusion = useCallback(async (next: BoqInclusionState): Promise<boolean> => {
    if (!realCase) return false;
    if (realCase.id.startsWith('session-')) { setInclusion(next); return true; }
    const res = await saveEvidence(realCase.id, { answers: { ...qAnswers, [INCLUSION_ANSWER_KEY]: serialiseInclusion(next) } });
    if (!res.saved) { toast.error(`Could not save the BOQ selection: ${res.error}`); return false; }
    setInclusion(next);
    return true;
  }, [realCase, qAnswers]);

  const setDocumentIncluded = useCallback(async (key: string, include: boolean) => {
    const excluded = { ...inclusion.excluded };
    if (include) delete excluded[key]; else excluded[key] = 'Excluded by you from this assessment.';
    if (await saveInclusion({ ...inclusion, excluded })) toast.success(include ? 'Document included in the assessment. Re-run the analysis to use it.' : 'Document excluded from the assessment. Its data is kept.');
  }, [inclusion, saveInclusion]);

  /** Select one revision of ONE document. Other documents are not touched. */
  const selectDocumentRevision = useCallback(async (key: string, importId: string) => {
    if (!realCase) return;
    const next = { ...inclusion, selected: { ...inclusion.selected, [key]: importId } };
    if (!(await saveInclusion(next))) return;
    // Keep the case-level pointer in step when it pointed at another revision of the same document, so single-item
    // calculations and stale-calculation review follow the document's selected revision.
    const cur = boqImports.find((i) => i.id === realCase.selectedImportId);
    if (!cur || cur.source.fileName.trim().toLowerCase() === boqImports.find((i) => i.id === importId)?.source.fileName.trim().toLowerCase()) {
      const res = await selectImportRevision(realCase, importId, boqImports);
      if (res.case) setRealCase(res.case);
    }
    toast.success('Revision selected for this document. Calculations made on the previous revision now need review.');
  }, [realCase, inclusion, saveInclusion, boqImports]);

  const openOriginal = useCallback(async (importId: string) => {
    if (!realCase) return;
    const link = await getOriginalFileLink(realCase.id, importId);
    if (link.error) { toast.error(link.error); return; }
    window.open(link.url, '_blank', 'noopener,noreferrer');
  }, [realCase]);

  /** Coverage register: one row per uploaded document, with upload / read / processed / used kept separate. */
  const coverage = useMemo(() => {
    const run = realCase ? readRunRecord(realCase.id) : null;
    const docs = registry.current.list().filter((d) => incoming.some((i) => i.path === d.path)).map((d) => {
      const stored = d.state === 'stored' || d.state === 'parsed' || !!d.storagePath;
      return { id: d.id, name: d.name, category: categoryLabel(d.role, d.metadata, d.path), role: d.role, sha256: d.sha256, version: d.version, stored, storageDetail: stored ? '' : d.stateDetail, state: d.state, stateDetail: d.stateDetail, hasBytes: registry.current.hasBytes(d.path) };
    });
    return buildCoverage(
      docs,
      boqModel,
      { readNames: [...(run?.boqFiles ?? []), ...(run?.evidenceRead ?? [])], unreadNotes: run?.evidenceUnread ?? {}, runAt: run?.runAt ?? null, importSignature: run?.importSignature ?? null },
      importSignatureOf(boqModel.assessmentImports),
    );
    // registryVersion makes this refresh whenever the registry mutates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming, boqModel, realCase, registryVersion, saveState]);

  const addToGroup = (g: DocGroup) => {
    if (!g.addAs) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = async () => {
      const list = Array.from(input.files ?? []);
      if (list.length === 0) return;
      // Group-specific additions go through the SAME registry as the main upload, with the group's role.
      const map = new Map<string, File>();
      list.forEach((f) => map.set(f.name, f));
      roleOverrideRef.current = { ...roleOverrideRef.current, ...Object.fromEntries(list.map((f) => [f.name, g.addAs as FileRole])) };
      await rememberFiles(map);
      const added: IncomingFile[] = list.map((f) => ({ path: f.name, size: f.size }));
      addFiles(added);
      setRoleOverride((prev) => { const next = { ...prev }; added.forEach((a) => { next[a.path] = g.addAs as FileRole; }); return next; });
    };
    input.click();
  };

  const runTriage = useCallback(async () => {
    const myEpoch = epochRef.current;
    let current = () => epochRef.current === myEpoch;
    setError('');
    setTriaging(true);
    setSub('triage');
    setProgress(4);
    const labels = STAGE_TEXT(incoming.length);
    let i = 0;
    setStageText(labels[0]);
    const timer = window.setInterval(() => {
      i += 1;
      setProgress((p) => Math.min(92, p + 18));
      setStageText(labels[Math.min(2, Math.floor(i / 2))]);
    }, 420);
    try {
      const res = await fetch('/api/intake/triage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: incoming }) });
      const data = (await res.json()) as TriageResult & { error?: string; details?: string };
      if (!current()) return; // documents were removed/replaced or another PVR was opened: ignore this late response
      if (!res.ok || data.error) throw new Error(data.details || data.error || 'Triage failed');
      const live = new Set(incoming.map((f) => f.path));
      const merged = data.files.filter((f) => live.has(f.path)).map((f) => (roleOverride[f.path] ? { ...f, role: roleOverride[f.path], reason: 'Moved by you' } : f));
      setResult(data);
      setFiles(merged);
      setProcessedPaths(incoming.map((f) => `${f.path}:${f.size}`).join('|'));
      setProgress(100);
    } catch (e) {
      if (!current()) return;
      setError(e instanceof Error ? e.message : 'We could not organise those files. Go back and try again.');
      setResult(null);
      setSub('pack');
    } finally {
      window.clearInterval(timer);
      if (current()) setTriaging(false);
    }
  }, [incoming, roleOverride]);

  const move = useCallback((path: string, role: FileRole) => {
    setFiles((prev) => prev.map((f) => (f.path === path ? { ...f, role, reason: 'Moved by you' } : f)));
    setRoleOverride((prev) => { const n = { ...prev, [path]: role }; roleOverrideRef.current = n; return n; });
    // Keep the registry (the single source of truth) in step so the role is a real, audited manual correction.
    const d = registry.current.byPath(path);
    if (d && d.role !== role) {
      registry.current.reclassify(d.id, role, '', d.metadata);
      const caseId = realCase?.id ?? getCaseFor(scopeRef.current);
      if (caseId) void reclassifyOnServer(caseId, d.id, role, '', d.metadata);
      bump();
    }
  }, [bump, realCase]);

  const readiness = useMemo(
    () => computeReadiness({ files: shownFiles, processed, failed: !!error, narrative, scheduleChoice }),
    [shownFiles, processed, error, narrative, scheduleChoice],
  );
  const action = primaryAction(readiness, incoming.length > 0, processed, narrative);

  const needsBaseline = files.filter((f) => f.role === 'schedule').length > 1 && !baseline;
  const triageReady = !!result && !triaging && !!project && !needsBaseline;

  /**
   * Stage-specific readiness for "Continue to assessment". Only a missing change description blocks it, because
   * scope analysis needs readable change evidence. A missing BOQ, programme, quantity or event date blocks only
   * the later stage that needs it, and is reported as a warning with its real cause.
   */
  const startReady = useMemo((): { ok: boolean; reason: string; warnings: string[] } => {
    const warnings: string[] = [];
    const hasEvidence = files.some((f) => f.role === 'pvr' || f.role === 'drawings' || f.role === 'correspondence') || narrative.trim().length > 10;
    if (!hasEvidence) return { ok: false, reason: 'Add a change request, a drawing, or describe the change so there is something to analyse.', warnings };
    const lost = files.filter((f) => !registry.current.hasBytes(f.path));
    if (lost.length > 0) warnings.push(`${lost.length} file(s) have no readable contents (${lost.slice(0, 2).map((l) => l.name).join(', ')}${lost.length > 2 ? '…' : ''}). Reconnect them to include their evidence.`);
    const boqFiles = files.filter((f) => f.role === 'boq').length;
    if (boqFiles === 0 && boqImports.length === 0) warnings.push('No BOQ yet: BOQ matching and cost need one, but scope analysis can proceed.');
    if (!files.some((f) => f.role === 'schedule')) warnings.push('No programme (.xer) yet: schedule impact will wait for one.');
    return { ok: true, reason: '', warnings };
    // registryVersion is read so the memo refreshes when file contents are added or reconnected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, narrative, boqImports.length, registryVersion]);

  const onPrimaryPack = () => {
    if (action.kind === 'read') {
      if (incoming.length === 0) {
        // Narrative-only: no files to read. Run triage with an empty file list so prerequisites can evaluate the narrative.
        void runTriage();
      } else {
        void runTriage();
      }
    } else if (action.kind === 'confirm') {
      if (!scheduleChoice && files.filter((f) => f.role === 'schedule').length === 1) setBaseline(files.find((f) => f.role === 'schedule')!.path);
      if (scheduleChoice) setBaseline(scheduleChoice);
      setSub('triage');
    }
  };

  const [starting, setStarting] = useState(false);
  const [startNotes, setStartNotes] = useState<string[]>([]);

  /**
   * "Analyse documents" / "Continue to assessment": create or load the case (no BOQ confirmation needed), store every
   * registered document, persist the original narrative and structured evidence, then open that same case.
   */
  const startAnalysis = async () => {
    if (sample) {
      const fresh = createCase();
      fresh.mode = 'demo';
      try { window.localStorage.setItem('pvr-agent-case-v2', JSON.stringify(fresh)); } catch { /* ignore */ }
      router.push('/case-workspace?demo=1');
      return;
    }
    setStarting(true);
    setStartNotes([]);
    const notes: string[] = [];
    try {
      const caseId = await ensureRealCase();
      // 1. Store every document's actual bytes (BOQs, XERs, drawings, PVR documents).
      const outcomes = await storeAllDocuments(caseId, registry.current);
      const failed = outcomes.filter((o) => !o.stored);
      bump();
      if (failed.length) notes.push(`${failed.length} file(s) were not stored: ${failed.slice(0, 3).map((f) => `${f.path} (${f.error})`).join('; ')}${failed.length > 3 ? '…' : ''}`);
      Array.from(registry.current.list()).forEach((d) => { if (d.role !== 'unused' && !d.roleManual) void setDocRole(caseId, d.id, d.role); });
      // 2. Analyse the available evidence (stage-specific: scope analysis needs only readable change evidence).
      let current = analysis;
      if (!current && (files.length > 0 || narrative.trim().length > 10)) {
        current = await runAnalysis();
      }
      // 3. Persist the ORIGINAL narrative and the structured handoff against the case, not only in this tab.
      const handoff = current ? buildHandoff(current, qAnswers, manualDate, {
        originalNarrative: narrative,
        extractedText: lastExtractedRef.current.map((x) => ({ name: x.name, sha256: registry.current.byPath(x.name)?.sha256 ?? '', text: x.text })),
        documents: registry.current.list().map((d) => ({ id: d.id, name: d.path, sha256: d.sha256, version: d.version, role: d.role })),
        analysisVersion: Math.max(1, nextVersion(scopeRef.current) - 1),
      }) : null;
      if (handoff && current && !current.cancelled) handoff.drawingReplay = buildSavedDrawingReplay(current) ?? undefined;
      const ev = await saveEvidence(caseId, { narrative, handoff, answers: qAnswers });
      if (!ev.saved) notes.push(`The narrative and analysis were not saved to the case: ${ev.error}`);
      if (handoff) saveHandoff(caseId, handoff);
      setCaseFor(scopeRef.current, caseId);
      setStartNotes(notes);
      // Missing storage is shown, but never blocks work that does not depend on it.
      if (notes.length && failed.length === outcomes.length && outcomes.length > 0) {
        toast.warning('Your files could not be stored on the server, so this case will only hold them in this browser.');
      }
      router.push(`/case-workspace?case=${encodeURIComponent(caseId)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'The case could not be started.';
      setStartNotes([...notes, msg]);
      toast.error(msg);
    } finally {
      setStarting(false);
    }
  };

  const inPack = sub === 'pack';
  const caseTitle = narrative.trim() ? narrative.trim().split(/[.\n]/)[0].slice(0, 90) : 'New PVR';
  const caseRef = sample ? 'PVR-0418' : 'Unassigned';
  const projectName = project ? project.name : sample ? 'Fahid Island Roads Package (sample)' : 'No project linked yet';

  return (
    <div className="flex min-h-[calc(100vh-3.5rem-2.5rem)] flex-col">
      <div className="flex-1 pb-4">
        <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
          <Link href="/project-cases" className="hover:text-foreground">Projects</Link>
          <span aria-hidden> › </span>
          <span>{projectName}</span>
          <span aria-hidden> › </span>
          <span className="text-foreground">{caseRef}</span>
        </nav>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-headline font-bold text-foreground">{caseTitle}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground">
              <span className="rounded-md bg-muted px-2 py-0.5 font-data text-sm text-foreground">{caseRef}</span>
              <span>{projectName}</span>
              {sample ? <span className="rounded-md bg-secondary px-2 py-0.5 text-sm font-medium text-secondary-foreground">Synthetic sample case</span> : null}
            </p>
          </div>
          <span className="inline-flex items-center gap-2 rounded-md bg-secondary px-3 py-1.5 font-medium text-secondary-foreground"><span className="h-2 w-2 rounded-full bg-primary" aria-hidden />Draft</span>
        </div>

        <div className="mt-4"><JourneyStepper current="documents" /></div>

        {error ? <p role="alert" className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-destructive">{error}</p> : null}

        {inPack ? (
          <div className="mt-4 space-y-4">
            <EvidencePack
              files={shownFiles}
              processed={processed}
              reading={reading}
              failed={!!error}
              readiness={readiness}
              narrative={narrative}
              onNarrative={setNarrative}
              scheduleChoice={scheduleChoice}
              onScheduleChoice={setScheduleChoice}
                            uploadSlot={(
                <>
                  <DocumentsStep onAdd={addFiles} onFiles={rememberFiles} onReadingChange={setReading} />
                  <DocumentManager
                    key={registryVersion}
                    docs={managedDocs}
                    actions={docActions}
                    selected={selectedDocs}
                    onSelectedChange={setSelectedDocs}
                    onRemoveSelected={() => setConfirm({ kind: 'remove', ids: Array.from(selectedDocs) })}
                    busy={docBusy}
                    storageNote={sample ? 'Sample case: nothing is stored.' : realCase ? (persistence?.mode === 'server' ? 'Stored privately with the case once you analyse.' : 'Temporary case: files are held in this browser only.') : 'A case is created when you analyse; files are then stored privately with it.'}
                  />
                  {docMessage ? <p role="status" className="mt-2 text-sm text-muted-foreground">{docMessage}</p> : null}
                  <p className="mt-2 text-xs text-muted-foreground">Some file types may not be fully readable. Each document&apos;s status appears in the list above.</p>
                </>
              )}
              onLoadSample={loadSample}
              onClear={() => setConfirm({ kind: 'clear' })}
              onAddToGroup={addToGroup}
              draftSavedAt={draftSavedAt}
              docByPath={docByPath}
              docActions={docActions}
              onStartNew={() => setConfirm({ kind: 'new' })}
              resumable={resumable}
              onResume={resumeDraft}
              staleReason={staleReason}
              feedback={feedback}
              busy={docBusy}
            />
            {!sample ? (
              <div>
                <RequireSignIn purpose="import a BOQ and create a case" returnTo="/new-pvr">
                  <BoqImportPanel
                    caseId={realCase?.id ?? null}
                    currency={CURRENCY}
                    nextRevision={boqImports.reduce((m, i) => Math.max(m, i.revision), 0) + 1}
                    existingImports={boqImports}
                    onConfirmed={(imp, originalBytes) => onBoqConfirmed(imp, originalBytes)}
                    ensureCase={ensureRealCase}
                    autoFiles={registry.current.list().filter((d) => d.role === 'boq' && /\.(xlsx|csv)$/i.test(d.name) && registry.current.bytesOf(d.id)).map((d) => ({ key: `${d.id}`, name: d.name, bytes: registry.current.bytesOf(d.id) as Uint8Array }))}
                    processedKeys={processedBoqKeys}
                    onProcessedKey={(k) => setProcessedBoqKeys((s) => new Set(s).add(k))}
                  />
                </RequireSignIn>
                {persistence ? (
                  <p role="status" className={`mt-2 rounded-md px-4 py-3 text-sm ${persistence.mode === 'server' ? 'bg-secondary text-secondary-foreground' : 'border border-warning/40 bg-warning/10 text-foreground'}`}>
                    {persistence.mode === 'server'
                      ? `Case ${realCase?.id ?? ''} exists on the server and is private to your account. Each import below shows separately whether its record and its original file were saved.`
                      : `Temporary only, NOT saved on the server. ${persistence.blocker}`}
                  </p>
                ) : null}
                {saveError ? <p role="alert" className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-destructive">Save failed: {saveError}</p> : null}
                {Object.entries(saveState).filter(([id, st]) => !boqImports.some((i) => i.id === id) && (st.progress || st.interrupted)).map(([id, st]) => {
                  const p = st.progress;
                  const pct = p && p.totalRows > 0 ? Math.round((p.savedRows / p.totalRows) * 100) : 0;
                  return (
                    <div key={id} role="status" aria-live="polite" className="mt-2 rounded-md border border-border bg-card px-4 py-3 text-sm">
                      <p className="font-medium text-foreground">{st.fileName}</p>
                      <ul className="mt-1 space-y-0.5 text-muted-foreground">
                        <li>{st.fileStored ? 'Original file stored.' : `Original file NOT stored${st.fileError ? `: ${st.fileError}` : '.'}`}</li>
                        {p ? <li>{p.phase === 'complete' ? 'Import complete.' : p.phase === 'finalising' ? 'Verifying and publishing the import…' : `Saving BOQ rows: ${p.savedRows.toLocaleString('en-US')} / ${p.totalRows.toLocaleString('en-US')}`}</li> : null}
                      </ul>
                      {p && p.phase !== 'complete' && !st.interrupted ? <div className="mt-2 h-2 w-full overflow-hidden rounded bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="BOQ rows saved"><div className="h-full bg-primary" style={{ width: `${pct}%` }} /></div> : null}
                      {st.interrupted ? (
                        <div className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-foreground">
                          <p className="font-medium">Import interrupted. It is not Ready and cannot be used until the save finishes.</p>
                          <p className="mt-0.5">{st.tooLarge ? 'The extracted-data batch exceeded the request limit, so it was not accepted. Your sheet and rate-column choices are kept, and rows already saved are not lost. ' : ''}{st.message}</p>
                          <button type="button" onClick={() => void resumeSave(id)} className="mt-2 rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90">Resume save</button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {serverPending.filter((sp) => !saveState[sp.id]).map((sp) => (
                  <div key={sp.id} role="status" className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-foreground">
                    <p className="font-medium">Import interrupted: {sp.fileName} (revision {sp.revision}) — {sp.savedRows.toLocaleString('en-US')} / {sp.expectedRows.toLocaleString('en-US')} rows saved. Not Ready.</p>
                    <p className="mt-0.5 text-muted-foreground">The saved rows are kept. Upload the same BOQ file again to resume; only the missing batches are sent.</p>
                  </div>
                ))}
                {boqImports.length > 0 ? (
                  <div className="mt-2 rounded-md border border-border bg-card" aria-label="BOQ set">
                    <p role="status" className="border-b border-border px-4 py-2.5 text-sm font-semibold text-foreground tabular">{boqModel.summary} {boqModel.itemCount.toLocaleString('en-US')} item(s) in the assessment set.</p>
                    <ul className="divide-y divide-border">
                      {boqModel.documents.map((doc) => (
                        <li key={doc.key} className="px-4 py-3 text-sm">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium text-foreground">{doc.fileName}</span>
                            <span className="flex flex-wrap items-center gap-2">
                              <span className={`rounded px-2 py-0.5 text-xs font-medium ${doc.included ? 'bg-secondary text-secondary-foreground' : 'bg-warning/20 text-foreground'}`}>{doc.included ? 'Included in assessment' : 'Excluded from assessment'}</span>
                              <button type="button" onClick={() => void setDocumentIncluded(doc.key, !doc.included)} className="rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted">{doc.included ? 'Exclude from assessment' : 'Include in assessment'}</button>
                            </span>
                          </div>
                          {!doc.included ? <p className="mt-0.5 text-xs text-muted-foreground">{doc.excludedReason} Its rows and revisions are kept.</p> : null}
                          {doc.competing ? <p className="mt-0.5 text-xs text-muted-foreground">This document has more than one version. Exactly one revision is used; the others are kept as history.</p> : null}
                          <ul className="mt-2 space-y-1.5">
                            {doc.revisions.map((r) => {
                              const imp = boqImports.find((i) => i.id === r.importId);
                              const st = saveState[r.importId];
                              let fileStored = st ? st.fileStored : !!imp?.source.fileStored;
                              const recordOnServer = persistence?.mode === 'server';
                              return (
                                <li key={r.importId} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-3 py-1.5">
                                  <span className="text-foreground">Revision {r.revision}{r.revisionLabel ? ` · ${r.revisionLabel}` : ''}<span className="block font-data text-xs text-muted-foreground">SHA-256 {r.sha256.slice(0, 16)}… · {r.items.toLocaleString('en-US')} item(s){r.unpriced ? ` · ${r.unpriced} unpriced` : ''}{imp?.source.uploadedAt ? ` · uploaded ${imp.source.uploadedAt.slice(0, 19).replace('T', ' ')} UTC` : ''}</span></span>
                                  <span className="flex flex-wrap items-center gap-2">
                                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${r.label === 'selected' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>{REVISION_LABEL_TEXT[r.label]}</span>
                                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${recordOnServer ? 'bg-secondary text-secondary-foreground' : 'bg-warning/15 text-foreground'}`}>{recordOnServer ? 'Record saved on server' : 'Record temporary'}</span>
                                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${fileStored ? 'bg-secondary text-secondary-foreground' : 'bg-warning/15 text-foreground'}`} title={st?.fileError || undefined}>{fileStored ? 'Original file stored privately' : 'Original file NOT stored'}</span>
                                    {r.label === 'superseded' ? <button type="button" onClick={() => void selectDocumentRevision(doc.key, r.importId)} className="rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted">Use this revision</button> : null}
                                    {fileStored && persistence?.mode === 'server' ? <button type="button" onClick={() => void openOriginal(r.importId)} className="rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted">View original file</button> : null}
                                  </span>
                                </li>
                              );
                            })}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div className="mt-3"><CoverageRegister rows={coverage.rows} totals={coverage.totals} /></div>
              </div>
            ) : null}
          </div>
        ) : null}

        {sub === 'triage' ? (
          <div className="mt-4">
            {triaging || !result ? (
              <div role="status" aria-live="polite" className="rounded-lg border border-border bg-card p-6 shadow-sm">
                <h2 className="text-xl font-semibold text-foreground">{stageText || 'Reading your files'}</h2>
                <p className="mt-1 text-muted-foreground">This takes a few seconds.</p>
                <div className="mt-4 h-2.5 w-full overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${progress}%` }} /></div>
                <div className="mt-5 space-y-3" aria-hidden><div className="skeleton h-12 rounded-lg" /><div className="skeleton h-10 rounded-lg" /></div>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-semibold text-foreground">We read {files.length} file{files.length === 1 ? '' : 's'} and organised them</h2>
                    <p className="mb-4 mt-1 max-w-2xl text-muted-foreground">Check the project match and any question below. You can move any file to a different group.</p>
                  </div>
                  <button type="button" onClick={() => setDrawer(true)} className="rounded-md border border-input bg-card px-3 py-2 font-medium hover:bg-muted">Evidence details</button>
                </div>
                <TriageStep result={result} files={files} onMove={move} baseline={baseline} onBaseline={setBaseline} project={project} onProject={(p) => setProject(p)} separateCases={separate} onSeparate={setSeparate} />
              </>
            )}
          </div>
        ) : null}

        {sub === 'prereq' && result ? (
          <div className="mt-4">
            <h2 className="text-xl font-semibold text-foreground">Is everything in place for {result.pvrs[0]?.ref ?? 'this PVR'}?</h2>
            <p className="mt-1 max-w-2xl text-muted-foreground">{startReady.ok ? 'Your documents are ready to analyse. Nothing needs to be typed first; continuing creates the case, stores your files and opens the assessment.' : startReady.reason}</p>
            <div className="mt-4">
              <DrawingAnalysisPanel
              scopeId={scopeId}
              documents={panelDocs}
              narrative={narrative}
              onComplete={(out) => {
                // The panel's run is the analysis the user watched. Adopt it so the handoff matches what was shown.
                setAnalysis(out); analysisRef.current = out;
                lastExtractedRef.current = out.extracted; setLastExtracted(out.extracted);
                setStaleReason('');
              }}
            />
            </div>
            <div className="mt-4"><BackgroundJobPanel caseId={realCase?.id ?? null} /></div>
            <PrerequisitesStep
              result={result}
              files={files}
              baseline={baseline}
              description={narrative}
              onDescription={setNarrative}
              skipped={skipped}
              onSkip={(k) => setSkipped((s) => [...s, k])}
              analysis={{
                result: analysis,
                running: analysing,
                error: analysisError,
                onAnalyse: () => { void runAnalysis(); },
                canAnalyse: files.length > 0 || narrative.trim().length > 10,
                cannotReason: 'Add files or describe the change first.',
                answers: qAnswers,
                onAnswer: (id, opt) => answerQuestion(id, opt),
                manualOpen,
                onManualOpen: setManualOpen,
                manualQty,
                onManualQty: setManualQty,
                manualUnit,
                onManualUnit: setManualUnit,
                manualComponent,
                onManualComponent: setManualComponent,
                manualDate,
                onManualDate: setManualDate,
              }}
            />
          </div>
        ) : null}
      </div>

      <footer className="sticky bottom-0 z-10 -mx-4 border-t border-border bg-card px-4 py-3 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {sub !== 'pack' ? (
              <button type="button" onClick={() => setSub(sub === 'prereq' ? 'triage' : 'pack')} className="rounded-md border border-input bg-card px-4 py-2.5 font-semibold hover:bg-muted">Back</button>
            ) : null}
            <button type="button" onClick={() => saveDraft(false)} className="inline-flex items-center gap-2 rounded-md border border-input bg-card px-4 py-2.5 font-semibold hover:bg-muted"><Save size={16} aria-hidden />Save draft</button>
            <span className="hidden text-sm text-muted-foreground md:inline">{draftSavedAt ? `Saved in this browser at ${draftSavedAt}` : 'Not saved yet'}</span>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            {sub === 'pack' && action.hint ? <span className="max-w-md text-sm text-muted-foreground">{action.hint}</span> : null}
            {sub === 'triage' && !triageReady && result && !triaging ? <span className="text-sm text-muted-foreground">{!project ? 'Link or create a project to continue' : 'Choose the baseline schedule to continue'}</span> : null}
            {sub === 'prereq' && !startReady.ok ? <span role="status" className="max-w-md text-sm text-muted-foreground">{startReady.reason}</span> : null}
            {sub === 'prereq' && startReady.ok && startReady.warnings.length > 0 ? <span className="max-w-md text-sm text-muted-foreground">{startReady.warnings.join(' ')}</span> : null}
            {sub === 'prereq' && startNotes.length > 0 ? <span role="alert" className="max-w-md text-sm text-destructive">{startNotes.join(' ')}</span> : null}

            {sub === 'pack' ? (
              <button type="button" disabled={action.kind === 'disabled' || reading} onClick={onPrimaryPack} className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground">
                {action.label}<ArrowRight size={16} aria-hidden />
              </button>
            ) : null}
            {sub === 'triage' ? (
              <button type="button" disabled={!triageReady} onClick={() => setSub('prereq')} className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground">Continue to prerequisites<ArrowRight size={16} aria-hidden /></button>
            ) : null}
            {sub === 'prereq' ? (
              <button type="button" disabled={!startReady.ok || starting || analysing} onClick={() => void startAnalysis()} className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground">{starting ? 'Opening the case…' : 'Continue to assessment'}<ArrowRight size={16} aria-hidden /></button>
            ) : null}
          </div>
        </div>
      </footer>

      <EvidenceDrawer open={drawer} onClose={() => setDrawer(false)} files={files} />

      <Modal
        open={confirm !== null}
        title={confirm?.kind === 'clear' ? 'Clear files' : confirm?.kind === 'remove' ? 'Remove documents' : 'Start new PVR'}
        onClose={() => setConfirm(null)}
        footer={confirm?.kind === 'new' ? (
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={() => setConfirm(null)} className="rounded-md border border-input bg-card px-3 py-2 text-sm font-medium hover:bg-muted">Cancel</button>
            <button type="button" onClick={() => startNewPvr(false)} className="rounded-md border border-input bg-card px-3 py-2 text-sm font-medium text-destructive hover:bg-muted">Discard and start new</button>
            <button type="button" onClick={() => startNewPvr(true)} className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90">Save and start new</button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setConfirm(null)} className="rounded-md border border-input bg-card px-3 py-2 text-sm font-medium hover:bg-muted">Cancel</button>
            <button
              type="button"
              disabled={docBusy}
              onClick={() => {
                let c = confirm;
                setConfirm(null);
                if (c?.kind === 'clear') void clearAllDocs();
                else if (c?.kind === 'remove') void removeDocs(c.ids);
              }}
              className="rounded-md bg-destructive px-3 py-2 text-sm font-semibold text-destructive-foreground hover:opacity-90 disabled:opacity-50"
            >
              {confirm?.kind === 'clear' ? 'Remove all documents' : 'Remove'}
            </button>
          </div>
        )}
      >
        {confirm?.kind === 'clear' ? (
          <p className="text-foreground">Remove all documents from this PVR? Your narrative will be kept. Affected analysis results will require recalculation.</p>
        ) : confirm?.kind === 'remove' ? (
          <p className="text-foreground">Remove {confirm.ids.length === 1 ? 'this document' : `${confirm.ids.length} documents`} from this PVR? Affected analysis results will require recalculation. Stored originals are kept for earlier assessment versions.</p>
        ) : (
          <p className="text-foreground">Start a new PVR with no files, narrative, schedule or results? The current PVR is kept as a separate draft if you save it. You can resume it later from this screen.</p>
        )}
      </Modal>
    </div>
  );
}

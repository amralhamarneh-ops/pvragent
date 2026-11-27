'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Calculator, RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { calculateChange, formatSigned, planConversion, recordsFromImport, sameUnit, searchItems, validateDecimalText } from '@/lib/boq/calc';
import { loadCalculations, loadRealCase, persistCalculation, reviewCalculation, selectImportRevision, SESSION_LOSS_WARNING, type LoadedCase } from '@/lib/boq/caseClient';
import { newId, selectedImportOf } from '@/lib/boq/store';
import { remapTarget, staleness, toSavedCalculation, type SavedCalculation } from '@/lib/boq/revisions';
import type { BoqItemRecord, CalcResult, ChangeDirection } from '@/lib/boq/types';
import type { BasisKind, DerivationInput } from '@/lib/boq/units';
import SavedDrawingReplay from '@/app/case-workspace/components/SavedDrawingReplay';
import AgentBoqReview from '@/app/case-workspace/components/AgentBoqReview';
import { importSignatureOf, readEvidenceFile, runAgent, outcomeOf, type AgentEvent, type AgentRun } from '@/lib/boq/agentClient';
import { EMPTY_ANSWERS, type UserAnswers } from '@/lib/boq/matchEngine';
import type { EvidenceDoc } from '@/lib/boq/scope';
import { handoffAsEvidence, loadHandoff, normaliseHandoff, type ChangeHandoff } from '@/lib/drawings/handoff';
import { loadDrawingManifest, loadEvidence, saveEvidence } from '@/lib/docs/caseDocsClient';
import { buildBoqModel, EMPTY_INCLUSION, parseInclusion, type BoqInclusionState } from '@/lib/boq/documents';
import { overlappingItems } from '@/lib/boq/coverage';
import { makeMatchSnapshot, MATCH_SNAPSHOT_KEY, readMatchSnapshot, type MatchSnapshot } from '@/lib/boq/matchSnapshot';
import { writeRunRecord } from '@/lib/boq/runRecord';
import { resumableDrafts } from '@/lib/docs/scopedDraft';
import { EMPTY_STATE, DEFAULT_SCENARIO, EMPTY_DECISIONS, describeChange, readDecisions, readResolutionState, reconcileDecisions, staleEffects, writeDecisions, writeResolutionState, type DecisionStore, type LineResolution, type ResolutionState } from '@/lib/boq/resolutions';
import FinalPvrForm from '@/app/case-workspace/components/FinalPvrForm';
import ScopeReadinessPanel from '@/app/case-workspace/components/ScopeReadinessPanel';
import type { FormLine, ProgrammeWhatIf } from '@/lib/pvr/finalForm';
import { matchesCurrentDrawings } from '@/lib/boq/drawingQuantities';
import ActivityMappingPanel, { type ScheduleExclusion } from '@/app/case-workspace/components/ActivityMappingPanel';
import NewItemEntry from '@/app/case-workspace/components/NewItemEntry';
import { ExcludeModal, ManualRateModal } from '@/app/case-workspace/components/LineResolutionControls';
import { buildBoqSet } from '@/lib/boq/matchEngine';
import { readItems, writeItems, prefillFromComponent, type AssessmentItem, type ItemDraft } from '@/lib/boq/newItem';
import { loadCaseSchedules, type ScheduleLoadResult } from '@/lib/mapping/scheduleLoader';
import RealProgrammePanel, { referenceOnlyProgramme } from '@/app/case-workspace/components/RealProgrammePanel';
import { buildSharedLines, buildSharedLinesDetailed } from '@/lib/mapping/sharedLines';
import type { MappingChoices } from '@/lib/mapping/realActivityMapping';
import ValuationPanel from '@/app/case-workspace/components/ValuationPanel';
import { DeferModal } from '@/app/case-workspace/components/LineResolutionControls';
import { EMPTY_VALUATION, loadValuation, markValuationStale, saveValuation, type ValuationState } from '@/lib/boq/valuationClient';
import { STALE_LABEL, makeFingerprint, staleReasons, type AggregationGroup, type ReplacementMethod, type SourceFingerprint, type StaleReason, type TotalsLine } from '@/lib/boq/valuation';

interface RealCaseWorkspaceProps {
  caseId: string;
}

export default function RealCaseWorkspace({ caseId }: RealCaseWorkspaceProps) {
  const [loaded, setLoaded] = useState<LoadedCase | null>(null);
  const [loading, setLoading] = useState(true);
  const [description, setDescription] = useState('');
  const [direction, setDirection] = useState<ChangeDirection>('addition');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('');
  const [query, setQuery] = useState('');
  const [itemId, setItemId] = useState('');
  const [derivInputs, setDerivInputs] = useState<Record<string, { value: string; unit: string }>>({});
  const [basisKind, setBasisKind] = useState<BasisKind>('user_confirmed');
  const [basisText, setBasisText] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [pendingRevision, setPendingRevision] = useState('');
  const [calcs, setCalcs] = useState<SavedCalculation[]>([]);
  const [calcError, setCalcError] = useState('');
  const [savingCalc, setSavingCalc] = useState(false);
  /** Calculations the reviewer has re-mapped this session, awaiting a fresh calculation. */
  const [remapping, setRemapping] = useState<SavedCalculation | null>(null);

  // Agent-led review state
  const [narrative, setNarrative] = useState('');
  const [evidence, setEvidence] = useState<EvidenceDoc[]>([]);
  const [agentRun, setAgentRun] = useState<AgentRun | null>(null);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [agentError, setAgentError] = useState('');
  const [savedMatches, setSavedMatches] = useState<{ caseId: string; snapshot: MatchSnapshot; drawingsCurrent: boolean; persisted: boolean } | null>(null);
  const [matchSaveNote, setMatchSaveNote] = useState('');
  const [rawAnswers, setAnswers] = useState<UserAnswers>(EMPTY_ANSWERS);
  const [assessmentConfirmed, setAssessmentConfirmed] = useState(false);
  const [programmeWhatIf, setProgrammeWhatIf] = useState<ProgrammeWhatIf | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [handoff, setHandoff] = useState<ChangeHandoff | null>(null);
  const [verifiedReplay, setVerifiedReplay] = useState<{ caseId: string; handoff: ChangeHandoff } | null>(null);
  const [resState, setResState] = useState<ResolutionState>(EMPTY_STATE);
  const [partialAccepted, setPartialAccepted] = useState(false);
  /** Which BOQ documents are excluded and which revision is selected per document (persisted with the case evidence). */
  const [inclusion, setInclusion] = useState<BoqInclusionState>(EMPTY_INCLUSION);

  // ---- Stage 1 continuation state: new items, schedule, mapping choices, decisions by stable line id ----
  const [items2, setItems2] = useState<AssessmentItem[]>([]);
  const [itemModal, setItemModal] = useState<{ draft: ItemDraft | null; existing?: AssessmentItem } | null>(null);
  const [schedLoad, setSchedLoad] = useState<ScheduleLoadResult | null>(null);
  const [schedLoading, setSchedLoading] = useState(false);
  const [schedIdx, setSchedIdx] = useState(0);
  const [mapChoices, setMapChoices] = useState<MappingChoices>({});
  const [mappingProgrammeHash, setMappingProgrammeHash] = useState('');
  const [schedExcl, setSchedExcl] = useState<Record<string, ScheduleExclusion>>({});
  const [decisions, setDecisions] = useState<DecisionStore>(EMPTY_DECISIONS);
  const [invalidatedCount, setInvalidatedCount] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const [mapRetry, setMapRetry] = useState(0);
  const [panelManual, setPanelManual] = useState<string | null>(null);
  const [panelExclude, setPanelExclude] = useState<string | null>(null);
  const [panelDefer, setPanelDefer] = useState<string | null>(null);

  // ---- Server-side valuation state (groups, replacements, fingerprint, stale flag) ----
  const [valuation, setValuation] = useState<ValuationState>(EMPTY_VALUATION);
  const [valuationLoaded, setValuationLoaded] = useState(false);
  const [valuationNote, setValuationNote] = useState('');
  const [savedFingerprint, setSavedFingerprint] = useState<SourceFingerprint | null>(null);

  const MAP_KEY = `pvr-activity-mapping:${caseId}:${DEFAULT_SCENARIO}`;

  // Everything below is scoped to this case id and scenario. Switching case resets it, so another case never leaks in.
  useEffect(() => {
    setHydrated(false);
    setResState(readResolutionState(caseId));
    setPartialAccepted(false);
    setItems2(readItems(caseId));
    setDecisions(readDecisions(caseId));
    try {
      const raw = window.localStorage.getItem(MAP_KEY);
      const p = raw ? (JSON.parse(raw) as { choices?: MappingChoices; excl?: Record<string, ScheduleExclusion>; partial?: boolean; programmeHash?: string }) : {};
      setMappingProgrammeHash(p.programmeHash ?? ''); setMapChoices(p.choices ?? {}); setSchedExcl(p.excl ?? {}); setPartialAccepted(!!p.partial);
    } catch { setMappingProgrammeHash(''); setMapChoices({}); setSchedExcl({}); }
    setHydrated(true);
  }, [caseId, MAP_KEY]);

  // Persist mapping decisions (by stable line id) so a reload restores them.
  useEffect(() => {
    if (!hydrated) return;
    try { window.localStorage.setItem(MAP_KEY, JSON.stringify({ choices: mapChoices, excl: schedExcl, partial: partialAccepted, programmeHash: mappingProgrammeHash })); } catch { /* reported when a decision is made */ }
  }, [hydrated, MAP_KEY, mapChoices, schedExcl, partialAccepted, mappingProgrammeHash]);

  // `answers` is assembled further down, once the active BOQ set and the current run are known: persisted decisions are
  // keyed by stable line id and are re-attached to whichever component ids the current run produced.

  const onResolve = useCallback((componentId: string, next: LineResolution | undefined, lineId?: string, signature?: string) => {
    setResState((cur) => {
      const prev = cur.resolutions[componentId];
      const resolutions = { ...cur.resolutions };
      if (next) resolutions[componentId] = next; else delete resolutions[componentId];
      const fx = staleEffects(describeChange(prev, next));
      // A restore of a scenario exclusion is also scenario-wide, so describeChange(prev,next) covers both directions.
      const state: ResolutionState = { resolutions, costStale: cur.costStale || fx.cost, scheduleStale: cur.scheduleStale || fx.schedule, updatedAt: new Date().toISOString() };
      if (!writeResolutionState(caseId, state)) toast.error('This browser could not save the resolution. It will be lost on reload.');
      return state;
    });
    // Also record it by stable line id with the BOQ signature it was made against, so a source revision can invalidate it.
    if (lineId) {
      setDecisions((cur) => {
        const decs = { ...cur.decisions };
        if (next) decs[lineId] = { lineId, componentId, resolution: next, sourceSignature: signature ?? '' }; else delete decs[lineId];
        const store: DecisionStore = { decisions: decs, updatedAt: new Date().toISOString() };
        writeDecisions(caseId, store);
        return store;
      });
    }
    setAssessmentConfirmed(false);
  }, [caseId]);

  // Changes confirmed on the intake screen arrive as evidence. The case record on the server is the source of truth;
  // the tab's sessionStorage copy is only a fallback for a temporary case. The user's own narrative is kept as typed.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ev = await loadEvidence(caseId);
      if (cancelled) return;
      setInclusion(parseInclusion(ev.evidence?.answers));
      const snapshot = readMatchSnapshot(ev.evidence?.answers?.[MATCH_SNAPSHOT_KEY]);
      const fromServer = ev.evidence?.handoff ? normaliseHandoff(ev.evidence.handoff) : null;
      const h = fromServer ?? loadHandoff(caseId);
      if (snapshot || h?.drawingReplay) {
        const current = await loadDrawingManifest(caseId);
        if (cancelled) return;
        if (snapshot) setSavedMatches({ caseId, snapshot, drawingsCurrent: matchesCurrentDrawings(snapshot.drawings, current), persisted: ev.persisted });
        if (h?.drawingReplay && matchesCurrentDrawings(h.documents, current)) setVerifiedReplay({caseId, handoff:h});
      }
      const original = ev.evidence?.narrative ?? h?.originalNarrative ?? '';
      if (original.trim()) setNarrative((cur) => (cur.trim() ? cur : original));
      if (!h) return;
      setHandoff(h);
      const docs = handoffAsEvidence(h);
      if (docs.length) setEvidence((cur) => [...cur.filter((c) => !docs.some((d) => d.name === c.name)), ...docs]);
    })();
    return () => { cancelled = true; };
  }, [caseId]);

  const load = useCallback(async () => {
    setLoading(true);
    const l = await loadRealCase(caseId);
    setLoaded(l);
    if (l.case) {
      const cl = await loadCalculations(caseId);
      setCalcs(cl.calculations);
      setCalcError(cl.error);
    }
    setLoading(false);
  }, [caseId]);

  useEffect(() => { void load(); }, [load]);

  // A browser draft linked to this case id, found only to OFFER recovery. Read after mount, never applied automatically.
  const [localDraft, setLocalDraft] = useState<{ files: number } | null>(null);
  useEffect(() => {
    try {
      const hit = resumableDrafts('').find((x) => x.caseId === caseId && x.scopeId !== '__legacy__');
      setLocalDraft(hit ? { files: hit.files } : null);
    } catch { setLocalDraft(null); }
  }, [caseId]);

  const imports = useMemo(() => loaded?.imports ?? [], [loaded]);
  const selectedImport = useMemo(() => selectedImportOf(loaded?.case ?? null, imports), [loaded, imports]);
  // Declared before use below; the model itself is derived right after `inclusion` is known.
  const items: BoqItemRecord[] = useMemo(() => {
    const model = buildBoqModel(imports, inclusion, loaded?.case?.selectedImportId ?? null);
    // Manual search covers EVERY included document (one selected revision each), each row keeping its own import id.
    return model.assessmentImports.flatMap((imp) => recordsFromImport(imp));
  }, [imports, inclusion, loaded]);
  const candidates = useMemo(() => searchItems(items, query.trim() === '' ? description : query, unit || undefined), [items, query, description, unit]);
  const shown = (query.trim() === '' && description.trim() === '' ? items.map((item) => ({ item, score: 0, unitMatches: unit ? sameUnit(unit, item.unit) : null, matched: [] as string[] })) : candidates).slice(0, 25);
  const selectedItem = items.find((i) => i.id === itemId) ?? null;

  /**
   * The BOQ set for the agent: exactly one selected revision of every INCLUDED document. Different bills are all
   * searched together; only revisions of the same document compete, and identical re-uploads are never counted twice.
   * This replaces the earlier file-name heuristic, which silently depended on the case-level selection.
   */
  const boqModel = useMemo(() => buildBoqModel(imports, inclusion, loaded?.case?.selectedImportId ?? null), [imports, inclusion, loaded]);
  const activeSet = useMemo(() => boqModel.assessmentImports, [boqModel]);
  const activeSignature = useMemo(() => importSignatureOf(activeSet), [activeSet]);
  const agentStale = !!agentRun && agentRun.importSignature !== activeSignature;

  // Decisions made against a different BOQ source are not applied silently; they are counted and surfaced.
  const reconciled = useMemo(() => reconcileDecisions(decisions, activeSignature), [decisions, activeSignature]);
  useEffect(() => { setInvalidatedCount(reconciled.invalidated.length); }, [reconciled.invalidated.length]);

  // Run-time component id for each stable line id, so persisted decisions follow the line, not the model's component id.
  const lineToComponent = useMemo(() => {
    const m = new Map<string, string>();
    if (!agentRun) return m;
    const o = outcomeOf(agentRun, { ...rawAnswers, resolutions: {} });
    for (const s of buildSharedLines(agentRun.scope, o, items2, '')) m.set(s.lineId, s.componentId);
    return m;
  }, [agentRun, rawAnswers, items2]);

  const answers = useMemo<UserAnswers>(() => {
    const fromDecisions: Record<string, LineResolution> = {};
    for (const d of reconciled.active) {
      const comp = lineToComponent.get(d.lineId) ?? d.componentId;
      fromDecisions[comp] = d.resolution;
    }
    // Component-keyed state written by the cost review is kept for lines that have no stable id yet.
    return { ...rawAnswers, resolutions: { ...resState.resolutions, ...fromDecisions } };
  }, [rawAnswers, resState.resolutions, reconciled.active, lineToComponent]);

  const currentOutcome = useMemo(() => (agentRun ? outcomeOf(agentRun, answers) : null), [agentRun, answers]);
  // Free-entry items are kept as notes for review, not priced in the drawing-based PVR.
  const reviewItems = useMemo(() => items2.map(i => ({...i,quantity:null,rate:null})), [items2]);
  const sharedDetailed = useMemo(() => buildSharedLinesDetailed(agentRun?.scope ?? null, currentOutcome, reviewItems, loaded?.case?.currency ?? 'AED'), [agentRun, currentOutcome, reviewItems, loaded]);
  const sharedLines = sharedDetailed.lines;
  const lineById = useMemo(() => new Map(sharedLines.map((l) => [l.lineId, l])), [sharedLines]);
  const boqSet = useMemo(() => (activeSet.length ? buildBoqSet(activeSet) : null), [activeSet]);

  // Disposition of every line for the per-currency totals. Held, deferred, excluded and unpriced are never folded into a subtotal.
  const totalsLines = useMemo<TotalsLine[]>(() => sharedLines.map((l) => {
    const res = answers.resolutions?.[l.componentId];
    const dec = decisions.decisions[l.lineId]?.resolution;
    const r = dec ?? res;
    const excluded = r?.kind === 'excluded' ? r : null;
    const disposition: TotalsLine['disposition'] = excluded ? 'excluded' : r?.kind === 'deferred' ? 'deferred' : l.heldForOverlap ? 'held_overlap' : l.signedAmount !== null ? 'priced' : 'unpriced';
    return { lineId: l.lineId, currency: l.currency, signedAmount: l.signedAmount, disposition, excludedScope: excluded?.scope };
  }), [sharedLines, answers.resolutions, decisions.decisions]);

  // The inputs every saved result depends on. A change to any of them makes saved results stale.
  const currentFingerprint = useMemo<SourceFingerprint>(() => makeFingerprint({
    boqSignature: activeSignature,
    scopeKeys: (agentRun?.scope.components ?? []).map((c) => `${c.name}|${c.action}|${c.location}|${c.quantity?.value ?? ''}${c.quantity?.unit ?? ''}`).concat(handoff ? [`handoff:${handoff.analysisVersion ?? ''}:${(handoff.records ?? []).map((r) => `${r.id}:${r.netQty}`).join(',')}`] : []),
    mapping: mapChoices,
    documents: evidence.map((e) => `${e.name}:${e.text.length}`).concat([`narrative:${narrative.length}`]),
  }), [activeSignature, agentRun, handoff, mapChoices, evidence, narrative]);
  const staleNow = useMemo<StaleReason[]>(() => (agentRun ? staleReasons(savedFingerprint, currentFingerprint) : []), [savedFingerprint, currentFingerprint, agentRun]);

  // Load the case's saved valuation state from the server. The server copy wins over the browser copy for a real case.
  useEffect(() => {
    let cancelled = false;
    setValuationLoaded(false);
    void loadValuation(caseId).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setValuation(r.state);
        setSavedFingerprint(r.state.fingerprint);
        if (r.persisted && Object.keys(r.state.decisions).length) setDecisions({ decisions: r.state.decisions, updatedAt: new Date().toISOString(), fingerprint: r.state.fingerprint ?? undefined });
        if (r.persisted && r.state.items.length) { setItems2(r.state.items); writeItems(caseId, r.state.items); }
        setValuationNote(r.persisted ? '' : 'Temporary case: decisions are kept in this browser only.');
      } else setValuationNote(`Saved decisions could not be loaded from the server (${r.error}). Browser copies are being used.`);
      setValuationLoaded(true);
    });
    return () => { cancelled = true; };
  }, [caseId]);

  // Save decisions, items, groups and replacements with the case. Version-checked so a stale tab cannot overwrite newer work.
  useEffect(() => {
    if (!hydrated || !valuationLoaded) return;
    const t = window.setTimeout(() => {
      void saveValuation(caseId, {
        decisions: decisions.decisions, items: items2, groups: valuation.groups, replacements: valuation.replacements,
        fingerprint: savedFingerprint ?? currentFingerprint, stale: staleNow.length > 0, staleReasons: staleNow, version: valuation.version,
      }).then((r) => {
        if (r.ok) { setValuation((v) => ({ ...v, version: r.version })); setValuationNote((n) => (n.startsWith('Could not save') ? '' : n)); }
        else if (r.conflict) setValuationNote(r.error);
        else if (!caseId.startsWith('session-')) setValuationNote(`Could not save decisions on the server: ${r.error}. They are kept in this browser.`);
      });
    }, 800);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId, hydrated, valuationLoaded, decisions.decisions, items2, valuation.groups, valuation.replacements]);

  // When a source input changes after decisions were made, tell the server so other tabs and reloads see it as stale.
  useEffect(() => {
    if (staleNow.length > 0) void markValuationStale(caseId, staleNow);
  }, [caseId, staleNow]);

  const acceptCurrentSources = useCallback(() => {
    setSavedFingerprint(currentFingerprint);
    setValuation((v) => ({ ...v, stale: false, staleReasons: [] }));
    setAssessmentConfirmed(false);
  }, [currentFingerprint]);



  // Connect the uploaded programme: restore the case registry and parse the real XER bytes.
  useEffect(() => {
    let cancelled = false;
    setSchedLoading(true);
    void loadCaseSchedules(caseId).then((r) => { if (!cancelled) { setSchedLoad(r); setSchedIdx(0); setSchedLoading(false); } }).catch(() => { if (!cancelled) setSchedLoading(false); });
    return () => { cancelled = true; };
  }, [caseId, mapRetry]);
  const inputSchedules = useMemo(() => schedLoad?.schedules.filter(s => !referenceOnlyProgramme(s)) ?? [], [schedLoad]);
  const referenceSchedules = useMemo(() => schedLoad?.schedules.filter(referenceOnlyProgramme) ?? [], [schedLoad]);
  const activeSchedule = inputSchedules[schedIdx] ?? null;
  const confirmedProgrammeTasks = useMemo(() => mappingProgrammeHash === activeSchedule?.sha256
    ? sharedLines.filter(l => l.work.executes && !schedExcl[l.lineId] && !mapChoices[l.lineId]?.state).flatMap(l => mapChoices[l.lineId]?.activityTaskIds ?? []) : [],
    [mappingProgrammeHash,activeSchedule,sharedLines,schedExcl,mapChoices]);

  // A changed programme invalidates choices that pointed at its activities.
  useEffect(() => {
    if (!hydrated || !schedLoad || !activeSchedule) return;
    if (mappingProgrammeHash !== activeSchedule.sha256) {
      setMapChoices(cur => Object.fromEntries(Object.entries(cur).flatMap(([key,value]) => {
        if (!value.activityTaskIds?.length) return [[key,value]];
        const {activityTaskIds: _ids, shares: _shares, ...rest} = value;
        return Object.keys(rest).length ? [[key,rest]] : [];
      })));
      setMappingProgrammeHash(activeSchedule.sha256);
      setAssessmentConfirmed(false);
      return;
    }
    const known = new Set(activeSchedule.model.activities.map((a) => a.taskId ?? a.id));
    setMapChoices((cur) => {
      let changed = false; const next: MappingChoices = {};
      for (const [k, v] of Object.entries(cur)) {
        if (v.activityTaskIds && v.activityTaskIds.some((t) => !known.has(t))) { changed = true; continue; }
        next[k] = v;
      }
      return changed ? next : cur;
    });
  }, [hydrated, schedLoad, activeSchedule, mappingProgrammeHash]);

  /** Resolve a line (by stable id) through the same resolution model for both the cost review and the activity panel. */
  const resolveLine = useCallback((lineId: string, next: LineResolution | undefined) => {
    const l = lineById.get(lineId);
    if (!l) return;
    onResolve(l.componentId, next, lineId, activeSignature);
  }, [lineById, onResolve, activeSignature]);

  const saveItem = (item: AssessmentItem) => {
    setItems2((cur) => {
      const next = cur.some((x) => x.id === item.id) ? cur.map((x) => (x.id === item.id ? item : x)) : [...cur, item];
      if (!writeItems(caseId, next)) toast.error('This browser could not save the assessment item. It will be lost on reload.');
      return next;
    });
    setAssessmentConfirmed(false);
    setResState((cur) => { const s = { ...cur, costStale: true, updatedAt: new Date().toISOString() }; writeResolutionState(caseId, s); return s; });
    setItemModal(null);
    toast.success('Assessment item saved for this case. The source BOQ is unchanged.');
  };
  const removeItem = (id: string) => {
    setItems2((cur) => { const next = cur.filter((x) => x.id !== id); writeItems(caseId, next); return next; });
    setAssessmentConfirmed(false);
  };
  const addBoqItemToScope = (item: BoqItemRecord, componentId: string) => {
    setAnswers((a) => ({ ...a, chosenRow: { ...a.chosenRow, [componentId]: item.id } }));
    setItemModal(null);
    setAssessmentConfirmed(false);
    toast.success(`${item.ref} from ${item.sourceFile} attached to the scope.`);
  };
  const openCreateItem = (lineId: string) => {
    const l = lineById.get(lineId);
    const comp = agentRun?.scope.components.find((c) => c.id === l?.componentId);
    setItemModal({ draft: comp ? prefillFromComponent(comp, loaded?.case?.currency ?? 'AED') : null });
  };

  const onAddEvidence = async (list: FileList) => {
    const docs = await Promise.all(Array.from(list).map((f) => readEvidenceFile(f)));
    setEvidence((cur) => [...cur.filter((c) => !docs.some((d) => d.name === c.name)), ...docs]);
    setAgentError('');
  };

  const analyse = async () => {
    setAgentRunning(true);
    setAgentError('');
    setMatchSaveNote('');
    setAgentEvents([]);
    setAssessmentConfirmed(false);
    try {
      const activeDrawingDocuments = await loadDrawingManifest(caseId);
      const run = await runAgent({ imports: activeSet, narrative, evidence, drawingQuantityHandoff: handoff, activeDrawingDocuments, onEvent: (e) => setAgentEvents((l) => [...l, e]) });
      setProgrammeWhatIf(null);
      setAgentRun(run);
      writeRunRecord(caseId, {
        runAt: new Date().toISOString(),
        importSignature: run.importSignature,
        boqFiles: activeSet.map((i) => i.source.fileName),
        evidenceRead: evidence.filter((e) => e.extracted).map((e) => e.name),
        evidenceUnread: Object.fromEntries(evidence.filter((e) => !e.extracted).map((e) => [e.name, e.note || 'Its content was not extracted.'])),
      });
      setAnswers(EMPTY_ANSWERS);
      const snapshot = makeMatchSnapshot(outcomeOf(run, EMPTY_ANSWERS), run.importSignature, activeDrawingDocuments, new Date().toISOString());
      const serialized = JSON.stringify(snapshot);
      if (snapshot.rows.length && readMatchSnapshot(serialized)) {
        const save = await saveEvidence(caseId, { matchSnapshot: serialized });
        if (save.saved) setSavedMatches({ caseId, snapshot, drawingsCurrent: !!handoff && matchesCurrentDrawings(handoff.documents, activeDrawingDocuments), persisted: save.persisted });
        setMatchSaveNote(save.saved ? (save.persisted ? 'BOQ match preview saved to this case.' : 'BOQ match preview saved in this tab only.') : `BOQ match preview was not saved: ${save.error}`);
      } else setMatchSaveNote(snapshot.rows.length ? 'The BOQ match preview could not be verified for saving.' : 'This run found no primary BOQ matches with verified drawing quantities to save. An earlier saved preview, if any, is unchanged.');
      // The first completed analysis fixes the baseline the decisions are made against. Later changes mark results stale.
      setSavedFingerprint((cur) => cur ?? makeFingerprint({ boqSignature: activeSignature, scopeKeys: run.scope.components.map((c) => `${c.name}|${c.action}|${c.location}|${c.quantity?.value ?? ''}${c.quantity?.unit ?? ''}`).concat(handoff ? [`handoff:${handoff.analysisVersion ?? ''}:${(handoff.records ?? []).map((r) => `${r.id}:${r.netQty}`).join(',')}`] : []), mapping: mapChoices, documents: evidence.map((e) => `${e.name}:${e.text.length}`).concat([`narrative:${narrative.length}`]) }));
    } catch (e) {
      setAgentError(e instanceof Error ? e.message : 'The analysis failed.');
    } finally {
      setAgentRunning(false);
    }
  };

  const drawingsAreCurrent = async () => !!handoff && matchesCurrentDrawings(handoff.documents, await loadDrawingManifest(caseId));
  const confirmAssessment = async () => {
    if (!agentRun || !selectedImport || !loaded?.case) return;
    if (agentStale || !(await drawingsAreCurrent())) {
      setAssessmentConfirmed(false);
      toast.error('The BOQ or drawing revisions changed or cannot be verified. Rerun the current drawing-based assessment.');
      return;
    }
    const outcome = outcomeOf(agentRun, answers);
    const heldIds = new Set(sharedLines.filter((s) => s.heldForOverlap).map((s) => s.componentId));
    const lines = outcome.lines.filter((l) => l.quantityOrigin === 'Measured from geometry' && l.valued && !l.excluded && !l.deferred && !heldIds.has(l.componentId) && (l.manual || (l.calc && l.calc.ok)));
    if (lines.length === 0) { toast.error('There are no priced drawing-based lines to confirm.'); return; }
    setSavingCalc(true);
    let saved = 0; let failed = '';
    let list = calcs;
    for (const l of lines) {
      const owner = activeSet.find((i) => i.id === l.item.importId) ?? selectedImport;
      let record: SavedCalculation;
      if (l.manual) {
        // Manual proposed rate: stored as a case-specific record. The source BOQ is untouched and nothing here implies approval.
        const m = l.manual;
        const q = m.quantityText.split(' ');
        record = {
          id: newId('calc'), caseId: loaded.case.id, createdAt: new Date().toISOString(),
          description: m.rate.processedPvr ? `${l.componentName} · Processed PVR · Pilot only (${m.rate.processedPvr.file}, page ${m.rate.processedPvr.page}, ${m.rate.processedPvr.row}; ${m.rate.reason}; entered by ${m.rate.enteredBy})` : `${l.componentName} · Manual rate · Proposed (${m.rate.reason}; entered by ${m.rate.enteredBy})`,
          direction: m.amountSigned.startsWith('-') ? 'omission' : 'addition',
          importId: owner.id, importRevision: owner.revision, importFileName: owner.source.fileName, importSha256: owner.source.sha256,
          itemId: l.item.id, itemRef: m.rate.processedPvr ? 'PVR-PILOT' : 'MANUAL', itemDescription: l.componentName, sheet: m.rate.processedPvr ? 'Processed PVR pilot' : 'Manual rate', rowNumber: 0, rateCell: '',
          rate: m.rate.value, currency: m.rate.currency, boqUnit: m.rate.unit, quantity: q[0] ?? '', quantityUnit: q.slice(1).join(' '), convertedQuantity: q[0] ?? '',
          signedAmount: m.amountSigned, formula: m.formula,
          conversion: { type: 'identity', originalQuantity: q[0] ?? '', originalUnit: q.slice(1).join(' '), derivedQuantity: q[0] ?? '', derivedUnit: m.rate.unit, derivation: 'Manual rate in the quantity unit', supportingInputs: [], basis: null },
          reviewedAgainstImportId: null,
        };
      } else {
        const res = l.calc as Extract<CalcResult, { ok: true }>;
        record = toSavedCalculation({ id: newId('calc'), caseId: loaded.case.id, description: `${l.componentName}`, imp: owner, result: res, item: { id: l.item.id, ref: l.item.ref, description: l.item.description, sheet: l.item.sheet, rowNumber: l.item.rowNumber } });
      }
      const out = await persistCalculation(record, list);
      if (!out.saved) { failed = out.error; break; }
      list = [...list, record]; saved += 1;
    }
    setSavingCalc(false);
    setCalcs(list);
    if (failed) { toast.error(`Confirmed ${saved} of ${lines.length} line(s). Stopped: ${failed}`); return; }
    setAssessmentConfirmed(true);
    // Confirming accepts the current sources as the baseline the saved results were made against.
    setSavedFingerprint(currentFingerprint);
    setValuation((v) => ({ ...v, stale: false, staleReasons: [] }));
    // Cost is now saved. Schedule staleness is only cleared by a schedule recalculation, never by this step.
    setResState((cur) => { const next = { ...cur, costStale: false, updatedAt: new Date().toISOString() }; writeResolutionState(caseId, next); return next; });
    const s = outcome.summary;
    toast.success(`${s.fullyPriced ? 'Assessment confirmed' : 'Partial assessment confirmed'}: ${saved} line(s) saved. ${s.unpricedIncluded} unpriced, ${s.excludedCount} excluded${s.manualProposedCount ? `, ${s.manualProposedCount} manual rate(s) still proposed` : ''}.`);
  };

  const plan = useMemo(() => (selectedItem && unit.trim() !== '' ? planConversion(unit, selectedItem.unit) : null), [selectedItem, unit]);
  const unitsDiffer = !!plan && plan.kind !== 'identity';
  const derivationInputs: DerivationInput[] = useMemo(
    () => (plan && plan.kind === 'needs_derivation' ? plan.required.filter((n) => derivInputs[n]?.value?.trim()).map((n) => ({ name: n, value: derivInputs[n].value, unit: derivInputs[n].unit || 'm' })) : []),
    [plan, derivInputs],
  );
  const result: CalcResult | null = useMemo(() => {
    if (!selectedItem) return null;
    return calculateChange({ direction, quantity, quantityUnit: unit, item: selectedItem, derivationInputs, basis: basisText.trim() ? { kind: basisKind, statement: basisText } : null });
  }, [selectedItem, direction, quantity, unit, derivationInputs, basisKind, basisText]);

  // A selection from another revision must not survive a revision change.
  useEffect(() => { if (itemId && !items.some((i) => i.id === itemId)) setItemId(''); }, [items, itemId]);
  // Derivation inputs belong to one item/unit pair; clear them when either changes.
  useEffect(() => { setDerivInputs({}); setBasisText(''); }, [itemId, unit]);

  const switchRevision = async () => {
    if (!loaded?.case || !pendingRevision) return;
    const res = await selectImportRevision(loaded.case, pendingRevision, imports);
    if (res.error || !res.case) { toast.error(res.error || 'Could not select that revision.'); return; }
    // Record the choice for THIS document only; other documents keep their own selected revision.
    const target = imports.find((i) => i.id === pendingRevision);
    if (target) {
      const nextInc: BoqInclusionState = { ...inclusion, selected: { ...inclusion.selected, [target.source.fileName.trim().toLowerCase().replace(/\s+/g, ' ')]: target.id } };
      const prev = await loadEvidence(caseId);
      let saved = await saveEvidence(caseId, { answers: { ...(prev.evidence?.answers ?? {}), __boqInclusion: JSON.stringify(nextInc) } });
      if (saved.saved) setInclusion(nextInc); else toast.error(`The revision was selected, but the per-document choice was not saved: ${saved.error}`);
    }
    setLoaded({ ...loaded, case: res.case });
    setPendingRevision('');
    setItemId('');
    setRemapping(null);
    toast.success('Revision selected. Earlier calculations are kept and now need review.');
  };

  const stale = useMemo(() => calcs.map((c) => ({ calc: c, info: staleness(c, selectedImport, imports) })), [calcs, selectedImport, imports]);
  /** Same work priced in more than one included document: shown for a human decision, never valued twice silently. */
  const crossBoqOverlaps = useMemo(() => overlappingItems(items), [items]);
  const needReview = stale.filter((s) => s.info.status === 'needs_review');
  const currentCalcs = stale.filter((s) => s.info.status === 'current');

  const saveThisCalculation = async () => {
    if (!selectedImport || !selectedItem || !result || !result.ok || !loaded?.case) return;
    setSavingCalc(true);
    let record = toSavedCalculation({ id: newId('calc'), caseId: loaded.case.id, description, imp: selectedImport, result, item: { id: selectedItem.id, ref: selectedItem.ref, description: selectedItem.description, sheet: selectedItem.sheet, rowNumber: selectedItem.rowNumber } });
    const out = await persistCalculation(record, calcs);
    setSavingCalc(false);
    if (!out.saved) { toast.error(`Calculation not saved. ${out.error}`); return; }
    setCalcs((l) => [...l, record]);
    setRemapping(null);
    toast.success(out.mode === 'server' ? 'Calculation saved on the server with its revision, row and rate.' : 'Calculation held temporarily in this tab only.');
  };

  /** Reviewer confirms the remapped row for the selected revision. This unlocks a NEW calculation; it never rewrites the old one. */
  const confirmRemap = async (c: SavedCalculation) => {
    if (!selectedImport || !loaded?.case) return;
    const target = remapTarget(c, selectedImport);
    if (!target.recordId) { toast.error('No single matching row exists in the selected revision. Search and select the item manually, then calculate again.'); setRemapping(null); return; }
    setRemapping(c);
    setItemId(target.recordId);
    setDescription(c.description);
    setQuantity(c.quantity);
    setUnit(c.quantityUnit);
    setDirection(c.direction);
    toast.message('The remapped item is selected below. Review its rate and unit, then save a new calculation.');
  };

  const markReviewed = async (c: SavedCalculation) => {
    if (!selectedImport || !loaded?.case) return;
    const err = await reviewCalculation(loaded.case.id, c.id, selectedImport.id, calcs);
    if (err) { toast.error(`Could not record the review: ${err}`); return; }
    setCalcs((l) => l.map((x) => (x.id === c.id ? { ...x, reviewedAgainstImportId: selectedImport.id } : x)));
    toast.success('Marked as reviewed against the selected revision.');
  };

  if (loading) return <div className="skeleton h-96 rounded-lg" role="status" aria-label="Loading case" />;

  if (!loaded || !loaded.case) {
    const notFound = loaded?.failure === 'not_found' || loaded?.failure === 'forbidden';
    const d = loaded?.diagnostic ?? null;
    const permission = d?.code === 'permission_denied' || loaded?.failure === 'not_signed_in';
    const title = notFound ? 'Case not found' : permission ? 'Access to this case was refused' : 'This case could not be loaded';
    return (
      <div role="alert" className="mx-auto max-w-2xl rounded-lg border border-destructive/30 bg-destructive/10 p-6">
        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
        <p className="mt-2 text-foreground">{loaded?.error || 'Unknown error.'}</p>
        {d?.nextAction ? <p className="mt-2 text-foreground"><span className="font-semibold">Next step: </span>{d.nextAction}</p> : null}
        {notFound ? <p className="mt-2 text-muted-foreground">No case with this ID exists for this account. Nothing was created in its place.</p> : null}
        {d ? (
          <details className="mt-3 text-sm text-muted-foreground">
            <summary className="cursor-pointer font-medium">Diagnostic</summary>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-data">
              <dt>Code</dt><dd>{d.code}{d.dbCode ? ` / ${d.dbCode}` : ''}</dd>
              <dt>Operation</dt><dd>{d.operation}</dd>
              <dt>Resource</dt><dd>{d.resource}</dd>
              <dt>HTTP status</dt><dd>{d.httpStatus ?? 'none'}</dd>
              {d.message ? (<><dt>Message</dt><dd>{d.message}</dd></>) : null}
              {d.details ? (<><dt>Details</dt><dd>{d.details}</dd></>) : null}
              {d.hint ? (<><dt>Hint</dt><dd>{d.hint}</dd></>) : null}
            </dl>
          </details>
        ) : loaded?.persistence.blocker ? <p className="mt-2 text-muted-foreground">Blocker: {loaded.persistence.blocker}</p> : null}
        <p className="mt-2 text-muted-foreground">No sample data is shown in place of a real case. Your uploaded documents, BOQ imports and browser drafts have not been changed.</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-2 rounded-md border border-input bg-card px-4 py-2 font-semibold hover:bg-muted disabled:opacity-60"><RefreshCw size={15} aria-hidden />Retry</button>
          <Link href="/new-pvr" className="rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground hover:opacity-90">{notFound && localDraft ? 'Open local draft in New PVR' : 'Back to New PVR'}</Link>
        </div>
        {notFound && localDraft ? <p className="mt-3 text-sm text-muted-foreground">A browser draft linked to this case ID exists on this device ({localDraft.files} file{localDraft.files === 1 ? '' : 's'}). Use Resume previous draft in New PVR to recover it. It is not applied automatically, and no server case is overwritten.</p> : null}
      </div>
    );
  }

  const c = loaded.case;
  const formLines: FormLine[] = sharedLines.flatMap(l => {
    const t = totalsLines.find(row => row.lineId===l.lineId);
    if (!t) return [];
    const component=agentRun?.scope.components.find(c=>c.id===l.componentId);
    const q=l.origin!=='new_item' && component?.quantity?.origin==='measured_from_geometry' ? component.quantity : null;
    const price=currentOutcome?.lines.find(p=>p.componentId===l.componentId && p.role==='primary');
    const calc=price?.calc?.ok ? price.calc : null;
    const manual=price?.manual?.rate;
    const fallback=!!manual?.processedPvr;
    const sources=calc?.sources.map(s=>[s.file,[s.sheet,s.rateCell].filter(Boolean).join('!')].filter(Boolean).join(' · ')).join('; ');
    const trusted=!!q && !!(calc||fallback);
    return [{
      ...t, disposition:t.disposition==='priced'&&!trusted?'unpriced':t.disposition,
      signedAmount:trusted?t.signedAmount:null, description:l.name, quantity:q?.value??null, quantityUnit:q?.unit??l.work.unit, quantityAction:component?.action,
      drawingSource:q ? [q.source,q.quote].filter(Boolean).join(' · ') : '',
      rate:fallback ? manual!.value : calc?.rate??null, rateUnit:fallback ? manual!.unit : calc?.boqUnit??'',
      rateSource:fallback ? 'Processed PVR rate (BOQ unavailable): '+l.source : sources ? 'Contract BOQ: '+sources : 'No verified BOQ or cited fallback rate',
      rateFallback:fallback,
      mappedActivity:mappingProgrammeHash === activeSchedule?.sha256 && !mapChoices[l.lineId]?.state
        ? (mapChoices[l.lineId]?.activityTaskIds??[]).map(id=>activeSchedule?.model.activities.find(a=>(a.taskId??a.id)===id)?.id).filter(Boolean).join(', ') : undefined,
    } satisfies FormLine];
  });
  const whatIf=programmeWhatIf && activeSchedule?.fileName===programmeWhatIf.input ? programmeWhatIf : null;
  const formReady=!!agentRun && assessmentConfirmed && !agentStale && !staleNow.length && !resState.costStale && !agentRunning;
  const formBlockers=[
    ...(!agentRun?['Run the drawing-based analysis.']:!formReady?['Review and confirm the current valuation before treating this as a final PVR.']:[]),
    ...(formLines.some(l=>l.disposition==='unpriced'||l.disposition==='deferred'||l.disposition==='held_overlap')?['Some lines are unpriced, deferred, or held for review. The priced subtotal is not the full PVR value.']:[]),
    'No verified full-scope programme result is available. What-if scenarios do not contribute to PVR time impact.',
  ];

  const confirmed = imports.filter((i) => i.confirmedAt);

  return (
    <div className="space-y-5">
      <header className="rounded-lg border border-border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm text-muted-foreground">Real case · not sample data</p>
            <h1 className="text-headline font-bold text-foreground">{c.title}</h1>
            <p className="mt-1 font-data text-sm text-muted-foreground">Case ID {c.id}</p>
          </div>
          <span className={`rounded-md px-3 py-1.5 text-sm font-medium ${loaded.persistence.mode === 'server' ? 'bg-secondary text-secondary-foreground' : 'border border-warning/40 bg-warning/10 text-foreground'}`}>
            {loaded.persistence.mode === 'server' ? 'Saved on server' : 'Temporary, not saved on the server'}
          </span>
        </div>
        {loaded.persistence.mode === 'session_only' ? <p className="mt-2 text-sm text-foreground">{SESSION_LOSS_WARNING}</p> : null}
      </header>

      {!selectedImport ? (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-5">
          <p className="font-semibold text-foreground">No confirmed BOQ for this case.</p>
          <p className="mt-1 text-muted-foreground">Import and confirm a BOQ on the Documents screen first. Rates are never taken from anywhere else.</p>
          <Link href="/new-pvr" className="mt-3 inline-block rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground hover:opacity-90">Go to Documents</Link>
        </div>
      ) : (
        <>
          <section className="rounded-lg border border-border bg-card p-5 shadow-sm" aria-labelledby="src-title">
            <h2 id="src-title" className="text-lg font-semibold text-foreground">BOQ set in use</h2>
            <p role="status" className="mt-1 font-medium text-foreground tabular">{boqModel.summary} {items.length.toLocaleString('en-US')} item(s) searched, {items.filter((i) => i.rate.state !== 'value').length} without a rate.</p>
            <ul className="mt-2 divide-y divide-border rounded-md border border-border text-sm" aria-label="Included BOQ documents">
              {boqModel.documents.map((d) => {
                const sel = d.revisions.find((r) => r.importId === d.selectedImportId);
                return (
                  <li key={d.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span className="text-foreground">{d.fileName}<span className="block font-data text-xs text-muted-foreground">{sel ? `Revision ${sel.revision} · SHA-256 ${sel.sha256.slice(0, 16)}… · ${sel.items.toLocaleString('en-US')} item(s)` : 'No complete revision'}</span></span>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${d.included ? 'bg-secondary text-secondary-foreground' : 'bg-warning/20 text-foreground'}`}>{d.included ? 'Included in assessment' : 'Excluded from assessment'}</span>
                      {d.included ? <span className="rounded bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">Selected revision</span> : null}
                      {d.revisions.some((r) => r.label === 'superseded') ? <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{d.revisions.filter((r) => r.label === 'superseded').length} superseded</span> : null}
                      {d.revisions.some((r) => r.label === 'duplicate') ? <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{d.revisions.filter((r) => r.label === 'duplicate').length} duplicate upload(s)</span> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
            {crossBoqOverlaps.length > 0 ? (
              <div role="status" className="mt-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">
                <p className="font-medium">{crossBoqOverlaps.length} description(s) appear in more than one included BOQ document.</p>
                <p className="text-muted-foreground">These may be alternative commercial BOQs for the same work. Each stays distinguishable by file, sheet and row; the matching step values one row per change and asks you when several fit. Exclude a document on the Documents screen if it is an alternative you do not want considered.</p>
                <ul className="mt-1 list-disc pl-5 text-muted-foreground">{crossBoqOverlaps.slice(0, 5).map((o) => <li key={o.signature}>{o.members.map((m) => `${m.sourceFile} ${m.sheet}!${m.rowNumber}`).join(' · ')}</li>)}</ul>
              </div>
            ) : null}
            {selectedImport ? <p className="mt-2 font-data text-xs text-muted-foreground">Case-level reference revision for single-item calculations: revision {selectedImport.revision} · {selectedImport.source.fileName} · SHA-256 {selectedImport.source.sha256}</p> : null}
            {confirmed.length > 1 ? (
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <div>
                  <label htmlFor="rev-select" className="text-sm text-muted-foreground">Use a different revision of {selectedImport?.source.fileName}</label>
                  <select id="rev-select" value={pendingRevision} onChange={(e) => setPendingRevision(e.target.value)} className="mt-0.5 block rounded-md border border-input bg-card px-2 py-1.5 text-foreground">
                    <option value="">Choose…</option>
                    {confirmed.filter((i) => i.id !== selectedImport?.id && selectedImport && i.source.fileName.trim().toLowerCase() === selectedImport.source.fileName.trim().toLowerCase() && i.source.sha256 !== selectedImport.source.sha256).map((i) => <option key={i.id} value={i.id}>Revision {i.revision} · {i.source.fileName}</option>)}
                  </select>
                </div>
                <button type="button" disabled={!pendingRevision} onClick={() => void switchRevision()} className="rounded-md border border-input bg-card px-3.5 py-1.5 font-medium hover:bg-muted disabled:opacity-50">Select revision</button>
              </div>
            ) : null}
          </section>

          {handoff ? (
            <section aria-label="Changes from the intake analysis" className="rounded-lg border border-border bg-card p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-foreground">Structured change records from the drawing analysis <span className="text-sm font-normal text-muted-foreground">({(handoff.records ?? []).length || handoff.changes.length}{handoff.analysisVersion ? ` · analysis v${handoff.analysisVersion}` : ''})</span></h2>
              <p className="mt-1 text-sm text-muted-foreground">These records go to BOQ mapping as data: quantities, units, formula and entity references are copied, not re-read from text. Additions and omissions stay separate so each can be valued on its own. Records needing review are flagged and not silently priced.</p>
              <ul className="mt-2 divide-y divide-border text-sm">
                {(handoff.records ?? []).map((r) => (
                  <li key={r.id} className="py-2">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-foreground">{r.component} <span className="text-muted-foreground">· {r.change}</span></span>
                      <span className="flex items-center gap-2"><span className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-foreground">{r.basis === 'measured' ? 'Measured' : r.basis === 'derived' ? 'Derived' : r.basis === 'document_stated' ? 'Document-stated' : r.basis === 'narrative_stated' ? 'Narrative-stated' : 'User-entered'}</span>{r.needsReview ? <span className="rounded bg-warning/20 px-2 py-0.5 text-xs font-medium text-foreground">Needs review</span> : null}</span>
                    </div>
                    <p className="font-data text-xs text-muted-foreground">original {r.originalQty || '—'} · revised {r.revisedQty || '—'} · added {r.addedQty} · omitted {r.omittedQty} · net {r.netQty} {r.unit === 'm2' ? 'm²' : r.unit === 'm3' ? 'm³' : r.unit}</p>
                    {r.formula ? <p className="text-xs text-muted-foreground">Formula: {r.formula}{r.drawingRevision ? ` · revision ${r.drawingRevision}` : ''}{r.entityRefs ? ` · ${r.entityRefs.original.length} original / ${r.entityRefs.revised.length} revised entities` : ''}</p> : null}
                    {r.reviewReasons.length ? <p className="text-xs text-foreground">{r.reviewReasons.join(' ')}</p> : null}
                  </li>
                ))}
                {!(handoff.records ?? []).length ? handoff.changes.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
                    <span className="text-foreground">{c.component} <span className="text-muted-foreground">· {c.changeQty} {c.unit === 'm2' ? 'm²' : c.unit === 'm3' ? 'm³' : c.unit}</span></span>
                    <span className="flex items-center gap-2"><span className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-foreground">{c.basis === 'measured' ? 'Measured' : c.basis === 'derived' ? 'Derived' : c.basis === 'document_stated' ? 'Document-stated' : c.basis === 'narrative_stated' ? 'Narrative-stated' : 'User-entered'}</span>{c.conflict ? <span className="rounded bg-warning/20 px-2 py-0.5 text-xs font-medium text-foreground">Held: sources conflict</span> : null}</span>
                  </li>
                )) : null}
              </ul>
              <p className="mt-2 text-sm text-foreground">
                {handoff.proposedEventDate ? `Event/instruction date proposed from evidence: ${handoff.proposedEventDate.iso} (${handoff.proposedEventDate.source}).` : 'Event date unresolved. It does not affect BOQ matching and is only needed when the schedule is assessed.'}
                {handoff.userEnteredDate ? ` You entered ${handoff.userEnteredDate} (user-entered, kept separate).` : ''}
              </p>
              {handoff.openQuestions.length > 0 ? <p className="mt-1 text-sm text-muted-foreground">{handoff.openQuestions.length} question(s) from the analysis were left unanswered: {handoff.openQuestions.map((q) => q.title).join('; ')}.</p> : null}
              {handoff.limitations.length > 0 ? <p className="mt-1 text-sm text-muted-foreground">Not processed: {handoff.limitations.join(' | ')}</p> : null}
            </section>
          ) : null}

          {verifiedReplay?.caseId === caseId && handoff === verifiedReplay.handoff && handoff.drawingReplay ? (
            <SavedDrawingReplay replay={handoff.drawingReplay} changes={handoff.changes} />
          ) : handoff?.drawingReplay ? (
            <p className="text-sm text-muted-foreground">Saved drawing replay is unavailable because the active drawings could not be verified.</p>
          ) : null}
          {savedMatches?.caseId === caseId && !agentRun ? (
            <section aria-label="Saved BOQ match preview" className="rounded-lg border border-border bg-card p-4">
              <h3 className="font-semibold">Saved BOQ match preview</h3>
              <p className="text-sm text-muted-foreground">Run from {new Date(savedMatches.snapshot.runAt).toLocaleString()}. Review only; not a confirmed valuation.{!savedMatches.persisted ? ' Saved in this tab only.' : ''}</p>
              {!savedMatches.drawingsCurrent || savedMatches.snapshot.importSignature !== activeSignature ? <p role="status" className="mt-2 text-sm text-warning">Historical result: the source BOQ or drawings have changed or could not be verified.</p> : null}
              {savedMatches.snapshot.rows.length ? <ul className="mt-2 divide-y divide-border text-sm">
                {savedMatches.snapshot.rows.map((row, i) => <li key={i} className="py-2">
                  <p className="font-medium">{row.name} · {row.quantity} → {row.item} {row.description}</p>
                  <p className="text-muted-foreground">{row.source} · {row.file}{row.note ? ` · ${row.note}` : ''}</p>
                </li>)}
              </ul> : <p className="mt-2 text-sm text-muted-foreground">No primary BOQ matches with drawing-measured quantities were saved from this run.</p>}
              {savedMatches.snapshot.total > savedMatches.snapshot.rows.length ? <p className="text-sm text-muted-foreground">Showing {savedMatches.snapshot.rows.length} of {savedMatches.snapshot.total} saved-run lines.</p> : null}
            </section>
          ) : null}
          {matchSaveNote ? <p role="status" className="text-sm text-muted-foreground">{matchSaveNote}</p> : null}

          <AgentBoqReview
            run={agentRun}
            running={agentRunning}
            events={agentEvents}
            error={agentError}
            stale={agentStale}
            evidence={evidence}
            narrative={narrative}
            onNarrative={(v) => { setNarrative(v); setAssessmentConfirmed(false); }}
            onAddEvidence={(f) => void onAddEvidence(f)}
            onAnalyse={() => void analyse()}
            confirmed={assessmentConfirmed}
            onConfirm={() => void confirmAssessment()}
            answers={answers}
            onAnswers={(a) => { setAnswers(a); setAssessmentConfirmed(false); }}
            hasBoq={activeSet.length > 0}
            onResolve={(componentId, next) => {
              const sl = sharedLines.find((s) => s.componentId === componentId);
              onResolve(componentId, next, sl?.lineId, activeSignature);
            }}
            scheduleStale={resState.scheduleStale}
            costStale={resState.costStale}
            partialAccepted={partialAccepted}
            onContinuePartial={() => setPartialAccepted(true)}
          />

          {valuationNote ? <p role="status" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">{valuationNote}</p> : null}

          {agentRun ? (
            <ValuationPanel
              lines={sharedLines}
              issues={sharedDetailed.issues}
              groups={valuation.groups}
              onGroups={(g: AggregationGroup[]) => { setValuation((v) => ({ ...v, groups: g })); setAssessmentConfirmed(false); }}
              replacements={valuation.replacements}
              onReplacements={(r: { id: string; method: ReplacementMethod; by: string; at: string }[]) => { setValuation((v) => ({ ...v, replacements: r })); setAssessmentConfirmed(false); }}
              totalsLines={totalsLines}
              stale={staleNow.length > 0}
              staleMessages={staleNow.map((r) => STALE_LABEL[r])}
            />
          ) : null}
          {staleNow.length > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
              <span className="text-foreground">Inputs changed since these decisions were made. Re-run the analysis if the scope changed, then accept the current sources.</span>
              <button type="button" onClick={acceptCurrentSources} className="rounded-md border border-input bg-card px-3 py-1.5 font-medium hover:bg-muted">Accept current sources</button>
            </div>
          ) : null}

          {invalidatedCount > 0 ? (
            <div role="alert" className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
              <p className="font-semibold text-foreground">{invalidatedCount} earlier decision{invalidatedCount === 1 ? '' : 's'} were made against a different BOQ revision.</p>
              <p className="text-muted-foreground">They are kept as history but not applied to the current BOQ. Review the affected lines and decide again.</p>
              <ul className="mt-1 list-disc pl-5 text-muted-foreground">{reconciled.invalidated.map((d) => <li key={d.lineId}><span className="font-data">{d.lineId}</span> · {d.resolution.kind === 'manual_rate' ? 'manual rate' : d.resolution.kind === 'excluded' ? 'exclusion' : d.resolution.kind === 'deferred' ? 'deferred valuation' : 'left unresolved'}</li>)}</ul>
            </div>
          ) : null}

          {agentRun ? (
            <section className="rounded-lg border border-border bg-card p-4 shadow-sm" aria-label="Scope items">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-foreground">Scope items <span className="text-sm font-normal text-muted-foreground">({sharedLines.length})</span></h2>
                <button type="button" onClick={() => setItemModal({ draft: null })} className="rounded-md border border-input bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted">Add scope item</button>
              </div>
              {items2.length > 0 ? (
                <ul className="mt-2 divide-y divide-border text-sm">
                  {items2.map((it) => (
                    <li key={it.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                      <span><span className="text-foreground">{it.description}</span> <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">Assessment item · Proposed</span>
                        <span className="block text-xs text-muted-foreground">{it.quantity ?? 'quantity not known'} {it.uom} × {it.rate ?? 'unpriced'} {it.rate ? it.currency : ''} · {it.changeType}{it.linkedScopeLabel ? ` · linked to ${it.linkedScopeLabel}` : ''}</span></span>
                      <span className="flex gap-2"><button type="button" onClick={() => setItemModal({ draft: null, existing: it })} className="text-xs text-accent hover:underline">Edit</button><button type="button" onClick={() => removeItem(it.id)} className="text-xs text-accent hover:underline">Remove</button></span>
                    </li>
                  ))}
                </ul>
              ) : <p className="mt-1 text-sm text-muted-foreground">Assessment items are notes until the scope has a verified drawing takeoff. They do not contribute manually entered quantities or prices to the PVR form.</p>}
            </section>
          ) : null}

          {inputSchedules.length > 1 ? (
                <div className="flex items-center gap-2 text-sm"><label htmlFor="sched-pick" className="text-muted-foreground">Programme in use</label>
                  <select id="sched-pick" value={schedIdx} onChange={(e) => setSchedIdx(Number(e.target.value))} className="rounded-md border border-input bg-card px-2 py-1 text-foreground">{inputSchedules.map((s, i) => <option key={s.docId} value={i}>{s.fileName}{s.subrole ? ` (${s.subrole})` : ''}</option>)}</select></div>
              ) : null}
          {schedLoad && schedLoad.problems.length > 0 ? <ul role="status" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">{schedLoad.problems.map((pr) => <li key={pr.fileName}><span className="font-medium">{pr.fileName}</span>: {pr.reason}</li>)}</ul> : null}
          {agentRun ? (
            <>
              {schedLoading ? <div className="skeleton h-24 rounded-lg" role="status" aria-label="Reading programme" /> : (
                <ActivityMappingPanel
                  model={activeSchedule?.model ?? null}
                  scheduleFileName={activeSchedule?.fileName ?? ''}
                  lines={sharedLines}
                  choices={mappingProgrammeHash === activeSchedule?.sha256 ? mapChoices : {}}
                  onChoices={(c) => { setMappingProgrammeHash(activeSchedule?.sha256 ?? ''); setMapChoices(c); setAssessmentConfirmed(false); }}
                  scheduleExclusions={schedExcl}
                  onScheduleExclusion={(id, ex) => {
                    setSchedExcl((cur) => { const n = { ...cur }; if (ex) n[id] = ex; else delete n[id]; return n; });
                    if (ex?.kind === 'scenario' || (!ex && schedExcl[id]?.kind === 'scenario')) setResState((cur) => { const s = { ...cur, scheduleStale: true, costStale: true, updatedAt: new Date().toISOString() }; writeResolutionState(caseId, s); return s; });
                  }}
                  onManualRate={(id) => setPanelManual(id)}
                  onCreateItem={openCreateItem}
                  onExcludeCost={(id) => setPanelExclude(id)}
                  onDeferCost={(id) => setPanelDefer(id)}
                  partialAccepted={partialAccepted}
                  onContinuePartial={() => setPartialAccepted(true)}
                  running={schedLoading}
                  onRetry={() => setMapRetry((n) => n + 1)}
                  scheduleStale={resState.scheduleStale}
                />
              )}
            </>
          ) : null}

          {activeSchedule ? <RealProgrammePanel key={activeSchedule.sha256} source={activeSchedule} references={referenceSchedules}
            confirmedTaskIds={confirmedProgrammeTasks} onScenario={setProgrammeWhatIf} />
            : referenceSchedules.length > 0 ? <p role="status">A processed programme is available. Upload the pre-impact XER separately to compare the two.</p> : null}
          {activeSchedule && formReady && <ScopeReadinessPanel key={activeSchedule.sha256} lines={formLines} model={activeSchedule.model} />}
          <FinalPvrForm key={caseId} caseId={caseId} title={c.title} lines={formLines} reportReady={formReady} whatIf={whatIf} blockers={formBlockers} drawingNotes={handoff?.openQuestions.filter(q=>q.id.startsWith('referenced-drawing-')).map(q=>q.issue)} verifyDrawingRevisions={drawingsAreCurrent} />
          {itemModal ? (
            <NewItemEntry key={itemModal.existing?.id ?? 'new'} open caseId={caseId} currency={loaded.case.currency || 'AED'} initial={itemModal.draft} existing={itemModal.existing} set={boqSet}
              scopeOptions={(agentRun?.scope.components ?? []).map((c) => ({ id: c.id, label: c.name }))} onClose={() => setItemModal(null)} onSaveItem={saveItem} onAddBoqItem={addBoqItemToScope} newId={() => newId('item')} />
          ) : null}

          {panelManual ? (() => {
            const l = lineById.get(panelManual);
            const comp = agentRun?.scope.components.find((c) => c.id === l?.componentId);
            const q = l ? (comp?.quantity ?? null) : null;
            const existing = l ? answers.resolutions?.[l.componentId] : undefined;
            return <ManualRateModal key={`pm-${panelManual}`} open processedOnly line={l ? ({ componentName: l.name } as never) : null} currency={loaded.case.currency || 'AED'} quantity={q ? { value: q.value, unit: q.unit } : null} scope={comp} direction={l?.work.action === 'omit' ? 'omission' : 'addition'} existing={existing?.kind === 'manual_rate' ? existing.manual : undefined} onClose={() => setPanelManual(null)} onSave={(m) => { resolveLine(panelManual, { kind: 'manual_rate', manual: m }); setPanelManual(null); }} />;
          })() : null}
          {panelExclude ? <ExcludeModal key={`px-${panelExclude}`} open line={lineById.get(panelExclude) ? { componentName: lineById.get(panelExclude)!.name } : null} onClose={() => setPanelExclude(null)} onSave={(r) => { resolveLine(panelExclude, r); setPanelExclude(null); }} /> : null}
          {panelDefer ? <DeferModal key={`pd-${panelDefer}`} open line={lineById.get(panelDefer) ? { componentName: lineById.get(panelDefer)!.name } : null} onClose={() => setPanelDefer(null)} onSave={(r) => { resolveLine(panelDefer, r); setPanelDefer(null); }} /> : null}

          <div className="flex items-center justify-between rounded-lg border border-border bg-card px-5 py-3 shadow-sm">
            <p className="text-sm text-muted-foreground">Standalone what-if calculator. User-entered quantities do not appear in the final PVR form.</p>
            <button type="button" aria-expanded={showManual} onClick={() => setShowManual((v) => !v)} className="rounded-md border border-input bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted">{showManual ? 'Hide manual calculator' : 'Open manual calculator'}</button>
          </div>

          {showManual ? (
          <>
          <section className="rounded-lg border border-border bg-card p-5 shadow-sm" aria-labelledby="chg-title">
            <h2 id="chg-title" className="text-lg font-semibold text-foreground">1. Change</h2>
            <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto_auto_auto]">
              <div>
                <label htmlFor="chg-desc" className="text-sm text-muted-foreground">Change description</label>
                <input id="chg-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="For example: additional pavement" className="mt-0.5 w-full rounded-md border border-input bg-card px-3 py-2 text-foreground" />
              </div>
              <fieldset>
                <legend className="text-sm text-muted-foreground">Effect</legend>
                <div className="mt-0.5 flex overflow-hidden rounded-md border border-input">
                  {(['addition', 'omission'] as ChangeDirection[]).map((d) => (
                    <label key={d} className={`cursor-pointer px-3 py-2 ${direction === d ? 'bg-primary text-primary-foreground' : 'bg-card text-foreground hover:bg-muted'}`}>
                      <input type="radio" name="dir" value={d} checked={direction === d} onChange={() => setDirection(d)} className="sr-only" />
                      {d === 'addition' ? 'Addition (+)' : 'Omission (−)'}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div>
                <label htmlFor="chg-qty" className="text-sm text-muted-foreground">Quantity <span className="rounded bg-secondary px-1.5 py-0.5 text-xs font-medium text-secondary-foreground">User-entered</span></label>
                <input id="chg-qty" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} aria-invalid={quantity !== '' && !validateDecimalText(quantity)} className="mt-0.5 w-32 rounded-md border border-input bg-card px-3 py-2 text-right tabular text-foreground" />
              </div>
              <div>
                <label htmlFor="chg-unit" className="text-sm text-muted-foreground">Unit</label>
                <input id="chg-unit" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="m2" className="mt-0.5 w-24 rounded-md border border-input bg-card px-3 py-2 text-foreground" />
              </div>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">This quantity is entered by you. It was not measured from a drawing.</p>
          </section>

          <section className="rounded-lg border border-border bg-card p-5 shadow-sm" aria-labelledby="sel-title">
            <h2 id="sel-title" className="text-lg font-semibold text-foreground">2. Select the BOQ item</h2>
            <div className="relative mt-3 max-w-xl">
              <Search size={16} className="pointer-events-none absolute left-3 top-3 text-muted-foreground" aria-hidden />
              <input aria-label="Search BOQ items" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by reference or description (manual search works without AI)" className="w-full rounded-md border border-input bg-card py-2 pl-9 pr-3 text-foreground" />
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{query.trim() === '' && description.trim() === '' ? 'All items in this BOQ revision.' : 'Candidates ranked by keyword match with the search text or change description. Suggestions only; you choose.'}</p>
            <div className="mt-2 max-h-72 overflow-auto rounded-md border border-border">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="sticky top-0 bg-muted text-left text-muted-foreground"><tr><th className="px-2 py-2">Select</th><th className="px-2 py-2">Ref</th><th className="px-2 py-2">Description</th><th className="px-2 py-2">Unit</th><th className="px-2 py-2 text-right">Rate ({c.currency})</th><th className="px-2 py-2">Source</th></tr></thead>
                <tbody>
                  {shown.length === 0 ? <tr><td colSpan={6} className="px-3 py-4 text-muted-foreground">No matching items. Try other words, or clear the search.</td></tr> : shown.map(({ item, unitMatches }) => (
                    <tr key={item.id} className={`border-t border-border ${item.id === itemId ? 'bg-accent/5' : ''}`}>
                      <td className="px-2 py-1.5"><input type="radio" name="item" aria-label={`Select ${item.ref} ${item.description}`} checked={item.id === itemId} onChange={() => setItemId(item.id)} className="h-4 w-4 accent-[var(--accent)]" /></td>
                      <td className="px-2 py-1.5 font-data text-foreground">{item.ref}</td>
                      <td className="px-2 py-1.5 text-foreground">{item.description}</td>
                      <td className="px-2 py-1.5 text-foreground">{item.unit || '—'}{unitMatches === false ? <span className="ml-1 text-xs text-warning">≠ {unit}</span> : null}</td>
                      <td className="px-2 py-1.5 text-right tabular text-foreground">{item.rate.state === 'value' ? item.rate.value : <span className="text-warning">{item.rate.state === 'missing' ? 'No rate' : 'Invalid'}</span>}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-data text-muted-foreground">{item.sheet}!{item.rowNumber}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-5 shadow-sm" aria-labelledby="res-title" aria-live="polite">
            <h2 id="res-title" className="flex items-center gap-2 text-lg font-semibold text-foreground"><Calculator size={18} aria-hidden />3. Cost result</h2>
            {!selectedItem ? <p className="mt-2 text-muted-foreground">Select a BOQ item to calculate.</p> : null}

            {selectedItem && plan && plan.kind === 'same_dimension' ? (
              <p className="mt-3 rounded-md border border-border bg-background px-4 py-3 text-sm text-foreground">Same-dimension conversion: “{unit}” to “{selectedItem.unit}” uses the exact built-in factor {plan.factor}. No extra input is needed.</p>
            ) : null}

            {selectedItem && plan && plan.kind === 'invalid' ? (
              <p role="alert" className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-foreground"><AlertTriangle size={16} className="mt-0.5 text-destructive" aria-hidden /><span><span className="font-semibold">Not convertible. </span>{plan.reason} Choose a BOQ item measured in a compatible unit, or re-measure the change.</span></p>
            ) : null}

            {selectedItem && plan && plan.kind === 'needs_derivation' ? (
              <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-4">
                <p className="flex items-center gap-2 font-semibold text-foreground"><AlertTriangle size={16} className="text-warning" aria-hidden />Derivation required: “{unit}” cannot become “{selectedItem.unit}” without extra measurements.</p>
                <p className="mt-1 text-sm text-foreground">{plan.explanation}</p>
                <p className="text-sm text-muted-foreground">Valuation is blocked until every input below and a basis are given.</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {plan.required.map((name) => (
                    <div key={name} className="flex gap-2">
                      <div className="flex-1">
                        <label htmlFor={`deriv-${name}`} className="text-sm capitalize text-muted-foreground">{name}</label>
                        <input id={`deriv-${name}`} inputMode="decimal" value={derivInputs[name]?.value ?? ''} onChange={(e) => setDerivInputs((d) => ({ ...d, [name]: { value: e.target.value, unit: d[name]?.unit ?? 'm' } }))} className="mt-0.5 w-full rounded-md border border-input bg-card px-3 py-2 tabular text-foreground" />
                      </div>
                      <div className="w-24">
                        <label htmlFor={`deriv-${name}-unit`} className="text-sm text-muted-foreground">Unit</label>
                        <input id={`deriv-${name}-unit`} value={derivInputs[name]?.unit ?? 'm'} onChange={(e) => setDerivInputs((d) => ({ ...d, [name]: { value: d[name]?.value ?? '', unit: e.target.value } }))} className="mt-0.5 w-full rounded-md border border-input bg-card px-3 py-2 text-foreground" />
                      </div>
                    </div>
                  ))}
                </div>
                <fieldset className="mt-3">
                  <legend className="text-sm text-muted-foreground">Where do these values come from?</legend>
                  <div className="mt-1 flex flex-wrap gap-4 text-sm">
                    <label className="flex items-center gap-2"><input type="radio" name="basis-kind" checked={basisKind === 'source'} onChange={() => setBasisKind('source')} className="h-4 w-4 accent-[var(--accent)]" />A source document</label>
                    <label className="flex items-center gap-2"><input type="radio" name="basis-kind" checked={basisKind === 'user_confirmed'} onChange={() => setBasisKind('user_confirmed')} className="h-4 w-4 accent-[var(--accent)]" />My own assumption, which I confirm</label>
                  </div>
                  <label htmlFor="deriv-basis" className="mt-2 block text-sm text-muted-foreground">{basisKind === 'source' ? 'Cite the source (document, sheet or clause)' : 'State the assumption you are confirming'}</label>
                  <input id="deriv-basis" value={basisText} onChange={(e) => setBasisText(e.target.value)} placeholder={basisKind === 'source' ? 'For example: Drawing R4-01, typical section, carriageway 3.0 m' : 'For example: I assume a 3.0 m wide pavement'} className="mt-0.5 w-full rounded-md border border-input bg-card px-3 py-2 text-foreground" />
                </fieldset>
              </div>
            ) : null}

            {result && !result.ok ? (
              <p role={result.kind === 'invalid_input' || result.kind === 'no_item' ? 'status' : 'alert'} className={`mt-3 rounded-md border px-4 py-3 ${result.kind === 'unpriced' ? 'border-warning/40 bg-warning/10 text-foreground' : 'border-border bg-background text-muted-foreground'}`}>
                {result.kind === 'unpriced' ? <span className="font-semibold">Unpriced — not zero. </span> : null}
                {result.message}
              </p>
            ) : null}

            {result && result.ok ? (
              <div className="mt-3 space-y-3">
                <p className={`text-3xl font-bold tabular ${result.direction === 'omission' ? 'text-destructive' : 'text-foreground'}`}>{formatSigned(result.signedAmount, result.currency)}</p>
                <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Effect</dt><dd className="text-foreground">{result.direction === 'addition' ? 'Addition (+)' : 'Omission (−)'}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Original quantity (user-entered)</dt><dd className="tabular text-foreground">{result.conversion.originalQuantity} {result.conversion.originalUnit}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Derived quantity (BOQ unit)</dt><dd className="tabular text-foreground">{result.conversion.derivedQuantity} {result.conversion.derivedUnit}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Imported rate</dt><dd className="tabular text-foreground">{result.currency} {result.rate} / {result.boqUnit}</dd></div>
                </dl>
                {result.conversion.type !== 'identity' ? (
                  <div className="rounded-md border border-border bg-background px-3 py-2 text-sm">
                    <p className="font-semibold text-foreground">{result.conversion.type === 'derivation' ? 'Derived quantity (shown before valuation)' : 'Unit conversion'}</p>
                    <p className="font-data text-foreground">{result.conversion.derivation}</p>
                    {result.conversion.supportingInputs.length > 0 ? <p className="text-muted-foreground">Supporting inputs: {result.conversion.supportingInputs.map((s) => `${s.name} ${s.value} ${s.unit}`).join(', ')}</p> : null}
                    {result.conversion.basis ? <p className="text-muted-foreground">Basis ({result.conversion.basis.kind === 'source' ? 'source' : 'user-confirmed assumption'}): {result.conversion.basis.statement}</p> : null}
                  </div>
                ) : null}
                <p className="rounded-md bg-background px-3 py-2 font-data text-sm text-foreground">{result.formula}</p>
                {result.rateFormulaNote ? <p className="text-sm text-warning">{result.rateFormulaNote}</p> : null}
                <div className="text-sm text-muted-foreground">
                  <p className="font-semibold text-foreground">Source evidence</p>
                  {result.sources.map((s) => <p key={s.sheet + s.rateCell} className="font-data">{s.file} · sheet {s.sheet} · rate {s.rateCell}{s.refCell ? ` · ref ${s.refCell}` : ''}{s.unitCell ? ` · unit ${s.unitCell}` : ''}</p>)}
                  <button type="button" onClick={() => setAdvanced((v) => !v)} className="mt-1 text-accent hover:underline">{advanced ? 'Hide' : 'Show'} file hash</button>
                  {advanced ? <p className="break-all font-data">SHA-256 {result.sources[0].sha256}</p> : null}
                </div>
                <p className="text-sm text-muted-foreground">Calculated deterministically in this browser from the confirmed import. No AI was used. This is a single-line indicative amount, not an assessed valuation.</p>
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" onClick={() => void saveThisCalculation()} disabled={savingCalc} className="rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60">{remapping ? 'Save recalculation against this revision' : 'Save this calculation'}</button>
                  <span className="text-sm text-muted-foreground">Saved results record revision {selectedImport.revision}, the row, rate, quantity and conversion basis, and are never overwritten.</span>
                </div>
              </div>
            ) : null}
          </section>
          </>
          ) : null}

          <section className="rounded-lg border border-border bg-card p-5 shadow-sm" aria-labelledby="saved-title">
            <h2 id="saved-title" className="text-lg font-semibold text-foreground">4. Saved calculations</h2>
            {calcError ? <p role="alert" className="mt-2 text-destructive">Could not load saved calculations: {calcError}</p> : null}
            {needReview.length > 0 ? (
              <div role="alert" className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-4">
                <p className="flex items-center gap-2 font-semibold text-foreground"><AlertTriangle size={16} className="text-warning" aria-hidden />{needReview.length} calculation{needReview.length === 1 ? '' : 's'} need review or recalculation</p>
                <p className="text-sm text-muted-foreground">These were computed from a different BOQ revision than the one now active. They are kept as history and cannot be shown as current or approved.</p>
              </div>
            ) : null}
            {calcs.length === 0 ? <p className="mt-2 text-muted-foreground">Nothing saved yet for this case.</p> : (
              <ul className="mt-3 space-y-3">
                {stale.map(({ calc: c, info }) => (
                  <li key={c.id} className={`rounded-md border p-3 ${info.status === 'current' ? 'border-border bg-background' : 'border-warning/40 bg-warning/5'}`}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-semibold text-foreground">{c.description || c.itemDescription} <span className="font-data text-sm text-muted-foreground">{c.itemRef}</span></p>
                        <p className="font-data text-xs text-muted-foreground">Revision {c.importRevision} · {c.importFileName} · {c.sheet}!{c.rowNumber} · rate cell {c.rateCell} · {c.importSha256.slice(0, 12)}…</p>
                        <p className="text-sm text-foreground">{c.direction === 'addition' ? '+' : '−'} {c.quantity} {c.quantityUnit} → {c.convertedQuantity} {c.boqUnit} × {c.currency} {c.rate}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-bold tabular text-foreground">{formatSigned(c.signedAmount, c.currency)}</p>
                        <span className={`rounded px-2 py-0.5 text-xs font-medium ${info.status === 'current' ? 'bg-secondary text-secondary-foreground' : 'bg-warning/20 text-foreground'}`}>{info.status === 'current' ? 'Current' : 'Needs review / recalculation'}</span>
                      </div>
                    </div>
                    {info.status === 'needs_review' ? (
                      <div className="mt-2 space-y-2">
                        <p className="text-sm text-foreground">{info.reason}</p>
                        <p className="text-xs text-muted-foreground">Not ready for approval. Remapping must be reviewed before recalculation.</p>
                        <div className="flex flex-wrap gap-2">
                          <button type="button" onClick={() => void confirmRemap(c)} className="rounded-md border border-input bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted">Review remapped item and recalculate</button>
                          {!info.rowMissing && !info.rowChanged ? <button type="button" onClick={() => void markReviewed(c)} className="rounded-md border border-input bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted">Rate and unit unchanged: mark reviewed</button> : null}
                        </div>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {currentCalcs.length > 0 ? <p className="mt-3 text-sm text-muted-foreground">{currentCalcs.length} current calculation{currentCalcs.length === 1 ? '' : 's'} on revision {selectedImport.revision}.</p> : null}
          </section>
        </>
      )}
    </div>
  );
}

'use client';

import React, { useMemo, useState } from 'react';
import { Check, ChevronDown, CircleAlert, CircleMinus, Clock, FileText, FolderOpen, Paperclip, Table2, Calendar, Image as ImageIcon, FileSignature, Gauge } from 'lucide-react';
import { DOC_GROUPS, filesForGroup, unusedFiles, type DocGroup, type GroupKey } from '@/lib/intake/docGroups';
import type { OutputReadiness, ReadyState } from '@/lib/intake/readiness';
import type { ClassifiedFile } from '@/lib/intake/triage';
import Icon from '@/components/ui/AppIcon';
import { CategoryEditor, DocActionMenu, type DocActions, type ManagedDoc } from '@/app/new-pvr/components/DocumentManager';
import type { DraftSummary } from '@/lib/docs/scopedDraft';


const GROUP_ICON: Record<GroupKey, React.ComponentType<{ size?: number; className?: string }>> = {
  pvr: FileText,
  boq: Table2,
  programme: Calendar,
  drawings: ImageIcon,
  contract: FileSignature,
  productivity: Gauge,
  supporting: Paperclip,
};

interface EvidencePackProps {
  files: ClassifiedFile[];
  processed: boolean;
  reading: boolean;
  failed: boolean;
  readiness: OutputReadiness[];
  narrative: string;
  onNarrative: (v: string) => void;
  scheduleChoice: string;
  onScheduleChoice: (path: string) => void;
  uploadSlot: React.ReactNode;
  onLoadSample: () => void;
  onClear: () => void;
  onAddToGroup: (g: DocGroup) => void;
  draftSavedAt: string;
  /** Registry rows keyed by path: the single source for both document lists. */
  docByPath: Map<string, ManagedDoc>;
  docActions: DocActions;
  onStartNew: () => void;
  resumable: DraftSummary[];
  onResume: (scopeId: string) => void;
  /** Shown when the current analysis no longer matches the document set. */
  staleReason: string;
  /** Short status line after a document action ("Document removed", "3 documents reclassified"…). */
  feedback: string;
  busy: boolean;
}

const NARRATIVE_MAX = 1000;

function statusChip(state: ReadyState, text: string) {
  const map: Record<ReadyState, { cls: string; icon: React.ReactNode }> = {
    ready: { cls: 'bg-accent/10 text-accent', icon: <Check size={14} aria-hidden /> },
    ready_assumptions: { cls: 'bg-accent/10 text-accent', icon: <Check size={14} aria-hidden /> },
    choice: { cls: 'bg-warning/15 text-warning', icon: <CircleAlert size={14} aria-hidden /> },
    missing: { cls: 'bg-muted text-muted-foreground', icon: <CircleMinus size={14} aria-hidden /> },
    not_processed: { cls: 'bg-secondary text-secondary-foreground', icon: <Clock size={14} aria-hidden /> },
  };
  const m = map[state];
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-sm font-medium ${m.cls}`}>{m.icon}{text}</span>;
}

function groupStatus(g: DocGroup, list: ClassifiedFile[], processed: boolean, scheduleChoice: string): { state: ReadyState; text: string } {
  if (list.length === 0) return g.optional ? { state: 'missing', text: 'Optional' } : { state: 'missing', text: 'Missing' };
  if (!processed) return { state: 'not_processed', text: 'Not read yet' };
  if (g.key === 'programme' && list.length > 1 && !scheduleChoice) return { state: 'choice', text: 'Confirm version' };
  return { state: 'ready', text: 'Read' };
}

function sourceText(g: DocGroup, list: ClassifiedFile[]): string {
  if (list.length === 0) return g.emptyHint;
  if (list.length === 1) return list[0].name;
  if (g.key === 'boq') return `${list.length} bill files`;
  return `${list.length} files`;
}

export default function EvidencePack(p: EvidencePackProps) {
  const [open, setOpen] = useState<GroupKey | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const unused = useMemo(() => unusedFiles(p.files), [p.files]);
  const schedules = useMemo(() => filesForGroup(p.files, DOC_GROUPS.find((g) => g.key === 'programme')!), [p.files]);
  const blockedNotes = p.readiness.filter((r) => r.blocks && r.state !== 'ready');
  const hasFiles = p.files.length > 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section className="rounded-lg border border-border bg-card p-5 shadow-sm" aria-labelledby="pack-title">
        <div className="flex items-start gap-3">
          <FolderOpen size={22} className="mt-1 text-primary" aria-hidden />
          <div>
            <h2 id="pack-title" className="text-xl font-semibold text-foreground">Build your evidence pack</h2>
            <p className="text-muted-foreground">Upload files, or describe the change below. Project reference library reuse is not built yet.</p>
          </div>
        </div>

        <div className="mt-4">{p.uploadSlot}</div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold text-foreground">Assessment documents</h3>
          <div className="flex items-center gap-2">
            {hasFiles ? <button type="button" disabled={p.busy} onClick={p.onClear} className="rounded-md px-2.5 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">Clear files</button> : null}
            <button type="button" disabled={p.busy} onClick={p.onStartNew} className="rounded-md border border-input bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50">Start new PVR</button>
            <button type="button" onClick={p.onLoadSample} className="rounded-md border border-input bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted">Load sample case</button>
          </div>
        </div>

        {p.feedback ? <p role="status" aria-live="polite" className="mt-2 rounded-md bg-secondary px-4 py-2 text-sm text-secondary-foreground">{p.feedback}</p> : null}
        {p.staleReason ? <p role="status" className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-foreground">Current results may be out of date: {p.staleReason} Analyse again to recalculate. Earlier assessment versions are kept.</p> : null}
        {p.resumable.length > 0 ? (
          <div className="mt-2 rounded-md border border-border bg-background px-4 py-2 text-sm">
            <p className="font-medium text-foreground">Resume previous draft</p>
            <ul className="mt-1 space-y-1">
              {p.resumable.slice(0, 3).map((r) => (
                <li key={r.scopeId} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-muted-foreground">{r.label} · {r.files} file{r.files === 1 ? '' : 's'}</span>
                  <button type="button" onClick={() => p.onResume(r.scopeId)} className="rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted">Resume</button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {!hasFiles ? (
          <p className="mt-2 rounded-md border border-dashed border-input bg-background px-4 py-3 text-muted-foreground">
            Nothing uploaded yet. The sample case loads synthetic Fahid Island files so you can see the screen working.
          </p>
        ) : null}

        <div className="mt-3 overflow-hidden rounded-lg border border-border">
          <div role="table" aria-label="Assessment documents" className="w-full">
            <div role="row" className="grid grid-cols-[minmax(150px,1.1fr)_minmax(0,1.6fr)_minmax(130px,auto)_28px] gap-3 border-b border-border bg-muted px-4 py-2 text-sm font-semibold text-muted-foreground">
              <span role="columnheader">Document group</span>
              <span role="columnheader">Source</span>
              <span role="columnheader">Status</span>
              <span role="columnheader" className="sr-only">Expand</span>
            </div>
            {DOC_GROUPS.map((g) => {
              const list = filesForGroup(p.files, g);
              const st = groupStatus(g, list, p.processed, p.scheduleChoice);
              const Icon = GROUP_ICON[g.key];
              const expanded = open === g.key;
              return (
                <div key={g.key} role="rowgroup" className="border-b border-border last:border-b-0">
                  <div role="row" className={`grid grid-cols-[minmax(150px,1.1fr)_minmax(0,1.6fr)_minmax(130px,auto)_28px] items-center gap-3 px-4 py-2.5 ${expanded ? 'bg-accent/5' : ''}`}>
                    <span role="cell" className="flex items-center gap-2.5 font-medium text-foreground"><Icon size={18} className="shrink-0 text-muted-foreground" aria-hidden />{g.label}</span>
                    <span role="cell" className={`truncate ${list.length === 0 ? 'italic text-muted-foreground' : 'text-foreground'}`} title={sourceText(g, list)}>{sourceText(g, list)}</span>
                    <span role="cell">{statusChip(st.state, st.text)}</span>
                    <button type="button" aria-expanded={expanded} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${g.label}`} onClick={() => setOpen(expanded ? null : g.key)} className="rounded p-1 text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
                      <ChevronDown size={16} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
                    </button>
                  </div>
                  {expanded ? (
                    <div className="border-t border-border bg-background px-4 py-3">
                      {list.length === 0 ? (
                        <p className="text-muted-foreground">{g.emptyHint}</p>
                      ) : (
                        <ul className="divide-y divide-border">
                          {list.map((f) => {
                            const md = p.docByPath.get(f.path);
                            return (
                              <li key={f.path} className="py-1.5">
                                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                                  <span className="min-w-0 flex-1 break-all text-foreground">{f.name}</span>
                                  <span className="text-sm text-muted-foreground">{md ? `${md.categoryLabel}${md.subroleLabel ? ` · ${md.subroleLabel}` : ''}` : f.reason}</span>
                                  {md ? <DocActionMenu doc={md} actions={p.docActions} onChangeCategory={(id) => setEditingId(id)} /> : null}
                                </div>
                                {md && editingId === md.id ? (
                                  <CategoryEditor docs={[md]} onCancel={() => setEditingId(null)} onApply={(c, s, m) => { p.docActions.onReclassify([md.id], c, s, m); setEditingId(null); }} />
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      {g.addAs ? (
                        <button type="button" onClick={() => p.onAddToGroup(g)} className="mt-3 rounded-md border border-input bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted">Add files to this group</button>
                      ) : (
                        <p className="mt-3 text-sm text-muted-foreground">No automatic recognition for this group yet, so files cannot be filed here.</p>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
        {unused.length > 0 ? <p className="mt-2 text-sm text-muted-foreground">{unused.length} file{unused.length === 1 ? '' : 's'} not used for this assessment (temporary or unrelated). Review them in the next step.</p> : null}

        <div className="mt-5">
          <div className="flex items-baseline justify-between">
            <label htmlFor="change-narrative" className="text-base font-semibold text-foreground">Describe the change</label>
            <span className="text-sm text-muted-foreground tabular">{p.narrative.length}/{NARRATIVE_MAX}</span>
          </div>
          <textarea
            id="change-narrative"
            value={p.narrative}
            maxLength={NARRATIVE_MAX}
            onChange={(e) => p.onNarrative(e.target.value)}
            rows={3}
            placeholder="For example: Extend access road R4 from 5.0 km to 7.0 km, including pavement, kerbs and lighting."
            className="mt-1.5 w-full rounded-md border border-input bg-card px-3 py-2.5 text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30"
          />
          <p className="mt-1 text-sm text-muted-foreground">Used even when a PVR document is present. Quantities in the narrative are marked as narrative-stated, not measured.</p>
        </div>
      </section>

      <aside className="space-y-4" aria-label="Assessment readiness">
        <section className="rounded-lg border border-border bg-card p-5 shadow-sm">
          <h2 className="text-xl font-semibold text-foreground">Assessment readiness</h2>
          <ul className="mt-3 divide-y divide-border">
            {p.readiness.map((r) => (
              <li key={r.key} className="py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-foreground">{r.label}</span>
                  {statusChip(r.state, r.stateLabel)}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{r.detail}</p>
              </li>
            ))}
          </ul>
          {p.failed ? <p role="alert" className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">The files could not be read. Nothing is marked ready. Try again.</p> : null}
        </section>

        {schedules.length > 1 && p.processed ? (
          <section className="rounded-lg border border-warning/40 bg-warning/10 p-5" aria-label="Choose the assessment programme">
            <h3 className="text-lg font-semibold text-foreground">Choose the assessment programme</h3>
            <p className="mt-1 text-muted-foreground">Select which programme to use for the impact assessment.</p>
            <fieldset className="mt-3 space-y-2">
              <legend className="sr-only">Assessment programme</legend>
              {schedules.map((s) => (
                <label key={s.path} className="flex cursor-pointer items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5">
                  <input type="radio" name="programme" checked={p.scheduleChoice === s.path} onChange={() => p.onScheduleChoice(s.path)} className="h-4 w-4 accent-[var(--accent)]" />
                  <span className="min-w-0 break-all text-foreground">{s.name}</span>
                </label>
              ))}
            </fieldset>
            <p className="mt-2 text-sm text-muted-foreground">Which file is current or contractual is not detected automatically. Choose it yourself.</p>
          </section>
        ) : null}

        {blockedNotes.length > 0 ? (
          <section className="rounded-lg border border-border bg-card p-5 shadow-sm" aria-label="Missing evidence and effect">
            <h3 className="text-base font-semibold text-foreground">What is missing, and what it affects</h3>
            <ul className="mt-2 space-y-2">
              {blockedNotes.map((r) => (
                <li key={r.key} className="flex gap-2 text-muted-foreground"><CircleAlert size={16} className="mt-1 shrink-0 text-warning" aria-hidden /><span><span className="font-medium text-foreground">{r.label}: </span>{r.blocks}</span></li>
              ))}
            </ul>
          </section>
        ) : null}

        <p className="rounded-md bg-secondary px-4 py-3 text-sm text-secondary-foreground">
          <span className="font-semibold">Draft storage: this browser only.</span> {p.draftSavedAt ? `Last saved ${p.draftSavedAt}. ` : 'Not saved yet. '}Server-side saving is not connected, so clearing browser data or switching device loses this draft.
        </p>
      </aside>
    </div>
  );
}

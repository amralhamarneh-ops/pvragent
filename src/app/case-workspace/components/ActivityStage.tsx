'use client';

import React, { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import ConfidenceBar from '@/components/ui/ConfidenceBar';
import { activitySummary, buildFahidSchedule, candidatesFor, DEFAULT_FILTERS, neighbours, toCandidate, wbsBranchCounts, type ScheduleFilters } from '@/lib/mapping/activityEngine';
import { formatDate } from '@/lib/mapping/xerParser';
import type { ActivityMapping, BoqMapping, NewActivitySuggestion, StageStatus } from '@/lib/mapping/types';
import type { StageKey } from '@/lib/mapping/useCaseStore';
import DemoLineActions, { type DemoDecision } from '@/app/case-workspace/components/DemoLineActions';

interface ActivityStageProps {
  status: StageStatus;
  boq: BoqMapping[];
  mappings: ActivityMapping[];
  suggestions: NewActivitySuggestion[];
  filters: ScheduleFilters;
  onFilters: (f: ScheduleFilters) => void;
  onChange: (m: ActivityMapping[], s: NewActivitySuggestion[]) => void;
  onRun: () => void;
  running: boolean;
  onEdited: (stage: StageKey) => void;
}

const model = buildFahidSchedule();
const PROGRESS_LABEL = { completed: 'Complete', in_progress: 'In progress', not_started: 'Not started' } as const;

export default function ActivityStage({ status, boq, mappings, suggestions, filters, onFilters, onChange, onRun, running, onEdited }: ActivityStageProps) {
  const [selected, setSelected] = useState<string>(() => model.activities.find((a) => (a.status ?? 'not_started') !== 'completed')?.id ?? model.activities[0]?.id ?? '');
  const [decisions, setDecisions] = useState<Record<string, DemoDecision>>({});
  const decide = (id: string, d: DemoDecision | undefined) => setDecisions((cur) => { const n = { ...cur }; if (d) n[id] = d; else delete n[id]; return n; });
  const [branch, setBranch] = useState<string | null>(null);
  const [searchFor, setSearchFor] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [editSug, setEditSug] = useState<string | null>(null);
  const [sugName, setSugName] = useState('');

  const branches = useMemo(() => wbsBranchCounts(model), []);
  const included = boq.filter((b) => b.included);
  const mappedIds = new Set(mappings.filter((m) => m.activityId && m.accepted).map((m) => m.boqMappingId));
  const unmapped = included.filter((b) => b.class !== 'omission' && !mappedIds.has(b.id) && !suggestions.some((s) => s.boqMappingId === b.id && s.accepted));
  const mark = (next: ActivityMapping[], s = suggestions) => { onChange(next, s); onEdited('activity'); };

  const toggle = (id: string, accepted: boolean) => mark(mappings.map((m) => (m.id === id ? { ...m, accepted } : m)));
  const markNew = (boqId: string) => {
    const b = boq.find((x) => x.id === boqId);
    if (!b || suggestions.some((s) => s.boqMappingId === boqId)) return;
    // Logic is derived from the model: the best open candidate is the predecessor and its first successor the successor.
    const anchor = candidatesFor(b, model, filters, 3).find((c) => c.progressStatus !== 'completed') ?? candidatesFor(b, model, filters, 1)[0];
    const succ = anchor ? neighbours(anchor.activityId, model).succs[0]?.activity : undefined;
    const next: NewActivitySuggestion = { boqMappingId: boqId, name: `${b.description}${anchor ? ` (after ${anchor.activityId})` : ''}`, predecessor: anchor ? `${anchor.activityId} ${anchor.name} (SS)` : 'No predecessor identified', successor: succ ? `${succ.id} ${succ.name}` : 'No successor identified', accepted: false };
    mark([...mappings.filter((m) => !(m.boqMappingId === boqId && !m.activityId)), { id: `AM-${boqId}-new`, boqMappingId: boqId, activityId: null, wbsPath: anchor?.wbsPath ?? '', baselineStart: '', baselineFinish: '', durationDays: 0, totalFloat: 0, progressStatus: 'not_started', isCritical: false, quantityShare: 100, confidence: 60, reason: 'Marked by you as needing a new activity.', newActivityNeeded: true, accepted: false }], [...suggestions, next]);
  };
  const addActivity = (boqId: string, actId: string) => {
    const a = model.activities.find((x) => x.id === actId);
    if (!a || mappings.some((m) => m.boqMappingId === boqId && m.activityId === actId)) return;
    const c = toCandidate(a, 0.7, 'Added by you.');
    const forBoq = mappings.filter((m) => m.boqMappingId === boqId && m.activityId);
    const share = 100 / (forBoq.length + 1);
    const next = mappings.filter((m) => !(m.boqMappingId === boqId && !m.activityId)).map((m) => (m.boqMappingId === boqId && m.activityId ? { ...m, quantityShare: share } : m));
    mark([...next, { id: `AM-${boqId}-${actId}`, boqMappingId: boqId, activityId: actId, wbsPath: c.wbsPath, baselineStart: c.baselineStart, baselineFinish: c.baselineFinish, durationDays: c.durationDays, totalFloat: c.totalFloat, progressStatus: c.progressStatus, isCritical: c.isCritical, quantityShare: share, confidence: c.confidence, reason: 'Added by you.', newActivityNeeded: false, accepted: true, candidate: c }], suggestions.filter((s) => s.boqMappingId !== boqId));
    setSearchFor(null); setQ('');
  };
  const setShare = (id: string, v: number) => mark(mappings.map((m) => (m.id === id ? { ...m, quantityShare: Math.max(0, Math.min(100, v)) } : m)));

  if (status === 'not_started' || status === 'running') {
    return (
      <div className="space-y-5">
        <h1 className="text-headline font-semibold text-foreground">{running ? 'The Schedule agent is reading the baseline.' : 'Link each confirmed BoQ item to schedule activities.'}</h1>
        <p className="max-w-2xl text-muted-foreground">It reads tasks, WBS, calendars, relationships, float and progress. Cost and schedule recalculation come in later stages.</p>
        {running ? <div className="space-y-3" aria-hidden><div className="skeleton h-14 rounded-lg" /><div className="skeleton h-64 rounded-lg" /></div> : <button type="button" onClick={onRun} className="rounded-md bg-primary px-5 py-2.5 font-semibold text-primary-foreground hover:opacity-90">Run activity mapping</button>}
        {running ? <p className="flex items-center gap-2 text-muted-foreground"><Loader2 size={15} className="animate-spin" />Reading schedule</p> : null}
      </div>
    );
  }

  const selectedAct = model.activities.find((a) => a.id === selected);
  const nb = selectedAct ? neighbours(selectedAct.id, model) : { preds: [], succs: [] };
  const needNew = suggestions.length;
  const summary = activitySummary(mappings, included.length);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-headline font-semibold text-foreground">{summary}</h1>
        <p className="mt-1 max-w-2xl text-muted-foreground">Schedule read: {model.activityCount} activities, data date {formatDate(model.dataDate)}. Filters come from the drawing changes.</p>
      </div>

      {unmapped.length > 0 ? (
        <div className="rounded-lg border-2 border-warning bg-warning/5 p-4" role="alert">
          <p className="font-semibold text-foreground">{unmapped.length} item{unmapped.length === 1 ? ' has' : 's have'} no activity yet</p>
          <ul className="mt-1 list-disc pl-5 text-foreground">{unmapped.map((u) => <li key={u.id}>{u.boqRef} {u.description} <button type="button" onClick={() => markNew(u.id)} className="ml-2 font-medium text-accent underline">Mark as new activity needed</button></li>)}</ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2" aria-label="Filters">
        <span className="rounded-full bg-success/10 px-3 py-1 text-sm font-medium text-success">{mappedIds.size} mapped</span>
        <span className="rounded-full bg-warning/20 px-3 py-1 text-sm font-medium text-foreground">{needNew} need new activities</span>
        <span className="rounded-full bg-muted px-3 py-1 text-sm font-medium text-muted-foreground">{unmapped.length} unmapped</span>
        <label className="sr-only" htmlFor="f-zone">Zone</label>
        <select id="f-zone" value={filters.zone} onChange={(e) => { onFilters({ ...filters, zone: e.target.value }); onEdited('activity'); }} className="rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-sm font-medium">
          <option>Zone C East Spine</option><option>Zone A West Spine</option>
        </select>
        <label className="sr-only" htmlFor="f-ch">Chainage</label>
        <select id="f-ch" value={`${filters.chainFrom}-${filters.chainTo}`} onChange={(e) => { const [a, b] = e.target.value.split('-').map(Number); onFilters({ ...filters, chainFrom: a, chainTo: b }); onEdited('activity'); }} className="rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-sm font-medium">
          <option value="5000-7000">CH 5+000 to 7+000</option><option value="0-7000">CH 0+000 to 7+000</option>
        </select>
        <label className="sr-only" htmlFor="f-disc">Discipline</label>
        <select id="f-disc" value={filters.discipline} onChange={(e) => { onFilters({ ...filters, discipline: e.target.value }); onEdited('activity'); }} className="rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-sm font-medium">
          <option>Civil Roads</option><option>Lighting</option><option>Drainage</option>
        </select>
      </div>

      <div className="grid gap-5 xl:grid-cols-[220px_minmax(0,1fr)_300px]">
        <nav aria-label="WBS" className="h-fit rounded-lg border border-border bg-card p-3">
          <p className="mb-2 font-semibold text-foreground">WBS, {model.activities.filter((a) => a.zone === filters.zone).length} of {model.activityCount} activities</p>
          <ul className="space-y-0.5">
            {['Fahid Island Roads', filters.zone, 'R4 Access road'].map((n, i) => <li key={n} style={{ paddingLeft: i * 12 }} className="py-1 text-foreground">{n}</li>)}
            {branches.filter((b) => !['Fahid Island Roads', 'Zone C East Spine', 'R4 Access road', 'R7 Boulevard', 'Landscape'].includes(b.name)).map((b) => (
              <li key={b.name} style={{ paddingLeft: 36 }}>
                <button type="button" onClick={() => setBranch(branch === b.name ? null : b.name)} className={`w-full rounded px-2 py-1 text-left ${branch === b.name ? 'bg-accent/10 font-semibold' : 'hover:bg-muted'}`}>{b.name} <span className="text-sm text-muted-foreground">{b.count}</span></button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="space-y-4">
          {included.filter((b) => b.class !== 'omission' || mappings.some((m) => m.boqMappingId === b.id)).map((b) => {
            const rows = mappings.filter((m) => m.boqMappingId === b.id && (!branch || m.wbsPath.includes(branch) || m.newActivityNeeded));
            const sug = suggestions.find((s) => s.boqMappingId === b.id);
            const accepted = rows.some((r) => r.activityId && r.accepted);
            const badge = sug ? 'New activity needed' : accepted ? 'Mapped' : 'Unmapped';
            if (branch && rows.length === 0) return null;
            const results = searchFor === b.id && q.length >= 2 ? model.activities.filter((a) => `${a.id} ${a.name}`.toLowerCase().includes(q.toLowerCase())).slice(0, 4) : [];
            const alt = rows.length === 0 ? candidatesFor(b, model, filters, 2) : [];
            return (
              <section key={b.id} className="overflow-hidden rounded-lg border border-border bg-card" aria-label={b.description}>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                  <h2 className="font-semibold text-foreground"><span className="font-data">{b.boqRef}</span> {b.description} <span className="font-normal text-muted-foreground">{b.quantity.toLocaleString('en-US')} {b.unit}</span></h2>
                  <span className={`rounded-full px-2.5 py-0.5 text-sm font-medium ${badge === 'Mapped' ? 'bg-success/10 text-success' : badge === 'Unmapped' ? 'bg-destructive/10 text-destructive' : 'bg-warning/20 text-foreground'}`}>{badge}</span>
                </div>
                <ul className="divide-y divide-border">
                  {rows.filter((r) => r.activityId).map((r) => (
                    <li key={r.id} className={`p-4 ${r.accepted ? 'bg-accent/5' : ''}`}>
                      <div className="flex items-start gap-3">
                        <input type="checkbox" aria-label={`Accept ${r.activityId}`} checked={r.accepted} onChange={(e) => toggle(r.id, e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--primary)]" />
                        <button type="button" onClick={() => setSelected(r.activityId as string)} className="min-w-0 flex-1 text-left">
                          <span className="flex items-start justify-between gap-3"><span className="font-semibold text-foreground"><span className="font-data">{r.activityId}</span> {r.candidate?.name}</span><ConfidenceBar value={r.confidence} /></span>
                          <span className="mt-0.5 block text-sm text-muted-foreground">{r.baselineStart} to {r.baselineFinish} · <span className="font-data">{r.durationDays} d</span> · {r.isCritical ? <span className="font-medium text-destructive">Float 0 d, critical</span> : <>Float <span className="font-data">{r.totalFloat} d</span></>}</span>
                          <span className="mt-1.5 flex flex-wrap items-center gap-2"><span className={`rounded-full px-2.5 py-0.5 text-sm font-medium ${r.progressStatus === 'completed' ? 'bg-success/10 text-success' : r.progressStatus === 'in_progress' ? 'bg-warning/20 text-foreground' : 'bg-muted text-muted-foreground'}`}>{PROGRESS_LABEL[r.progressStatus]}{r.candidate && r.progressStatus === 'in_progress' ? ` ${r.candidate.progressPct}%` : ''}</span></span>
                          <span className="mt-1 block text-foreground">{r.reason}</span>
                        </button>
                      </div>
                      {rows.filter((x) => x.activityId).length > 1 ? (
                        <label className="ml-7 mt-2 flex items-center gap-2 text-sm text-muted-foreground">Share of quantity<input type="number" min={0} max={100} value={Math.round(r.quantityShare)} onChange={(e) => setShare(r.id, Number(e.target.value))} className="w-20 rounded-md border border-input bg-background px-2 py-1 font-data" />%</label>
                      ) : null}
                    </li>
                  ))}
                  {alt.length > 0 && !sug ? alt.map((c) => (
                    <li key={c.activityId} className="flex items-start justify-between gap-3 p-4">
                      <div><p className="font-semibold text-foreground"><span className="font-data">{c.activityId}</span> {c.name}</p><p className="text-sm text-muted-foreground">{c.reason}</p></div>
                      <button type="button" onClick={() => addActivity(b.id, c.activityId)} className="rounded-md border border-input px-3 py-1.5 font-medium hover:bg-muted">Accept</button>
                    </li>
                  )) : null}
                </ul>
                {sug ? (
                  <div className="border-t-2 border-warning bg-warning/5 p-4">
                    <p className="text-foreground"><span className="font-semibold">Suggested new activity:</span> {sug.name}</p>
                    <p className="text-muted-foreground">Suggested logic: after {sug.predecessor}, before {sug.successor}. Duration is set in the schedule stage.</p>
                    {editSug === b.id ? (
                      <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); onChange(mappings, suggestions.map((s) => (s.boqMappingId === b.id ? { ...s, name: sugName } : s))); setEditSug(null); onEdited('activity'); }}>
                        <input value={sugName} onChange={(e) => setSugName(e.target.value)} className="flex-1 rounded-md border border-input bg-card px-3 py-1.5" aria-label="Activity name" />
                        <button type="submit" className="rounded-md bg-primary px-3 py-1.5 font-semibold text-primary-foreground">Save</button>
                      </form>
                    ) : (
                      <div className="mt-3 flex gap-2">
                        <button type="button" disabled={sug.accepted} onClick={() => { onChange(mappings, suggestions.map((s) => (s.boqMappingId === b.id ? { ...s, accepted: true } : s))); onEdited('activity'); }} className="rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground hover:opacity-90 disabled:bg-success disabled:opacity-100">{sug.accepted ? 'Accepted' : 'Accept suggestion'}</button>
                        <button type="button" onClick={() => { setEditSug(b.id); setSugName(sug.name); }} className="rounded-md border border-input bg-card px-4 py-2 font-semibold hover:bg-muted">Edit</button>
                      </div>
                    )}
                  </div>
                ) : null}
                <div className="border-t border-border px-4 py-2.5">
                  <DemoLineActions lineId={b.id} label={b.boqRef} decision={decisions[b.id]} unit={b.unit} currency="AED" onDecide={decide} show={{ retry: () => { onRun(); }, newActivity: () => markNew(b.id), defer: true, excludeSchedule: true, excludeScenario: true, excludeCost: true }} />
                  {searchFor === b.id ? (
                    <div>
                      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search activities" placeholder="Search by activity ID or name" className="w-full rounded-md border border-input bg-background px-3 py-1.5" />
                      {results.length > 0 ? <ul className="mt-2 divide-y divide-border rounded-md border border-border">{results.map((a) => <li key={a.id} className="flex items-center justify-between px-3 py-1.5"><span><span className="font-data font-semibold">{a.id}</span> {a.name}</span><button type="button" onClick={() => addActivity(b.id, a.id)} className="rounded-md border border-input px-2.5 py-1 font-medium hover:bg-muted">Add</button></li>)}</ul> : q.length >= 2 ? <p className="mt-2 text-muted-foreground">No activity matches. Try the activity ID.</p> : null}
                    </div>
                  ) : (
                    <div className="flex gap-3">
                      <button type="button" onClick={() => setSearchFor(b.id)} className="font-medium text-accent hover:underline">Add activity</button>
                      {!sug ? <button type="button" onClick={() => markNew(b.id)} className="font-medium text-accent hover:underline">Mark new activity needed</button> : null}
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>

        <aside aria-label="Activity logic" className="h-fit rounded-lg border border-border bg-card p-4">
          <h2 className="font-semibold text-foreground">Logic of <span className="font-data">{selectedAct?.id ?? '—'}</span></h2>
          {selectedAct ? (
            <>
              <p className="mt-1 text-sm text-muted-foreground">{selectedAct.name}</p>
              <div className="mt-3 space-y-2" aria-label="Network">
                {nb.preds.map((p) => <div key={p.rel.from} className="rounded-md border border-border px-3 py-1.5 text-sm"><span className="font-data font-semibold">{p.rel.from}</span> {p.activity?.name}<span className="block text-muted-foreground">{p.rel.type}, lag {p.rel.lag} d</span></div>)}
                <div className="rounded-md border-2 border-accent bg-accent/10 px-3 py-1.5 text-sm font-semibold"><span className="font-data">{selectedAct.id}</span> {selectedAct.name}</div>
                {nb.succs.map((s) => <div key={s.rel.to} className={`rounded-md border px-3 py-1.5 text-sm ${s.activity?.totalFloat === 0 ? 'border-destructive/40 text-destructive' : 'border-border'}`}><span className="font-data font-semibold">{s.rel.to}</span> {s.activity?.name}<span className="block text-muted-foreground">{s.rel.type}, lag {s.rel.lag} d</span></div>)}
                {nb.preds.length + nb.succs.length === 0 ? <p className="text-muted-foreground">No links recorded in the baseline.</p> : null}
              </div>
            </>
          ) : <p className="mt-2 text-muted-foreground">Select an activity to see its predecessors and successors.</p>}
        </aside>
      </div>
    </div>
  );
}

export { DEFAULT_FILTERS };

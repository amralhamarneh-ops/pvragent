'use client';

import React, { useState } from 'react';
import { ChevronDown, GripVertical } from 'lucide-react';
import { ROLE_LABEL, ROLE_ORDER, type ClassifiedFile, type FileRole, type TriageResult } from '@/lib/intake/triage';
import { projects } from '@/lib/mockData';
import { BOQ_BILLS } from '@/lib/mapping/boqEngine';

export interface ProjectChoice {
  mode: 'linked' | 'new';
  name: string;
  contractRef: string;
}

interface TriageStepProps {
  result: TriageResult;
  files: ClassifiedFile[];
  onMove: (path: string, role: FileRole) => void;
  baseline: string;
  onBaseline: (path: string) => void;
  project: ProjectChoice | null;
  onProject: (p: ProjectChoice) => void;
  separateCases: boolean;
  onSeparate: (v: boolean) => void;
}

const pill = 'inline-flex items-center rounded-full px-2.5 py-1 text-sm font-medium';

export default function TriageStep({ result, files, onMove, baseline, onBaseline, project, onProject, separateCases, onSeparate }: TriageStepProps) {
  const [choosing, setChoosing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState(result.projectMatch.name);
  const [newRef, setNewRef] = useState(result.projectMatch.contractRef);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [openRole, setOpenRole] = useState<FileRole | null>(null);
  const match = result.projectMatch;

  const byRole = (role: FileRole) => files.filter((f) => f.role === role);
  const boqFiles = byRole('boq');
  const xers = byRole('schedule');
  const needsBaseline = xers.length > 1 && !baseline;

  return (
    <div className="space-y-5">
      <section className={`rounded-lg border-2 bg-card p-6 ${project ? 'border-success' : 'border-primary'}`} aria-label="Project match">
        {project ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-foreground">{project.mode === 'linked' ? `Linked to ${project.name}` : `New project: ${project.name}`}</h2>
              <p className="mt-1 text-muted-foreground">Contract reference {project.contractRef}. This case will sit in that project&apos;s PVR register.</p>
            </div>
            <button type="button" onClick={() => onProject(null as unknown as ProjectChoice)} className="rounded-md border border-input px-3 py-2 font-medium hover:bg-muted">Change</button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h2 className="text-xl font-semibold text-foreground">{match.level === 'No match' ? 'No project match found' : `This looks like ${match.name}`}</h2>
              <span className={`${pill} ${match.level === 'No match' ? 'bg-muted text-muted-foreground' : match.level === 'Possible match' ? 'bg-warning/15 text-warning' : 'bg-success/10 text-success'}`}>{match.level}</span>
            </div>
            <p className="mt-2 text-muted-foreground">{match.evidence}</p>
            <div className="mt-4 flex flex-wrap gap-3">
              {match.level !== 'No match' ? (
                <button type="button" onClick={() => onProject({ mode: 'linked', name: match.name, contractRef: match.contractRef })} className="rounded-md bg-primary px-4 py-2.5 font-semibold text-primary-foreground hover:opacity-90">Link to {match.name}</button>
              ) : null}
              <button type="button" onClick={() => { setChoosing((v) => !v); setCreating(false); }} className="rounded-md border border-input bg-card px-4 py-2.5 font-semibold hover:bg-muted">Choose another project</button>
              <button type="button" onClick={() => { setCreating((v) => !v); setChoosing(false); }} className="rounded-md border border-input bg-card px-4 py-2.5 font-semibold hover:bg-muted">Create new project</button>
            </div>
            {choosing ? (
              <ul className="mt-4 divide-y divide-border rounded-md border border-border">
                {projects.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => onProject({ mode: 'linked', name: p.name, contractRef: p.id.toUpperCase() })} className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted">
                      <span className="font-medium text-foreground">{p.name}</span>
                      <span className="text-muted-foreground">{p.zone}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {creating ? (
              <form
                className="mt-4 grid gap-3 rounded-md border border-border bg-background p-4 sm:grid-cols-2"
                onSubmit={(e) => { e.preventDefault(); if (newName.trim()) onProject({ mode: 'new', name: newName.trim(), contractRef: newRef.trim() || 'Not stated' }); }}
              >
                <label className="block"><span className="font-medium">Project name</span>
                  <input value={newName} onChange={(e) => setNewName(e.target.value)} className="mt-1 w-full rounded-md border border-input bg-card px-3 py-2 focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30" required />
                </label>
                <label className="block"><span className="font-medium">Contract reference</span>
                  <input value={newRef} onChange={(e) => setNewRef(e.target.value)} className="mt-1 w-full rounded-md border border-input bg-card px-3 py-2 font-data focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30" />
                </label>
                <p className="text-sm text-muted-foreground sm:col-span-2">Prefilled from the contract cover page and BoQ title. Edit anything that looks wrong.</p>
                <div className="sm:col-span-2"><button type="submit" className="rounded-md bg-primary px-4 py-2.5 font-semibold text-primary-foreground hover:opacity-90">Create project and link</button></div>
              </form>
            ) : null}
          </>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-5" aria-label="PVR detection">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-foreground">{result.pvrs.length} PVR{result.pvrs.length === 1 ? '' : 's'} found</h2>
          <span className={`${pill} bg-accent/10 text-accent`}>{result.pvrs.length > 1 && separateCases ? `${result.pvrs.length} cases will be created` : '1 case will be created'}</span>
        </div>
        <ul className="mt-2 space-y-1">
          {result.pvrs.map((p) => (
            <li key={p.path} className="text-muted-foreground"><span className="font-data font-medium text-foreground">{p.ref}</span>: {p.title}</li>
          ))}
        </ul>
        {result.pvrs.length > 1 ? (
          <label className="mt-3 flex items-center gap-2 font-medium text-foreground">
            <input type="checkbox" checked={separateCases} onChange={(e) => onSeparate(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
            Create separate cases, each with its own evidence pack and run history
          </label>
        ) : (
          <p className="mt-2 text-muted-foreground">If a folder holds several PVRs, each becomes a separate case with its own evidence pack.</p>
        )}
      </section>

      <h2 className="pt-2 text-xl font-semibold text-foreground">Files by role</h2>
      <p className="-mt-3 text-muted-foreground">Drag a file into another group if we got it wrong.</p>

      <div className="space-y-3">
        {ROLE_ORDER.map((role) => {
          const list = byRole(role);
          if (list.length === 0) return null;
          const isBoq = role === 'boq';
          const isSched = role === 'schedule';
          const expanded = openRole === role || isBoq || (isSched && xers.length > 1);
          const status = isSched && xers.length > 1 ? (baseline ? 'Ready' : 'Needs your choice') : role === 'unused' ? 'Review' : role === 'drawings' && result.drawingRevisions.length > 1 ? `Compare Rev ${result.drawingRevisions[0]} to Rev ${result.drawingRevisions[result.drawingRevisions.length - 1]}` : 'Ready';
          const warn = status === 'Needs your choice';
          return (
            <section
              key={role}
              aria-label={ROLE_LABEL[role]}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (dragPath) onMove(dragPath, role); setDragPath(null); }}
              className={`overflow-hidden rounded-lg border bg-card ${warn ? 'border-warning bg-warning/5 border-2' : 'border-border'}`}
            >
              <button type="button" onClick={() => setOpenRole(openRole === role ? null : role)} className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left" aria-expanded={expanded}>
                <span className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-semibold text-foreground">{isBoq ? 'BoQ set' : ROLE_LABEL[role]}</span>
                  <span className="text-muted-foreground">
                    {isBoq ? `${list.length} bill workbooks, treated as one BoQ` : role === 'drawings' ? `${list.length} files, Rev ${result.drawingRevisions.join(' and Rev ')} of R4-CIV-101` : `${list.length} file${list.length === 1 ? '' : 's'}${role === 'unused' ? ', ' + (list[0]?.reason ?? '').toLowerCase() : ''}`}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  {isBoq ? <span className={`${pill} bg-automated/10 text-automated`}>{result.billsRelevant.length} bills look relevant</span> : <span className={`${pill} ${warn ? 'bg-warning/20 text-foreground' : role === 'unused' ? 'bg-muted text-muted-foreground' : 'bg-success/10 text-success'}`}>{status}</span>}
                  <ChevronDown size={16} className={`text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
                </span>
              </button>

              {isBoq ? (
                <div className="flex flex-wrap gap-2 border-t border-border px-5 py-3">
                  {BOQ_BILLS.filter((b) => boqFiles.some((f) => f.name.includes(`Bill ${b.number} `))).map((b) => (
                    <span key={b.number} className={`${pill} border ${result.billsRelevant.includes(b.number) ? 'border-accent/30 bg-accent/10 text-foreground' : 'border-border bg-card text-muted-foreground'}`}>
                      Bill {b.number} {b.title}
                    </span>
                  ))}
                </div>
              ) : null}

              {isSched && xers.length > 1 ? (
                <fieldset className="border-t border-border px-5 py-4">
                  <legend className="mb-2 font-semibold text-foreground">Which file is the baseline for this PVR?</legend>
                  <div className="space-y-2">
                    {xers.map((x) => (
                      <label key={x.path} className={`flex cursor-pointer items-start gap-3 rounded-md border px-4 py-3 ${baseline === x.path ? 'border-accent bg-accent/5' : 'border-border bg-card'}`}>
                        <input type="radio" name="baseline" checked={baseline === x.path} onChange={() => onBaseline(x.path)} className="mt-1 h-4 w-4 accent-[var(--accent)]" />
                        <span>
                          <span className="block font-medium text-foreground">{x.name}</span>
                          <span className="block text-sm text-muted-foreground">{'Schedule file detected by its .xer extension. Its contents have not been read or validated yet.'}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}

              {expanded && !isBoq ? (
                <ul className="divide-y divide-border border-t border-border">
                  {list.map((f) => (
                    <li key={f.path} draggable onDragStart={() => setDragPath(f.path)} className="flex cursor-grab items-center gap-3 px-5 py-2.5 active:cursor-grabbing">
                      <GripVertical size={14} className="shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-foreground">{f.name}</span>
                      <span className="hidden text-sm text-muted-foreground sm:inline">{f.reason}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          );
        })}
      </div>

      {needsBaseline ? <p className="text-muted-foreground" role="status">Choose the baseline schedule to continue.</p> : null}
    </div>
  );
}

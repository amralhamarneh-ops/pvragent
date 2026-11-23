'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Download, FileWarning, Link2, MoreVertical, Replace, Tag, Trash2 } from 'lucide-react';
import { CATEGORY_OPTIONS, DRAWING_SUBROLES, PROGRAMME_SUBROLES, categoryKeyOf } from '@/lib/docs/categories';

/** One row of the shared document registry, as the UI needs it. Both lists render from the same rows. */
export interface ManagedDoc {
  id: string;
  path: string;
  name: string;
  role: string;
  subrole: string;
  metadata: Record<string, string>;
  roleManual: boolean;
  hasBytes: boolean;
  stateLabel: string;
  stateDetail: string;
  stateTone: string;
  version: number;
  size: number;
  sha256: string;
  categoryLabel: string;
  subroleLabel: string;
}

export interface DocActions {
  onView: (id: string) => void;
  onReplace: (id: string) => void;
  onRemove: (id: string) => void;
  onReclassify: (ids: string[], categoryKey: string, subrole: string, metadata: Record<string, string>) => void;
  onReconnect: (path: string) => void;
}

/** Category + sub-role + drawing metadata editor. Choosing a category never claims the file was parsed. */
export function CategoryEditor({ docs, onApply, onCancel }: { docs: ManagedDoc[]; onApply: (categoryKey: string, subrole: string, metadata: Record<string, string>) => void; onCancel: () => void }) {
  const single = docs.length === 1 ? docs[0] : null;
  const [cat, setCat] = useState(single ? categoryKeyOf(single.role, single.metadata) : 'other');
  const role = CATEGORY_OPTIONS.find((c) => c.key === cat)?.role ?? 'unused';
  const [subrole, setSubrole] = useState(single?.subrole ?? '');
  const [drawingNo, setDrawingNo] = useState(single?.metadata.drawingNumber ?? '');
  const [revision, setRevision] = useState(single?.metadata.revision ?? '');
  const subs = role === 'drawings' ? DRAWING_SUBROLES : role === 'schedule' ? PROGRAMME_SUBROLES : [];
  useEffect(() => { if (subs.length && !subs.some((s) => s.key === subrole)) setSubrole(role === 'drawings' ? 'unassigned' : 'reference'); if (!subs.length) setSubrole(''); }, [role]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div role="dialog" aria-label="Change category" className="mt-2 rounded-md border border-border bg-card p-3 shadow-sm">
      <p className="text-sm font-medium text-foreground">{single ? `Category for ${single.name}` : `Category for ${docs.length} documents`}</p>
      <label className="mt-2 block text-xs text-muted-foreground" htmlFor="cat-select">Category</label>
      <select id="cat-select" value={cat} onChange={(e) => setCat(e.target.value)} className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm">
        {CATEGORY_OPTIONS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
      </select>
      {subs.length > 0 ? (
        <>
          <label className="mt-2 block text-xs text-muted-foreground" htmlFor="sub-select">{role === 'drawings' ? 'Drawing set' : 'Programme use'}</label>
          <select id="sub-select" value={subrole} onChange={(e) => setSubrole(e.target.value)} className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm">
            {subs.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </>
      ) : null}
      {role === 'drawings' && single ? (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="text-xs text-muted-foreground">Drawing number<input value={drawingNo} onChange={(e) => setDrawingNo(e.target.value)} className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground" /></label>
          <label className="text-xs text-muted-foreground">Revision<input value={revision} onChange={(e) => setRevision(e.target.value)} className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground" /></label>
        </div>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">Changing the category sets how the file is processed next time. It is not read under the new category until you analyse again.</p>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-md border border-input bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted">Cancel</button>
        <button type="button" onClick={() => onApply(cat, subrole, { categoryKey: cat, ...(role === 'drawings' && single ? { drawingNumber: drawingNo.trim(), revision: revision.trim() } : {}) })} className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90">Apply</button>
      </div>
    </div>
  );
}

/** Compact per-document action menu: View/download, Change category, Replace file, Remove from this PVR. */
export function DocActionMenu({ doc, actions, onChangeCategory }: { doc: ManagedDoc; actions: DocActions; onChangeCategory: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const item = 'flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-muted';
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`Actions for ${doc.name}`} onClick={() => setOpen((v) => !v)} className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"><MoreVertical size={16} aria-hidden /></button>
      {open ? (
        <div role="menu" className="absolute right-0 z-20 mt-1 w-52 overflow-hidden rounded-md border border-border bg-card shadow-lg">
          <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); actions.onView(doc.id); }}><Download size={14} aria-hidden />View / download</button>
          <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); onChangeCategory(doc.id); }}><Tag size={14} aria-hidden />Change category</button>
          <button type="button" role="menuitem" className={item} onClick={() => { setOpen(false); actions.onReplace(doc.id); }}><Replace size={14} aria-hidden />Replace file</button>
          <button type="button" role="menuitem" className={`${item} text-destructive`} onClick={() => { setOpen(false); actions.onRemove(doc.id); }}><Trash2 size={14} aria-hidden />Remove from this PVR</button>
        </div>
      ) : null}
    </div>
  );
}

interface DocumentManagerProps {
  docs: ManagedDoc[];
  actions: DocActions;
  storageNote: string;
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  onRemoveSelected: () => void;
  busy: boolean;
}

/** "Documents in this case": the full registry with checkboxes, per-row actions and bulk actions. */
export default function DocumentManager({ docs, actions, storageNote, selected, onSelectedChange, onRemoveSelected, busy }: DocumentManagerProps) {
  const [editing, setEditing] = useState<string[] | null>(null);
  if (docs.length === 0) return null;
  const rows = [...docs].sort((a, b) => a.path.localeCompare(b.path));
  const allChecked = rows.length > 0 && rows.every((d) => selected.has(d.id));
  const chosen = rows.filter((d) => selected.has(d.id));
  const toggle = (id: string) => { const n = new Set(selected); if (n.has(id)) n.delete(id); else n.add(id); onSelectedChange(n); };
  const editingDocs = editing ? rows.filter((d) => editing.includes(d.id)) : [];
  return (
    <section className="mt-3 rounded-md border border-border bg-card p-3" aria-label="Documents in this case">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">Documents in this case ({rows.length})</h3>
        <p className="text-xs text-muted-foreground">{storageNote}</p>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 border-b border-border pb-2">
        <label className="inline-flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={allChecked} onChange={() => onSelectedChange(allChecked ? new Set() : new Set(rows.map((d) => d.id)))} className="h-4 w-4 accent-[var(--accent)]" aria-label="Select all documents" />
          Select all
        </label>
        <span className="text-sm text-muted-foreground" aria-live="polite">{chosen.length} selected</span>
        <button type="button" disabled={chosen.length === 0 || busy} onClick={() => setEditing(chosen.map((d) => d.id))} className="inline-flex items-center gap-1 rounded-md border border-input bg-card px-2.5 py-1 text-sm font-medium hover:bg-muted disabled:opacity-50"><Tag size={14} aria-hidden />Change category</button>
        <button type="button" disabled={chosen.length === 0 || busy} onClick={onRemoveSelected} className="inline-flex items-center gap-1 rounded-md border border-input bg-card px-2.5 py-1 text-sm font-medium text-destructive hover:bg-muted disabled:opacity-50"><Trash2 size={14} aria-hidden />Remove selected</button>
      </div>
      {editing && editingDocs.length > 0 ? (
        <CategoryEditor docs={editingDocs} onCancel={() => setEditing(null)} onApply={(c, s, m) => { actions.onReclassify(editingDocs.map((d) => d.id), c, s, m); setEditing(null); }} />
      ) : null}
      <ul className="mt-1 max-h-72 divide-y divide-border overflow-auto text-sm">
        {rows.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-2 py-1.5">
            <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} aria-label={`Select ${d.name}`} className="h-4 w-4 accent-[var(--accent)]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-foreground" title={d.path}>{d.path}</span>
              <span className="block font-data text-xs text-muted-foreground">{d.categoryLabel}{d.subroleLabel ? ` · ${d.subroleLabel}` : ''}{d.metadata.drawingNumber ? ` · ${d.metadata.drawingNumber}${d.metadata.revision ? ` rev ${d.metadata.revision}` : ''}` : ''} · v{d.version} · {(d.size / 1024).toFixed(1)} KB{d.roleManual ? ' · set by you' : ''}</span>
            </span>
            {!d.hasBytes ? (
              <>
                <span className="inline-flex items-center gap-1 rounded bg-warning/20 px-2 py-0.5 text-xs font-medium text-foreground"><FileWarning size={12} aria-hidden />Contents not available</span>
                <button type="button" onClick={() => actions.onReconnect(d.path)} className="inline-flex items-center gap-1 rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted"><Link2 size={12} aria-hidden />Reconnect this file</button>
              </>
            ) : (
              <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${d.stateTone}`} title={d.stateDetail}>{d.stateLabel}</span>
            )}
            <DocActionMenu doc={d} actions={actions} onChangeCategory={(id) => setEditing([id])} />
          </li>
        ))}
      </ul>
    </section>
  );
}

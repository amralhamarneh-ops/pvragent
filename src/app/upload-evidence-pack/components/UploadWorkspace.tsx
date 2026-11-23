'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { UploadCloud, FileText, FileSpreadsheet, FileImage, FileCode, Mail, Fingerprint, Trash2, CheckCircle2, Loader2, ArrowRight, Lock } from 'lucide-react';
import { toast } from 'sonner';
import AppToaster from '@/lib/toaster';
import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/AppIcon';


interface PackFile {
  id: string;
  name: string;
  size: string;
  kind: string;
  hash: string;
  progress: number;
  note: string;
}

const seeded: PackFile[] = [
  { id: 'file-pvr', name: 'PVR-0418.pdf', size: '1.2 MB', kind: 'PVR', hash: '9f2c7a…a41e', progress: 100, note: 'Text layer extracted, 3 pages' },
  { id: 'file-dxf-b', name: 'R4-CIV-101_RevB.dxf', size: '38.4 MB', kind: 'Drawing', hash: '41be0d…77c2', progress: 100, note: 'Units: metres · 14 layers' },
  { id: 'file-dxf-c', name: 'R4-CIV-101_RevC.dxf', size: '41.1 MB', kind: 'Drawing', hash: 'c8d315…02ab', progress: 100, note: 'Units: metres · 16 layers' },
  { id: 'file-boq', name: 'FahidRoads_BoQ_Rev4.xlsx', size: '212.6 MB', kind: 'BoQ', hash: '70a9f4…de10', progress: 64, note: 'Streaming chunk 41 of 64' },
  { id: 'file-xer', name: 'FIR_Baseline_Oct26.xer', size: '9.8 MB', kind: 'Schedule', hash: 'ee6120…5b9d', progress: 100, note: '312 activities · dates reproduce' },
  { id: 'file-eml', name: 'Employer instruction 2026-10-20.eml', size: '86 KB', kind: 'Correspondence', hash: '2a77c1…f003', progress: 100, note: 'Event date found: 20 Oct 2026' },
];

const formats = [
  { id: 'fmt-pdf', label: 'PDF · DOCX', icon: FileText },
  { id: 'fmt-xlsx', label: 'XLSX', icon: FileSpreadsheet },
  { id: 'fmt-cad', label: 'DWG · DXF · IFC', icon: FileImage },
  { id: 'fmt-xer', label: 'XER · MPP', icon: FileCode },
  { id: 'fmt-mail', label: 'EML · MSG', icon: Mail },
];

function iconFor(kind: string) {
  if (kind === 'BoQ') return FileSpreadsheet;
  if (kind === 'Drawing') return FileImage;
  if (kind === 'Schedule') return FileCode;
  if (kind === 'Correspondence') return Mail;
  return FileText;
}

export default function UploadWorkspace() {
  const [files, setFiles] = useState<PackFile[]>(seeded);
  const [dragging, setDragging] = useState(false);

  const addDropped = (list: FileList | null) => {
    if (!list) return;
    const next: PackFile[] = Array.from(list).map((f, i) => ({
      id: `file-new-${f.name}-${i + 1}`,
      name: f.name,
      size: `${(f.size / 1024 / 1024).toFixed(1)} MB`,
      kind: 'Unclassified',
      hash: 'pending…',
      progress: 12,
      note: 'Hashing in progress',
    }));
    setFiles((cur) => [...cur, ...next]);
    toast.success(`${next.length} file${next.length > 1 ? 's' : ''} added to the evidence pack`);
  };

  const remove = (id: string) => setFiles((cur) => cur.filter((f) => f.id !== id));
  const allDone = files.length > 0 && files.every((f) => f.progress === 100);

  return (
    <div className="space-y-6">
      <AppToaster />
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">New case · Step 1 of 3</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">Assemble the evidence pack</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Every file is hashed and versioned from the start. Uploaded content is treated as data, never as instructions to the agents.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              addDropped(e.dataTransfer.files);
            }}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-12 text-center transition-colors duration-150 ${
              dragging ? 'border-accent bg-accent/10' : 'border-input bg-card hover:border-accent'
            }`}
          >
            <UploadCloud size={32} className="text-accent" />
            <p className="mt-3 text-base font-semibold text-foreground">Drop the PVR pack here</p>
            <p className="mt-1 text-sm text-muted-foreground">or click to browse. Large BoQ and drawing sets above 200 MB are streamed in chunks.</p>
            <input type="file" multiple className="sr-only" onChange={(e) => addDropped(e.target.files)} />
          </label>

          <div className="rounded-lg border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <p className="text-sm font-semibold text-foreground">Evidence pack · {files.length} files</p>
              <Badge tone="automated">
                <Fingerprint size={12} /> SHA-256
              </Badge>
            </div>
            {files.length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-muted-foreground">No files yet. Drop a PVR document to start the pack.</p>
            ) : (
              <ul>
                {files.map((f) => {
                  const Icon = iconFor(f.kind);
                  const done = f.progress === 100;
                  return (
                    <li key={f.id} className="flex items-center gap-4 border-b border-border px-5 py-3.5 last:border-b-0 hover:bg-muted/50">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-accent">
                        <Icon size={18} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-semibold text-foreground">{f.name}</p>
                          <Badge tone={f.kind === 'Unclassified' ? 'neutral' : 'info'}>{f.kind}</Badge>
                        </div>
                        <p className="font-data mt-0.5 text-xs text-muted-foreground">
                          {f.size} · sha256 {f.hash} · {f.note}
                        </p>
                        {!done ? (
                          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${f.progress}%` }} />
                          </div>
                        ) : null}
                      </div>
                      {done ? <CheckCircle2 size={18} className="shrink-0 text-success" /> : <Loader2 size={18} className="shrink-0 animate-spin text-accent" />}
                      <button
                        type="button"
                        onClick={() => remove(f.id)}
                        aria-label={`Remove ${f.name}`}
                        title="Remove from the pack. This is logged in the audit trail."
                        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 size={15} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border bg-card px-5 py-4">
            <p className="text-sm text-muted-foreground">
              {allDone ? 'All files are hashed and parsed. The Intake agent is ready.' : '1 file is still being processed. You can continue once it finishes.'}
            </p>
            <Link
              href="/intake-confirmation"
              aria-disabled={!allDone}
              className={`inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-semibold transition-all duration-150 active:scale-95 ${
                allDone ? 'bg-primary text-primary-foreground hover:opacity-90' : 'pointer-events-none bg-muted text-muted-foreground'
              }`}
            >
              Run intake agent
              <ArrowRight size={15} />
            </Link>
          </div>
        </div>

        <aside className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-5">
            <p className="text-sm font-semibold text-foreground">Supported formats</p>
            <ul className="mt-3 grid grid-cols-1 gap-2">
              {formats.map((f) => (
                <li key={f.id} className="flex items-center gap-3 rounded-md bg-background px-3 py-2 text-sm text-foreground">
                  <f.icon size={16} className="text-accent" />
                  {f.label}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-lg border border-border bg-card p-5">
            <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Lock size={15} className="text-automated" />
              Handling of uploads
            </p>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li>Encrypted in transit and at rest.</li>
              <li>Names and signatures are minimised under UAE PDPL; retention is set per project.</li>
              <li>Scanned PDFs fall back to vision reading and are marked with lower confidence.</li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
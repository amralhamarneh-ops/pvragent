'use client';

import React, { useCallback, useRef, useState } from 'react';
import { FolderOpen, Upload } from 'lucide-react';
import type { IncomingFile } from '@/lib/intake/triage';
import { documentSizeNotice, MAX_DOC_BYTES, MAX_EXPANDED_ZIP_BYTES, MAX_ZIP_BYTES, MAX_ZIP_ENTRIES, readBoundedZipEntry } from '@/lib/intake/uploadLimits';

interface DocumentsStepProps {
  onAdd: (files: IncomingFile[]) => void;
  /** Receives the real File objects (keyed by the same path used in IncomingFile) for EVERY accepted file, including ZIP entries. */
  onFiles?: (files: Map<string, File>) => void | Promise<void>;
  onReadingChange?: (reading: boolean) => void;
}

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?: (cb: (f: File) => void, err?: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (cb: (e: FsEntry[]) => void, err?: (e: unknown) => void) => void };
}

async function readEntry(entry: FsEntry, out: IncomingFile[], real: Map<string, File>, skipped: string[]): Promise<void> {
  if (entry.isFile && entry.file) {
    const f = await new Promise<File>((res, rej) => entry.file!(res, rej));
    const path = entry.fullPath.replace(/^\//, '');
    if (f.size > MAX_DOC_BYTES) { skipped.push(documentSizeNotice(path, f.size)); return; }
    real.set(path, f);
    out.push(await toIncoming(f, path));
  } else if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    let batch: FsEntry[] = [];
    do {
      batch = await new Promise<FsEntry[]>((res, rej) => reader.readEntries(res, rej));
      for (const child of batch) await readEntry(child, out, real, skipped);
    } while (batch.length > 0);
  }
}

/** Read only the start of text-like files for classification, never the whole file. */
async function toIncoming(file: File, path: string): Promise<IncomingFile> {
  let snippet: string | undefined;
  if (file.size < 5_000_000 && /\.(txt|eml|csv)$/i.test(file.name)) {
    snippet = (await file.slice(0, 400).text()).replace(/[^\x20-\x7E\n]/g, ' ');
  }
  return { path, size: file.size, snippet };
}

/** webkitdirectory is a non-standard attribute that React's types omit. Typed here once, with no suppression comment. */
const FOLDER_ATTRS: React.InputHTMLAttributes<HTMLInputElement> & { webkitdirectory: string } = { webkitdirectory: '' };

/**
 * Expand a ZIP into real File objects. EVERY entry is kept (BOQs, XERs, drawings, PVR documents, everything), not a
 * subset of extensions, so nothing a later stage needs is silently dropped.
 */
export async function expandZip(zipFile: File, out: IncomingFile[], real: Map<string, File>, skipped: string[]): Promise<void> {
  if (zipFile.size > MAX_ZIP_BYTES) {
    skipped.push(`${zipFile.name} exceeds the 100 MiB browser ZIP limit. Extract it on your computer and choose the folder; the 25 MiB per-file limit still applies.`);
    return;
  }
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(zipFile);
  const entries = Object.values(zip.files).filter((z) => !z.dir && !z.name.includes('..') && !z.name.startsWith('/') && !/(^|\/)(__MACOSX|\.DS_Store)/.test(z.name));
  if (entries.length > MAX_ZIP_ENTRIES) {
    skipped.push(`${zipFile.name} contains more than ${MAX_ZIP_ENTRIES} files. Extract it and choose only the files relevant to this PVR.`);
    return;
  }
  let addedBytes = 0;
  for (const z of entries) {
    const remaining = MAX_EXPANDED_ZIP_BYTES - addedBytes;
    const blob = await readBoundedZipEntry(z, Math.min(remaining, MAX_DOC_BYTES));
    if (!blob) {
      if (remaining < MAX_DOC_BYTES) {
        skipped.push(`${zipFile.name}: the remaining entries were not added because the browser ZIP expansion limit was reached. Extract the archive and add the outstanding documents separately.`);
        break;
      }
      skipped.push(documentSizeNotice(z.name));
      continue;
    }
    addedBytes += blob.size;
    const f = new File([blob], z.name.split('/').slice(-1)[0]);
    real.set(z.name, f);
    out.push(await toIncoming(f, z.name));
  }
}

export default function DocumentsStep({ onAdd, onFiles, onReadingChange }: DocumentsStepProps) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [reading, setReading] = useState(false);
  const folderRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const busy = useCallback((v: boolean) => { setReading(v); onReadingChange?.(v); }, [onReadingChange]);

  const finish = useCallback(async (out: IncomingFile[], real: Map<string, File>, skipped: string[]) => {
    // Register the real bytes BEFORE listing the files, so a listed file always has contents behind it.
    await onFiles?.(real);
    onAdd(out);
    setNote(skipped.length ? `Not added: ${skipped.join(' ')}` : '');
  }, [onAdd, onFiles]);

  const addFromInput = useCallback(async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    busy(true);
    setError('');
    try {
      const out: IncomingFile[] = [];
      const real = new Map<string, File>();
      const skipped: string[] = [];
      for (const f of Array.from(list)) {
        const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
        if (/\.zip$/i.test(f.name)) await expandZip(f, out, real, skipped);
        else if (f.size > MAX_DOC_BYTES) skipped.push(documentSizeNotice(rel, f.size));
        else { real.set(rel, f); out.push(await toIncoming(f, rel)); }
      }
      await finish(out, real, skipped);
    } catch {
      setError('We could not read that upload. Try again, or add the files one by one.');
    } finally {
      busy(false);
    }
  }, [busy, finish]);

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    busy(true);
    setError('');
    try {
      const out: IncomingFile[] = [];
      const real = new Map<string, File>();
      const skipped: string[] = [];
      const items = Array.from(e.dataTransfer.items ?? []);
      const entries: FsEntry[] = [];
      for (const item of items) {
        const entry = item.webkitGetAsEntry?.();
        if (entry) entries.push(entry as unknown as FsEntry);
      }
      if (entries.length > 0) {
        for (const en of entries) {
          if (en.isFile && /\.zip$/i.test(en.name) && en.file) {
            const zf = await new Promise<File>((res, rej) => en.file!(res, rej));
            await expandZip(zf, out, real, skipped);
          } else await readEntry(en, out, real, skipped);
        }
      } else {
        for (const f of Array.from(e.dataTransfer.files)) {
          if (/\.zip$/i.test(f.name)) await expandZip(f, out, real, skipped);
          else if (f.size > MAX_DOC_BYTES) skipped.push(documentSizeNotice(f.name, f.size));
          else { real.set(f.name, f); out.push(await toIncoming(f, f.name)); }
        }
      }
      await finish(out, real, skipped);
    } catch {
      setError('We could not read the dropped items. Use "Upload files" or "Choose a folder" instead.');
    } finally {
      busy(false);
    }
  }, [busy, finish]);

  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex flex-wrap items-center justify-between gap-4 rounded-lg border-2 border-dashed px-5 py-4 transition-colors ${dragging ? 'border-accent bg-accent/5' : 'border-input bg-background'}`}
      >
        <div className="flex items-center gap-4">
          <FolderOpen size={32} className="text-primary" aria-hidden />
          <div>
            <p className="font-semibold text-foreground">Upload everything once: drawings, PVR, BOQs, programme (.xer)</p>
            <p className="text-sm text-muted-foreground">Drop files, a folder or a ZIP (up to 100 MiB). Individual files must be 25 MiB or less. BOQ workbooks are read automatically.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => folderRef.current?.click()} disabled={reading} className="rounded-md border border-input bg-card px-3.5 py-2 font-medium text-foreground hover:bg-muted disabled:opacity-60">Choose folder</button>
          <button type="button" onClick={() => fileRef.current?.click()} disabled={reading} className="inline-flex items-center gap-2 rounded-md border border-input bg-card px-3.5 py-2 font-medium text-foreground hover:bg-muted disabled:opacity-60"><Upload size={16} aria-hidden />Upload files</button>
        </div>
        <input ref={folderRef} type="file" className="hidden" multiple {...FOLDER_ATTRS} onChange={(e) => { void addFromInput(e.target.files); e.target.value = ''; }} />
        <input ref={fileRef} type="file" className="hidden" multiple onChange={(e) => { void addFromInput(e.target.files); e.target.value = ''; }} />
      </div>
      {reading ? <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted" role="status" aria-label="Reading files"><div className="skeleton h-full w-full" /></div> : null}
      {note ? <p role="status" className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-4 py-2.5 text-sm text-foreground">{note}</p> : null}
      {error ? <p role="alert" className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-destructive">{error}</p> : null}
    </div>
  );
}

'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, Upload } from 'lucide-react';
import type { IncomingFile } from '@/lib/intake/triage';
import { MAX_DOC_BYTES } from '@/lib/docs/registry';
import type { CadInventory, CadScanReply } from '@/lib/drawings/largeCadIntake';

type LargeDrawing = { file: File; path: string };
type ScanRow = { label: string; loaded: number; total: number; result?: CadInventory; error?: string };
type IntakeBatch = { out: IncomingFile[]; real: Map<string, File>; skipped: string[]; large: LargeDrawing[] };

async function routeFile(file: File, path: string, batch: IntakeBatch) {
  if (file.size > MAX_DOC_BYTES) {
    if (/\.dxf$/i.test(file.name)) batch.large.push({ file, path });
    else batch.skipped.push(`${path} (larger than 25 MB; large-file scanning is currently text DXF only)`);
    return;
  }
  batch.real.set(path, file);
  batch.out.push(await toIncoming(file, path));
}

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

async function readEntry(entry: FsEntry, batch: IntakeBatch): Promise<void> {
  if (entry.isFile && entry.file) {
    const f = await new Promise<File>((res, rej) => entry.file!(res, rej));
    const path = entry.fullPath.replace(/^\//, '');
    await routeFile(f, path, batch);
  } else if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    let children: FsEntry[] = [];
    do {
      children = await new Promise<FsEntry[]>((res, rej) => reader.readEntries(res, rej));
      for (const child of children) await readEntry(child, batch);
    } while (children.length > 0);
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
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(zipFile);
  const entries = Object.values(zip.files).filter((z) => !z.dir && !z.name.includes('..') && !z.name.startsWith('/') && !/(^|\/)(__MACOSX|\.DS_Store)/.test(z.name));
  for (const z of entries) {
    const length = (z as typeof z & {_data?: {uncompressedSize?: number}})._data?.uncompressedSize;
    if (typeof length === 'number' && length > MAX_DOC_BYTES) {
      skipped.push(`${z.name} (extract this file first and select it directly)`);
      continue;
    }
    const blob = await z.async('blob');
    if (blob.size > MAX_DOC_BYTES) { skipped.push(`${z.name} (extract this file first and select it directly)`); continue; }
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
  const [scans, setScans] = useState<ScanRow[]>([]);
  const [scanning, setScanning] = useState(false);
  const activeWorker = useRef<Worker | null>(null);
  const cancelScan = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelScan.current?.(), []);
  const folderRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const busy = useCallback((v: boolean) => { setReading(v); onReadingChange?.(v); }, [onReadingChange]);

  const scanLarge = useCallback(async (large: LargeDrawing[]) => {
    if (!large.length) return;
    let cancelled = false;
    let release: (() => void) | undefined;
    cancelScan.current = () => { cancelled = true; activeWorker.current?.terminate(); release?.(); };
    setScanning(true);
    setScans(large.map(({path,file})=>({label:path,total:file.size,loaded:0})));
    try {
      for (const [index, item] of large.entries()) {
        if (cancelled) break;
        const patch = (v: Partial<ScanRow>) => {
          if (!cancelled) setScans(prev=>prev.map((row,i)=>i===index?{...row,...v}:row));
        };
        await new Promise<void>(resolve=>{
          release = resolve;
          try {
            const worker = new Worker(new URL('../../../lib/drawings/largeCadIntake.worker.ts', import.meta.url));
            activeWorker.current = worker;
            const done = () => { worker.terminate(); resolve(); };
            worker.onmessage = ({data}: MessageEvent<CadScanReply>) => {
              if (data.type==='progress') patch({loaded:data.loaded});
              if (data.type==='error') { patch({error:data.message}); done(); }
              if (data.type==='result') { patch({loaded:data.inventory.bytesRead,result:data.inventory}); done(); }
            };
            worker.onerror = () => { patch({error:'Could not start or finish the browser drawing scan.'}); done(); };
            worker.postMessage(item.file);
          } catch { activeWorker.current?.terminate(); patch({error:'Could not start the browser drawing scan.'}); resolve(); }
        });
        activeWorker.current = null;
      }
    } finally {
      cancelScan.current = null;
      if (!cancelled) setScanning(false);
    }
  }, []);

  const finish = useCallback(async (batch: IntakeBatch) => {
    const {out,real,skipped,large}=batch;
    // Register the real bytes BEFORE listing the files, so a listed file always has contents behind it.
    if (out.length) { await onFiles?.(real); onAdd(out); }
    setNote(skipped.length ? `Not added: ${skipped.join('; ')}.` : '');
    if (large.length) await scanLarge(large);
  }, [onAdd, onFiles, scanLarge]);

  const addFromInput = useCallback(async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    busy(true);
    setError('');
    try {
      const batch: IntakeBatch = { out:[], real:new Map(), skipped:[], large:[] };
      for (const f of Array.from(list)) {
        const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
        if (/\.zip$/i.test(f.name)) await expandZip(f,batch.out,batch.real,batch.skipped);
        else await routeFile(f,rel,batch);
      }
      await finish(batch);
    } catch {
      setError('We could not read that upload. Try again, or add the files one by one.');
    } finally {
      busy(false);
    }
  }, [busy, finish]);

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (reading) return;
    busy(true);
    setError('');
    try {
      const batch: IntakeBatch = { out:[], real:new Map(), skipped:[], large:[] };
      const items = Array.from(e.dataTransfer.items ?? []);
      const entries: FsEntry[] = [];
      for (const item of items) {
        const entry = item.webkitGetAsEntry?.();
        if (entry) entries.push(entry as unknown as FsEntry);
      }
      if (entries.length > 0) {
        for (const en of entries) {
          if (en.isFile && /\.zip$/i.test(en.name) && en.file) {
            const file = await new Promise<File>((res, rej) => en.file!(res, rej));
            await expandZip(file,batch.out,batch.real,batch.skipped);
          } else await readEntry(en, batch);
        }
      } else {
        for (const f of Array.from(e.dataTransfer.files)) {
          if (/\.zip$/i.test(f.name)) await expandZip(f,batch.out,batch.real,batch.skipped);
          else await routeFile(f,f.name,batch);
        }
      }
      await finish(batch);
    } catch {
      setError('We could not read the dropped items. Use "Upload files" or "Choose a folder" instead.');
    } finally {
      busy(false);
    }
  }, [busy, finish, reading]);

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
            <p className="text-sm text-muted-foreground">Drop files, a folder or a ZIP. BOQ workbooks are read automatically; you do not upload them again. Files are kept with the case after you start the assessment.</p>
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
      {scans.length > 0 && <section className="mt-2 space-y-2 rounded border border-border bg-card p-3" aria-label="Large drawing intake">
        <h3 className="font-semibold">Large drawing scan</h3>
        <p className="text-sm text-muted-foreground">The browser scans these original DXFs in chunks without uploading or saving them. This scan only checks what the files contain. It does not compare revisions, measure quantities, or feed the final PVR.</p>
        <ul className="space-y-2 text-sm">{scans.map((row,i)=><li key={i} className="break-words">
          <strong>{row.label}</strong>{' · '}{(row.total/1048576).toFixed(1)} MiB
          {row.result ? <p>Inventory only: {row.result.topLevelRecords.toLocaleString()} entity records, {row.result.blockRecords.toLocaleString()} records in block definitions. Drawing unit code: {row.result.unitCode ?? 'not stated'}.{row.result.externalGeometryFlag?' External or unsupported geometry flagged.':''} Not added to the PVR assessment.</p>
            : row.error ? <p role="alert">{row.error}</p>
            : <p>{scanning?`Scanning or queued · ${Math.floor(row.loaded*100/row.total)}%`:'Scan stopped.'}</p>}
        </li>)}</ul>
        {scanning ? <button type="button" className="rounded border border-input px-2 py-1 text-sm" onClick={()=>{cancelScan.current?.();setScanning(false);}}>Stop large drawing scan</button>
          : <button type="button" className="rounded border border-input px-2 py-1 text-sm" onClick={()=>setScans([])}>Clear scan results</button>}
      </section>}
      {note ? <p role="status" className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-4 py-2.5 text-sm text-foreground">{note}</p> : null}
      {error ? <p role="alert" className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-destructive">{error}</p> : null}
    </div>
  );
}

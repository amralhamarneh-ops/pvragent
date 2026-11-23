'use client';

import React from 'react';
import { AlertTriangle, CheckCircle2, FileWarning, Link2 } from 'lucide-react';
import { DOC_STATE_LABEL } from '@/lib/docs/registry';
import type { DocRecord } from '@/lib/docs/registry';

interface DocStatusPanelProps {
  docs: DocRecord[];
  /** Paths whose bytes are not currently available (metadata-only after a restored draft or failed retrieval). */
  missingBytes: Set<string>;
  onReconnect: (path: string) => void;
  /** Where the files live, in plain words. */
  storageNote: string;
}

const TONE: Record<string, string> = {
  uploaded: 'bg-muted text-muted-foreground',
  stored: 'bg-secondary text-secondary-foreground',
  parsed: 'bg-success/15 text-success',
  needs_clarification: 'bg-warning/20 text-foreground',
  failed: 'bg-destructive/10 text-destructive',
};

export default function DocStatusPanel({ docs, missingBytes, onReconnect, storageNote }: DocStatusPanelProps) {
  if (docs.length === 0 && missingBytes.size === 0) return null;
  const rows = [...docs].sort((a, b) => a.path.localeCompare(b.path));
  const metaOnly = Array.from(missingBytes).filter((p) => !docs.some((d) => d.path === p));
  return (
    <section className="mt-3 rounded-md border border-border bg-card p-3" aria-label="Document status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">Documents in this case ({rows.length + metaOnly.length})</h3>
        <p className="text-xs text-muted-foreground">{storageNote}</p>
      </div>
      <ul className="mt-2 max-h-56 divide-y divide-border overflow-auto text-sm">
        {rows.map((d) => {
          const lost = missingBytes.has(d.path);
          return (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-foreground" title={d.path}>{d.path}</span>
                <span className="block font-data text-xs text-muted-foreground">v{d.version} · SHA-256 {d.sha256.slice(0, 12)}… · {(d.size / 1024).toFixed(1)} KB · {d.role}</span>
              </span>
              <span className="flex items-center gap-2">
                {lost ? (
                  <>
                    <span className="inline-flex items-center gap-1 rounded bg-warning/20 px-2 py-0.5 text-xs font-medium text-foreground"><FileWarning size={12} aria-hidden />Contents not available</span>
                    <button type="button" onClick={() => onReconnect(d.path)} className="inline-flex items-center gap-1 rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted"><Link2 size={12} aria-hidden />Reconnect this file</button>
                  </>
                ) : (
                  <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${TONE[d.state] ?? TONE.uploaded}`} title={d.stateDetail}>
                    {d.state === 'failed' ? <AlertTriangle size={12} aria-hidden /> : <CheckCircle2 size={12} aria-hidden />}{DOC_STATE_LABEL[d.state]}
                  </span>
                )}
              </span>
            </li>
          );
        })}
        {metaOnly.map((p) => (
          <li key={p} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span className="truncate text-foreground" title={p}>{p}</span>
            <span className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded bg-warning/20 px-2 py-0.5 text-xs font-medium text-foreground"><FileWarning size={12} aria-hidden />Listed, contents missing</span>
              <button type="button" onClick={() => onReconnect(p)} className="inline-flex items-center gap-1 rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium hover:bg-muted"><Link2 size={12} aria-hidden />Reconnect this file</button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

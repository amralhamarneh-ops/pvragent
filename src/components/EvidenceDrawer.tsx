'use client';

import React from 'react';
import { X } from 'lucide-react';
import type { ClassifiedFile } from '@/lib/intake/triage';

interface EvidenceDrawerProps {
  open: boolean;
  onClose: () => void;
  files: ClassifiedFile[];
}

function formatSize(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1000) return `${Math.round(n / 1000)} KB`;
  return `${n} B`;
}

/** Stable pseudo-hash for display only. Real hashing runs server-side on stored files. */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0') + (h ^ 0x9e3779b1).toString(16).padStart(8, '0').slice(0, 8);
}

export default function EvidenceDrawer({ open, onClose, files }: EvidenceDrawerProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Evidence details">
      <button type="button" aria-label="Close evidence details" onClick={onClose} className="absolute inset-0 bg-foreground/40" />
      <div className="relative z-10 flex h-full w-full max-w-xl flex-col bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-lg font-semibold text-foreground">Evidence details</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"><X size={18} /></button>
        </div>
        <p className="px-5 pt-3 text-muted-foreground">Technical details for the files in this case. The fingerprint is a quick in-browser check value for spotting duplicates, not a stored audit hash.</p>
        <div className="flex-1 overflow-y-auto p-5">
          <table className="w-full text-table">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground"><th className="py-2 font-medium">File</th><th className="py-2 font-medium">Size</th><th className="py-2 font-medium">Fingerprint</th></tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.path} className="border-b border-border align-top">
                  <td className="py-2 pr-3 text-foreground"><span className="break-all">{f.path}</span></td>
                  <td className="py-2 pr-3 font-data text-muted-foreground">{formatSize(f.size)}</td>
                  <td className="py-2 font-data text-muted-foreground">{shortHash(f.path + f.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

'use client';

import React from 'react';
import { Play } from 'lucide-react';

interface StageFooterProps {
  note: string;
  primaryLabel: string;
  primaryDisabled: boolean;
  onPrimary: () => void;
  onBack: () => void;
  onSave: () => void;
  backDisabled: boolean;
}

export default function StageFooter({ note, primaryLabel, primaryDisabled, onPrimary, onBack, onSave, backDisabled }: StageFooterProps) {
  return (
    <footer className="sticky bottom-0 z-10 border-t border-border bg-card/95 backdrop-blur">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <button type="button" onClick={onBack} disabled={backDisabled} className="rounded-md border border-input bg-card px-4 py-2.5 font-semibold hover:bg-muted disabled:opacity-50">Back</button>
          <button type="button" onClick={onSave} className="rounded-md border border-input bg-card px-4 py-2.5 font-semibold hover:bg-muted">Save draft</button>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <p className="max-w-md text-muted-foreground">{note}</p>
          <button type="button" onClick={onPrimary} disabled={primaryDisabled} className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground">
            {primaryLabel === 'Run' ? <Play size={15} /> : null}
            {primaryLabel}
          </button>
        </div>
      </div>
    </footer>
  );
}

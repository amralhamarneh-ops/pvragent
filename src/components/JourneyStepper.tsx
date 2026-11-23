'use client';

import React from 'react';
import { Check, Lock } from 'lucide-react';

export type JourneyKey = 'documents' | 'scope' | 'boq' | 'activities' | 'impact' | 'decision';
export type JourneyState = 'current' | 'done' | 'todo' | 'later';

export const JOURNEY: { key: JourneyKey; label: string }[] = [
  { key: 'documents', label: 'Documents' },
  { key: 'scope', label: 'Scope & quantities' },
  { key: 'boq', label: 'BOQ & rates' },
  { key: 'activities', label: 'Activities' },
  { key: 'impact', label: 'Impact' },
  { key: 'decision', label: 'Decision' },
];

interface JourneyStepperProps {
  current: JourneyKey;
  done?: JourneyKey[];
  /** Steps that exist as screens in this pass and can be opened. */
  onOpen?: (k: JourneyKey) => void;
  openable?: JourneyKey[];
}

export default function JourneyStepper({ current, done = [], onOpen, openable = [] }: JourneyStepperProps) {
  return (
    <nav aria-label="Assessment journey" className="rounded-lg border border-border bg-card px-4 py-3 shadow-sm">
      <ol className="flex items-center gap-2 overflow-x-auto">
        {JOURNEY.map((s, i) => {
          const isCurrent = s.key === current;
          const isDone = done.includes(s.key);
          const canOpen = !!onOpen && openable.includes(s.key) && !isCurrent;
          const circle = isDone ? 'bg-accent text-accent-foreground' : isCurrent ? 'bg-accent text-accent-foreground ring-4 ring-accent/20' : 'bg-muted text-muted-foreground';
          const body = (
            <>
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${circle}`}>
                {isDone ? <Check size={14} aria-hidden /> : i + 1}
              </span>
              <span className={`whitespace-nowrap ${isCurrent ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>{s.label}</span>
              {!isCurrent && !isDone && !canOpen ? <Lock size={12} className="text-muted-foreground/70" aria-label="Not available in this pass" /> : null}
            </>
          );
          return (
            <li key={s.key} className="flex flex-1 items-center gap-2 last:flex-none">
              {canOpen ? (
                <button type="button" onClick={() => onOpen?.(s.key)} className="flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
                  {body}
                </button>
              ) : (
                <span className="flex items-center gap-2 px-1 py-0.5" aria-current={isCurrent ? 'step' : undefined}>{body}</span>
              )}
              {i < JOURNEY.length - 1 ? <span className={`h-px min-w-4 flex-1 ${isDone ? 'bg-accent' : 'bg-border'}`} aria-hidden /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

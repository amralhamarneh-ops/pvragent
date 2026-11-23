'use client';

import React from 'react';
import StatusDot, { stageLabel } from '@/components/ui/StatusDot';
import type { StageStatus } from '@/lib/mapping/types';
import type { StageKey } from '@/lib/mapping/useCaseStore';

interface StepperProps {
  stages: Record<StageKey, StageStatus>;
  active: StageKey;
  onSelect: (k: StageKey) => void;
  assessmentActive: boolean;
  onSelectAssessment: () => void;
  mappingLocked: boolean;
}

const MAIN: { key: StageKey; label: string; n: number }[] = [
  { key: 'prerequisites', label: 'Prerequisites', n: 1 },
  { key: 'drawing', label: 'Drawing analysis', n: 2 },
  { key: 'boq', label: 'BoQ mapping', n: 3 },
  { key: 'activity', label: 'Activity mapping', n: 4 },
];

const LOCKED = [
  { label: 'PVR and decision', n: 6, group: 'Outcome' },
];

export default function CaseStepper({ stages, active, onSelect, assessmentActive, onSelectAssessment, mappingLocked }: StepperProps) {
  const reachable = (k: StageKey): boolean => {
    const i = MAIN.findIndex((m) => m.key === k);
    if (i <= 1) return true;
    const prev = MAIN[i - 1].key;
    return stages[prev] === 'confirmed' || stages[k] !== 'not_started';
  };
  return (
    <nav aria-label="Case stages" className="space-y-1">
      <p className="px-3 pb-1 font-semibold text-foreground">Mapping</p>
      <ol className="space-y-1">
        {MAIN.map((m) => {
          const status = stages[m.key];
          const can = reachable(m.key);
          const isActive = active === m.key;
          return (
            <li key={m.key}>
              <button
                type="button"
                disabled={!can}
                onClick={() => onSelect(m.key)}
                aria-current={isActive ? 'step' : undefined}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${isActive ? 'bg-accent/10' : 'hover:bg-muted'} disabled:cursor-not-allowed disabled:opacity-60`}
              >
                <StatusDot status={status} index={m.n} />
                <span>
                  <span className="block font-semibold text-foreground">{m.label}</span>
                  <span className={`block text-sm ${status === 'needs_rerun' ? 'font-medium text-warning' : 'text-muted-foreground'}`}>{stageLabel(status)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {['Impact', 'Outcome'].map((g) => (
        <div key={g} className="pt-4">
          <p className="px-3 pb-1 font-semibold text-foreground">{g}</p>
          <ul className="space-y-1">
            {g === 'Impact' ? (
              <li>
                <button type="button" onClick={onSelectAssessment} aria-current={assessmentActive ? 'step' : undefined} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${assessmentActive ? 'bg-accent/10' : 'hover:bg-muted'}`}>
                  <StatusDot status={mappingLocked ? 'needs_review' : 'not_started'} index={5} />
                  <span>
                    <span className="block font-semibold text-foreground">Cost and programme</span>
                    <span className="block text-sm text-muted-foreground">{mappingLocked ? 'Inputs confirmed' : 'Draft until mapping is confirmed'}</span>
                  </span>
                </button>
              </li>
            ) : null}
            {LOCKED.filter((l) => l.group === g).map((l) => (
              <li key={l.n} className="flex items-center gap-3 rounded-lg px-3 py-2.5 opacity-70" aria-disabled="true">
                <StatusDot status="locked" index={l.n} />
                <span>
                  <span className="block font-semibold text-muted-foreground">{l.label}</span>
                  <span className="block text-sm text-muted-foreground">Next release</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

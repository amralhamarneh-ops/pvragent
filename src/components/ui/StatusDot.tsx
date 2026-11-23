'use client';

import React from 'react';
import { Check, Lock, AlertTriangle } from 'lucide-react';
import type { StageStatus } from '@/lib/mapping/types';

const LABEL: Record<StageStatus, string> = {
  not_started: 'Not started',
  running: 'Running',
  needs_review: 'Needs your review',
  confirmed: 'Confirmed',
  needs_rerun: 'Needs re-run',
  locked: 'Next release',
};

export function stageLabel(s: StageStatus): string {
  return LABEL[s];
}

interface StatusDotProps {
  status: StageStatus;
  index: number;
}

export default function StatusDot({ status, index }: StatusDotProps) {
  if (status === 'confirmed') {
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-success text-success-foreground">
        <Check size={15} />
      </span>
    );
  }
  if (status === 'locked') {
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground">
        <Lock size={13} />
      </span>
    );
  }
  if (status === 'needs_rerun') {
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-warning bg-card text-warning">
        <AlertTriangle size={14} />
      </span>
    );
  }
  const ring = status === 'needs_review' ? 'border-warning text-foreground' : status === 'running' ? 'border-accent text-accent' : 'border-input text-muted-foreground';
  return (
    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 bg-card text-sm font-semibold ${ring} ${status === 'running' ? 'animate-pulse' : ''}`}>
      {index}
    </span>
  );
}

import React from 'react';

interface ConfidenceBarProps {
  value: number;
  showLabel?: boolean;
}

export default function ConfidenceBar({ value, showLabel = true }: ConfidenceBarProps) {
  const tone = value >= 85 ? 'bg-success' : value >= 70 ? 'bg-warning' : 'bg-destructive';
  return (
    <div className="flex items-center gap-2" title={`Agent confidence ${value}%`}>
      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${value}%` }} />
      </div>
      {showLabel ? <span className="font-data text-xs text-muted-foreground">{value}%</span> : null}
    </div>
  );
}
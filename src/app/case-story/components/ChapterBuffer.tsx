import React from 'react';
import ChapterShell from '@/app/case-story/components/ChapterShell';

interface GaugeProps {
  label: string;
  beforePct: number;
  afterPct: number;
  detail: string;
  exceeded?: boolean;
}

function Gauge({ label, beforePct, afterPct, detail, exceeded }: GaugeProps) {
  return (
    <div className={`rounded-lg border p-5 ${exceeded ? 'border-destructive/30 bg-destructive/10' : 'border-border bg-card'}`}>
      <p className="text-sm font-semibold text-foreground">{label}</p>
      <div className="relative mt-4 h-3 overflow-hidden rounded-full bg-muted">
        <div className="absolute inset-y-0 left-0 bg-muted-foreground/40" style={{ width: `${beforePct}%` }} />
        <div className={`absolute inset-y-0 left-0 ${exceeded ? 'bg-destructive' : 'bg-accent'}`} style={{ width: `${afterPct}%` }} />
      </div>
      <div className="mt-2 flex justify-between text-xs">
        <span className="font-data text-muted-foreground">Before {beforePct}% used</span>
        <span className={`font-data font-semibold ${exceeded ? 'text-destructive' : 'text-foreground'}`}>After {afterPct}% used</span>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">{detail}</p>
    </div>
  );
}

export default function ChapterBuffer() {
  return (
    <ChapterShell chapterId="chapter-buffer" agents={[{ name: 'Cost', confidence: 83 }, { name: 'Schedule', confidence: 88 }]}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Gauge
          label="Cost contingency · Fahid Island Roads Package"
          beforePct={59}
          afterPct={73}
          detail="AED 9.90M total. After this PVR, AED 2.67M headroom remains. No budget uplift needed."
        />
        <Gauge
          label="Programme buffer"
          beforePct={62}
          afterPct={112}
          detail="Internal buffer is 37 days. This change consumes 41, so the buffer is exceeded by 11 days after earlier claims. A new baseline or contractor challenge may be needed."
          exceeded
        />
      </div>
    </ChapterShell>
  );
}
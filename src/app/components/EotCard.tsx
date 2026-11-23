import React from 'react';
import { CalendarClock } from 'lucide-react';

export default function EotCard() {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-medium tracking-wide text-muted-foreground">Net EoT days pending</p>
        <CalendarClock size={16} className="text-accent" />
      </div>
      <p className="font-data mt-3 text-3xl font-bold text-foreground">
        +95<span className="ml-1 text-base font-semibold text-muted-foreground">days</span>
      </p>
      <div className="mt-3 flex items-end gap-1" aria-hidden="true">
        {[22, 31, 18, 40, 27, 12, 35]?.map((h, i) => (
          <div key={`eot-bar-${i + 1}`} className="w-full rounded-sm bg-accent/30" style={{ height: `${h}px` }} />
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Largest: PVR-0418 adds 41 days to handover</p>
    </div>
  );
}
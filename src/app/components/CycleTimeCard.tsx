import React from 'react';
import { Timer } from 'lucide-react';
import CycleTimeChart from '@/app/components/CycleTimeChart';

export default function CycleTimeCard() {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-medium tracking-wide text-muted-foreground">Median cycle time</p>
        <Timer size={16} className="text-accent" />
      </div>
      <p className="font-data mt-3 text-3xl font-bold text-foreground">
        16.1<span className="ml-1 text-base font-semibold text-muted-foreground">days</span>
      </p>
      <p className="text-xs text-destructive">+2.2 days vs W42 · slower this fortnight</p>
      <div className="mt-2">
        <CycleTimeChart />
      </div>
    </div>
  );
}
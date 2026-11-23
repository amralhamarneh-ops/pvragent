import React from 'react';
import RootCauseChart from '@/app/components/RootCauseChart';
import { rootCauses } from '@/lib/mockData';

const swatches = ['bg-primary', 'bg-accent', 'bg-automated', 'bg-warning', 'bg-muted-foreground'];

export default function RootCauseCard() {
  return (
    <div className="rounded-lg border border-border bg-card p-5 md:col-span-2">
      <div className="mb-2">
        <h2 className="text-base font-semibold text-foreground">What is driving variations</h2>
        <p className="text-xs text-muted-foreground">Root cause by pending value, AED millions</p>
      </div>
      <div className="flex flex-col items-center gap-4 sm:flex-row">
        <div className="w-full sm:w-1/2">
          <RootCauseChart />
        </div>
        <ul className="w-full space-y-2 sm:w-1/2">
          {rootCauses?.map((c, i) => (
            <li key={`cause-${c?.name}`} className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 text-foreground">
                <span className={`h-2.5 w-2.5 rounded-sm ${swatches?.[i]}`} />
                {c?.name}
              </span>
              <span className="font-data text-muted-foreground">AED {c?.value?.toFixed(1)}M</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
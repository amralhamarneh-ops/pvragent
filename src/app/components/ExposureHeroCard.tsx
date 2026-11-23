import React from 'react';
import { ArrowUpRight, TrendingUp } from 'lucide-react';
import { projects, formatAED } from '@/lib/mockData';

export default function ExposureHeroCard() {
  const pending = projects?.reduce((sum, p) => sum + p?.pendingExposure, 0);
  const approved = projects?.reduce((sum, p) => sum + p?.approvedExposure, 0);
  const openCases = projects?.reduce((sum, p) => sum + p?.openCases, 0);
  const total = pending + approved;
  const pendingPct = Math.round((pending / total) * 100);

  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-primary p-6 text-primary-foreground md:col-span-2 lg:row-span-2">
      <div className="drafting-grid pointer-events-none absolute inset-0 opacity-10" />
      <div className="relative flex h-full flex-col">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-[13px] font-medium uppercase tracking-wider opacity-70">Pending variation exposure</p>
            <p className="font-data mt-3 text-5xl font-bold tracking-tight">{formatAED(pending)}</p>
            <p className="mt-2 flex items-center gap-1.5 text-sm opacity-80">
              <TrendingUp size={14} />
              +AED 1.38M since last Monday, across {openCases} open PVRs
            </p>
          </div>
          <span className="rounded-md bg-primary-foreground/10 px-2 py-1 font-data text-xs">live</span>
        </div>

        <div className="mt-8">
          <div className="mb-2 flex items-center justify-between text-xs opacity-80">
            <span>Pending vs approved (all projects)</span>
            <span className="font-data">{pendingPct}% pending</span>
          </div>
          <div className="flex h-3 overflow-hidden rounded-full bg-primary-foreground/15">
            <div className="h-full bg-warning" style={{ width: `${pendingPct}%` }} />
            <div className="h-full bg-primary-foreground/40" style={{ width: `${100 - pendingPct}%` }} />
          </div>
          <div className="mt-2 flex justify-between text-xs opacity-80">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-warning" /> Pending {formatAED(pending)}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-primary-foreground/40" /> Approved {formatAED(approved)}
            </span>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-3 gap-3 border-t border-primary-foreground/15 pt-5">
          <div>
            <p className="font-data text-xl font-semibold">64%</p>
            <p className="text-xs opacity-70">priced with contract rates</p>
          </div>
          <div>
            <p className="font-data text-xl font-semibold">11</p>
            <p className="text-xs opacity-70">lines marked unpriced</p>
          </div>
          <div>
            <p className="font-data text-xl font-semibold">82%</p>
            <p className="text-xs opacity-70">mean agent confidence</p>
          </div>
        </div>

        <a
          href="/project-cases"
          className="mt-6 inline-flex items-center gap-1.5 self-start text-sm font-semibold text-primary-foreground underline-offset-4 hover:underline"
        >
          See every open case
          <ArrowUpRight size={15} />
        </a>
      </div>
    </div>
  );
}
import React from 'react';
import ExposureByProjectChart from '@/app/components/ExposureByProjectChart';

export default function ExposureByProjectCard() {
  return (
    <div className="rounded-lg border border-border bg-card p-5 md:col-span-2">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground">Exposure by project</h2>
          <p className="text-xs text-muted-foreground">Pending vs approved, AED millions · last synced 07:30 GST</p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-warning" />Pending</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-accent" />Approved</span>
        </div>
      </div>
      <ExposureByProjectChart />
    </div>
  );
}
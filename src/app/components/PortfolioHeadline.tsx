import React from 'react';
import Link from 'next/link';
import { ArrowRight, Clock } from 'lucide-react';

export default function PortfolioHeadline() {
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="max-w-3xl">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Clock size={13} />
          Portfolio · Monday 26 October 2026 · data as of 07:30 GST
        </p>
        <h1 className="text-headline font-semibold tracking-tight text-foreground">
          AED 18.42M of variation exposure is pending across 6 projects, and 3 cases need your review today.
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Raha Beach Promenade has 91% of its contingency consumed. PVR-0413 has been waiting 23 days.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Link
          href="/upload-evidence-pack"
          className="rounded-md border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition-all duration-150 hover:bg-muted active:scale-95"
        >
          New PVR pack
        </Link>
        <Link
          href="/project-cases"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-all duration-150 hover:opacity-90 active:scale-95"
        >
          Open review queue
          <ArrowRight size={15} />
        </Link>
      </div>
    </div>
  );
}
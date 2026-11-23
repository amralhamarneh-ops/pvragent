'use client';

import React, { useEffect, useState } from 'react';
import { Printer } from 'lucide-react';
import { chapters } from '@/lib/caseStoryData';
import Toggle from '@/components/ui/Toggle';
import Badge from '@/components/ui/Badge';
import ProgressSpine from '@/app/case-story/components/ProgressSpine';
import ExecutiveView from '@/app/case-story/components/ExecutiveView';
import ChapterRequest from '@/app/case-story/components/ChapterRequest';
import ChapterContract from '@/app/case-story/components/ChapterContract';
import ChapterDrawings from '@/app/case-story/components/ChapterDrawings';
import ChapterBoq from '@/app/case-story/components/ChapterBoq';
import ChapterCost from '@/app/case-story/components/ChapterCost';
import ChapterProgramme from '@/app/case-story/components/ChapterProgramme';
import ChapterBuffer from '@/app/case-story/components/ChapterBuffer';
import ChapterDecision from '@/app/case-story/components/ChapterDecision';
import AgentRoom from '@/app/case-story/components/AgentRoom';

export default function CaseStoryShell() {
  const [executive, setExecutive] = useState(false);
  const [activeId, setActiveId] = useState(chapters?.[0]?.id);

  useEffect(() => {
    if (executive) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) setActiveId(entry.target.id);
        });
      },
      { rootMargin: '-30% 0px -60% 0px' }
    );
    chapters?.forEach((c) => {
      const el = document.getElementById(c?.id);
      if (el) observer?.observe(el);
    });
    return () => observer?.disconnect();
  }, [executive]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-data text-xs font-semibold text-muted-foreground">PVR-0418</span>
            <Badge tone="warning">Awaiting Review</Badge>
            <Badge tone="automated">Agents finished 07:19 GST</Badge>
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
            Extend access road R4 from 5.0 km to 7.0 km
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Fahid Island Roads Package · Zone C – East Spine · Civil – Roads
          </p>
        </div>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-all duration-150 hover:bg-muted active:scale-95"
          >
            <Printer size={15} />
            Story report
          </button>
          <div className="flex items-center gap-2.5 rounded-md border border-border bg-card px-3 py-2">
            <span className="text-sm font-medium text-foreground">Executive view</span>
            <Toggle checked={executive} onChange={setExecutive} label="Toggle executive view" />
          </div>
        </div>
      </div>

      {executive ? (
        <ExecutiveView />
      ) : (
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)_320px]">
          <ProgressSpine activeId={activeId} />
          <div className="min-w-0 space-y-10">
            <ChapterRequest />
            <ChapterContract />
            <ChapterDrawings />
            <ChapterBoq />
            <ChapterCost />
            <ChapterProgramme />
            <ChapterBuffer />
            <ChapterDecision />
          </div>
          <div className="hidden xl:block">
            <AgentRoom />
          </div>
        </div>
      )}
    </div>
  );
}
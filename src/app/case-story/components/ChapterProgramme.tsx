import React from 'react';
import { CalendarClock, AlertTriangle } from 'lucide-react';
import ChapterShell from '@/app/case-story/components/ChapterShell';
import { ganttRows } from '@/lib/caseStoryData';

const TOTAL_DAYS = 112;

export default function ChapterProgramme() {
  return (
    <ChapterShell chapterId="chapter-programme" agents={[{ name: 'Schedule', confidence: 88 }]}>
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-destructive">Handover moves</p>
          <p className="font-data mt-1 text-3xl font-bold text-foreground">+41 days</p>
          <p className="text-xs text-muted-foreground">08 Mar 2027 → 18 Apr 2027</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Float absorbed</p>
          <p className="font-data mt-1 text-3xl font-bold text-foreground">0 d</p>
          <p className="text-xs text-muted-foreground">Added work is on the critical path</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">CPM validation</p>
          <p className="font-data mt-1 text-3xl font-bold text-success">312/312</p>
          <p className="text-xs text-muted-foreground">Activity dates reproduce the XER</p>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <div className="min-w-[760px] p-4">
          <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><CalendarClock size={13} /> Days from data date (20 Oct 2026)</span>
            <span className="flex items-center gap-3">
              <span className="flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm bg-muted-foreground/40" />Before</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm bg-accent" />After</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm bg-destructive" />Critical</span>
            </span>
          </div>
          <ul className="space-y-3">
            {ganttRows?.map((r) => (
              <li key={r?.id} className="grid grid-cols-[200px_1fr] items-center gap-3">
                <div>
                  <p className="truncate text-sm font-medium text-foreground">{r?.activity}</p>
                  <p className="font-data text-xs text-muted-foreground">{r?.code} · float {r?.floatDays} d</p>
                </div>
                <div className="relative h-8">
                  {r?.oldLen > 0 ? (
                    <div
                      className="absolute top-0 h-3 rounded-sm bg-muted-foreground/30"
                      style={{ left: `${(r?.oldStart / TOTAL_DAYS) * 100}%`, width: `${(r?.oldLen / TOTAL_DAYS) * 100}%` }}
                    />
                  ) : null}
                  <div
                    className={`absolute top-4 h-3 rounded-sm ${r?.critical ? 'bg-destructive' : 'bg-accent'}`}
                    style={{ left: `${(r?.newStart / TOTAL_DAYS) * 100}%`, width: `${(r?.newLen / TOTAL_DAYS) * 100}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p className="mt-3 flex items-start gap-2 rounded-md border-l-2 border-warning bg-warning/10 px-3 py-2 text-sm text-foreground">
        <AlertTriangle size={15} className="mt-0.5 shrink-0" />
        The new fragnet A1020N is tied FS to A1000 and drives A1030. Productivity for the new earthworks (1,925 m³ per day) comes from the cost and productivity database.
      </p>
    </ChapterShell>
  );
}
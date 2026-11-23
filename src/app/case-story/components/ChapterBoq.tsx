'use client';

import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import ChapterShell from '@/app/case-story/components/ChapterShell';
import Badge from '@/components/ui/Badge';
import { boqLines } from '@/lib/caseStoryData';

const groups = [
  { id: 'group-2', code: '2', title: 'Earthworks', prefix: ['2.'] },
  { id: 'group-3', code: '3', title: 'Pavements', prefix: ['3.'] },
  { id: 'group-5', code: '5', title: 'Kerbs and edging', prefix: ['5.'] },
  { id: 'group-7', code: '7', title: 'Lighting', prefix: ['7.'] },
  { id: 'group-9', code: '9', title: 'Temporary works and landscape', prefix: ['9.'] },
  { id: 'group-n', code: 'N', title: 'Proposed new items', prefix: ['N-'] },
];

function kindTone(kind: string): 'success' | 'danger' | 'warning' {
  if (kind === 'Addition') return 'success';
  if (kind === 'Omission') return 'danger';
  return 'warning';
}

export default function ChapterBoq() {
  const [open, setOpen] = useState<Record<string, boolean>>({ 'group-2': true, 'group-3': true, 'group-n': true });

  return (
    <ChapterShell chapterId="chapter-boq" agents={[{ name: 'Cost', confidence: 83 }]}>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {groups.map((g) => {
          const lines = boqLines.filter((l) => g.prefix.some((p) => l.code.startsWith(p)));
          if (lines.length === 0) return null;
          const isOpen = !!open[g.id];
          return (
            <div key={g.id} className="border-b border-border last:border-b-0">
              <button
                type="button"
                onClick={() => setOpen((o) => ({ ...o, [g.id]: !o[g.id] }))}
                className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/50"
              >
                {isOpen ? <ChevronDown size={16} className="text-muted-foreground" /> : <ChevronRight size={16} className="text-muted-foreground" />}
                <span className="font-data text-xs font-semibold text-muted-foreground">{g.code}</span>
                <span className="text-sm font-semibold text-foreground">{g.title}</span>
                <span className="ml-auto rounded-full bg-warning/20 px-2 py-0.5 font-data text-xs font-semibold text-foreground">
                  {lines.length} impacted
                </span>
              </button>
              {isOpen ? (
                <ul className="bg-background/60">
                  {lines.map((l) => (
                    <li key={l.id} className="glow-impact flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 py-2.5 pl-8">
                      <span className="font-data w-16 shrink-0 text-xs text-muted-foreground">{l.code}</span>
                      <span className="min-w-[200px] flex-1 text-sm text-foreground">{l.description}</span>
                      <span className="font-data text-xs text-muted-foreground">
                        {l.qty.toLocaleString('en-US')} {l.unit}
                      </span>
                      <Badge tone={kindTone(l.kind)}>{l.kind}</Badge>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Preambles checked: 3.2 Pavement works (measurement rules), 7.1 Lighting (testing and commissioning). No conflicts found.
      </p>
    </ChapterShell>
  );
}
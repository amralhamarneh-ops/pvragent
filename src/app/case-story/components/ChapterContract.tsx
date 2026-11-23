import React from 'react';
import { CheckCircle2, Circle, BookMarked } from 'lucide-react';
import ChapterShell from '@/app/case-story/components/ChapterShell';
import { clauses } from '@/lib/caseStoryData';

const outcomes = [
  { id: 'outcome-outside', label: 'Outside contractor scope', note: 'Decline', active: false },
  { id: 'outcome-lump', label: 'Included in lump sum', note: 'No extra cost', active: false },
  { id: 'outcome-eligible', label: 'Eligible variation', note: 'Process', active: true },
];

export default function ChapterContract() {
  return (
    <ChapterShell chapterId="chapter-contract" agents={[{ name: 'Contract', confidence: 90 }]}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {outcomes?.map((o) => (
          <div
            key={o?.id}
            className={`flex items-start gap-3 rounded-lg border p-4 transition-colors ${
              o?.active ? 'border-success/40 bg-success/10' : 'border-border bg-card opacity-70'
            }`}
          >
            {o?.active ? <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-success" /> : <Circle size={20} className="mt-0.5 shrink-0 text-muted-foreground" />}
            <div>
              <p className="text-sm font-semibold text-foreground">{o?.label}</p>
              <p className="text-xs text-muted-foreground">{o?.note}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
        {clauses?.map((c) => (
          <article key={c?.id} className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent">
                <BookMarked size={14} />
                {c?.clause}
              </span>
              <span className="font-data text-xs text-muted-foreground">{c?.page}</span>
            </div>
            <h3 className="mt-2 text-sm font-semibold text-foreground">{c?.title}</h3>
            <blockquote className="mt-1.5 border-l-2 border-border pl-3 text-sm italic text-muted-foreground">{c?.excerpt}</blockquote>
          </article>
        ))}
      </div>

      <p className="mt-3 rounded-md border-l-2 border-warning bg-warning/10 px-3 py-2 text-sm text-foreground">
        Open question: the contract is silent on wildlife crossings. Item N-001 is treated as new work and flagged for human review.
      </p>
    </ChapterShell>
  );
}
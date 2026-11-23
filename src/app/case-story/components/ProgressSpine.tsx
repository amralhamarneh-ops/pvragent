import React from 'react';
import { chapters } from '@/lib/caseStoryData';

interface ProgressSpineProps {
  activeId: string;
}

export default function ProgressSpine({ activeId }: ProgressSpineProps) {
  const activeIndex = chapters.findIndex((c) => c.id === activeId);
  return (
    <nav aria-label="Case chapters" className="hidden lg:block">
      <div className="sticky top-24">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Case story</p>
        <ol className="relative space-y-1 border-l border-border pl-4">
          {chapters.map((c, i) => {
            const active = c.id === activeId;
            const done = i < activeIndex;
            return (
              <li key={`spine-${c.id}`} className="relative">
                <span
                  className={`absolute -left-[21px] top-2.5 h-2.5 w-2.5 rounded-full border-2 transition-colors duration-200 ${
                    active ? 'border-warning bg-warning' : done ? 'border-accent bg-accent' : 'border-input bg-card'
                  }`}
                />
                <a
                  href={`#${c.id}`}
                  className={`block rounded-md px-2 py-1.5 text-sm transition-colors duration-150 ${
                    active ? 'bg-accent/10 font-semibold text-accent' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <span className="font-data mr-1.5 text-xs">{String(c.number).padStart(2, '0')}</span>
                  {c.label}
                </a>
              </li>
            );
          })}
        </ol>
      </div>
    </nav>
  );
}
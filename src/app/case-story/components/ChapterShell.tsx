import React from 'react';
import { chapters } from '@/lib/caseStoryData';
import AgentTrace from '@/app/case-story/components/AgentTrace';

interface ChapterShellProps {
  chapterId: string;
  agents: Array<{ name: string; confidence: number }>;
  children: React.ReactNode;
}

export default function ChapterShell({ chapterId, agents, children }: ChapterShellProps) {
  const chapter = chapters.find((c) => c.id === chapterId);
  if (!chapter) return null;
  return (
    <section id={chapter.id} className="fade-up scroll-mt-24">
      <p className="font-data text-xs font-semibold uppercase tracking-wider text-accent">
        Chapter {String(chapter.number).padStart(2, '0')} · {chapter.label}
      </p>
      <h2 className="mt-2 max-w-3xl text-xl font-semibold leading-snug tracking-tight text-foreground sm:text-2xl">
        {chapter.headline}
      </h2>
      <div className="mt-5">{children}</div>
      <AgentTrace agents={agents} />
    </section>
  );
}
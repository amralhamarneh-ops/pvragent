'use client';

import React, { useState } from 'react';
import CostPanel from '@/app/case-workspace/components/CostPanel';
import ProgrammePanel from '@/app/case-workspace/components/ProgrammePanel';
import ResultsPanel from '@/app/case-workspace/components/ResultsPanel';
import type { AssessmentStore } from '@/lib/assessment/useAssessment';

type Tab = 'cost' | 'programme' | 'results';

interface AssessmentStageProps {
  a: AssessmentStore;
  mappingLocked: boolean;
}

export default function AssessmentStage({ a, mappingLocked }: AssessmentStageProps) {
  const [tab, setTab] = useState<Tab>('cost');
  const tabs: { key: Tab; label: string }[] = [
    { key: 'cost', label: 'Cost' },
    { key: 'programme', label: 'Programme inputs' },
    { key: 'results', label: 'Results' },
  ];
  const headline = !mappingLocked
    ? 'Confirm Mapping v1 to calculate cost and programme from confirmed inputs.'
    : a.cost.isComplete
      ? 'Cost is fully priced. Review the programme inputs, then freeze the run.'
      : `Cost is a priced subtotal with ${a.cost.unpricedLines.length} unpriced item(s). Programme impact is calculated separately.`;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-headline font-semibold text-foreground">{headline}</h1>
        <p className="mt-1 max-w-3xl text-muted-foreground">Cost and time calculate independently from the same confirmed mapping. If one is blocked the other still works. Missing results show as unavailable, never as zero.</p>
      </div>
      {!mappingLocked ? (
        <div role="status" className="rounded-lg border-2 border-warning bg-warning/5 p-4">
          <p className="font-semibold text-foreground">Mapping v1 is not confirmed yet.</p>
          <p className="text-muted-foreground">You can look around, but figures below use whatever BoQ items are currently selected and are drafts. Confirm the three mapping stages to lock inputs.</p>
        </div>
      ) : null}
      <div role="tablist" aria-label="Assessment sections" className="flex gap-1 border-b border-border">
        {tabs.map((t) => (
          <button key={t.key} role="tab" type="button" aria-selected={tab === t.key} onClick={() => setTab(t.key)} className={`-mb-px border-b-2 px-4 py-2.5 font-semibold ${tab === t.key ? 'border-accent text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>{t.label}</button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'cost' ? <CostPanel a={a} /> : null}
        {tab === 'programme' ? <ProgrammePanel a={a} /> : null}
        {tab === 'results' ? <ResultsPanel a={a} /> : null}
      </div>
    </div>
  );
}

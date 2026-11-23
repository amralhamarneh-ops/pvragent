'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { BookOpen, FlaskConical, Library, Search } from 'lucide-react';
import { DEMO_CASES } from '@/lib/reference/demo';
import { checkLeakage } from '@/lib/reference/lifecycle';
import * as api from '@/lib/reference/client';
import type { EvaluationRun, ReferenceCase } from '@/lib/reference/types';
import CaseLibrary from './CaseLibrary';
import RetrievalDemo from './RetrievalDemo';
import EvaluationPanel from './EvaluationPanel';

type Tab = 'library' | 'retrieval' | 'evaluation';
type Mode = 'loading' | 'live' | 'demo';

export default function ReferenceCasesAdmin() {
  const [tab, setTab] = useState<Tab>('library');
  const [mode, setMode] = useState<Mode>('loading');
  const [cases, setCases] = useState<ReferenceCase[]>([]);
  const [evals, setEvals] = useState<EvaluationRun[]>([]);
  const [notice, setNotice] = useState('');

  const reload = async () => {
    try {
      const r = await api.loadLibrary();
      setCases(r.cases); setEvals(r.evaluations); setMode('live'); setNotice('');
    } catch (e) {
      setMode('demo'); setCases(DEMO_CASES);
      setNotice(`The saved library is not reachable (${e instanceof Error ? e.message : 'error'}). Showing labelled demonstration cases that run in this browser only. Nothing is saved.`);
    }
  };
  useEffect(() => { void reload(); }, []);

  const leakage = useMemo(() => checkLeakage(cases), [cases]);
  const counts = useMemo(() => ({
    approved: cases.filter((c) => c.status === 'approved' && c.partition === 'learning').length,
    evaluation: cases.filter((c) => c.partition === 'evaluation').length,
    tuned: 0,
  }), [cases]);

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'library', label: 'Case library', icon: <Library size={16} /> },
    { key: 'retrieval', label: 'Retrieval in an assessment', icon: <Search size={16} /> },
    { key: 'evaluation', label: 'Evaluation', icon: <FlaskConical size={16} /> },
  ];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Admin Kit</p>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground"><BookOpen size={22} /> Reference Cases &amp; Learning</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Reviewed historical cases that help agents interpret new PVRs. Uploading a case adds it to a reference library. It does not train or fine-tune any model.
          </p>
        </div>
        <dl className="grid grid-cols-3 gap-3 text-center">
          <div className="rounded-lg border border-border bg-card px-4 py-2"><dt className="text-xs text-muted-foreground">Available as reference</dt><dd className="text-xl font-bold text-success">{counts.approved}</dd></div>
          <div className="rounded-lg border border-border bg-card px-4 py-2"><dt className="text-xs text-muted-foreground">Evaluation set</dt><dd className="text-xl font-bold text-foreground">{counts.evaluation}</dd></div>
          <div className="rounded-lg border border-border bg-card px-4 py-2"><dt className="text-xs text-muted-foreground">Used in model fine-tuning</dt><dd className="text-xl font-bold text-muted-foreground">{counts.tuned}</dd></div>
        </dl>
      </header>

      {notice ? <p role="status" className="rounded-md border border-border bg-warning/15 px-4 py-2 text-sm text-foreground">{notice}</p> : null}
      {mode === 'demo' ? <p className="text-xs font-semibold text-muted-foreground">Demonstration mode: example data, not real project history.</p> : null}
      {!leakage.ok ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">Evaluation leakage: {leakage.issues.join(' ')}</p> : null}

      <nav className="flex gap-1 border-b border-border" aria-label="Reference cases sections">
        {tabs.map((t) => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)} aria-current={tab === t.key ? 'page' : undefined}
            className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${tab === t.key ? 'border-accent text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {t.icon}{t.label}
          </button>
        ))}
      </nav>

      {mode === 'loading' ? <p className="text-sm text-muted-foreground">Loading reference library...</p> : null}
      {mode !== 'loading' && tab === 'library' ? <CaseLibrary cases={cases} setCases={setCases} live={mode === 'live'} reload={reload} /> : null}
      {mode !== 'loading' && tab === 'retrieval' ? <RetrievalDemo cases={cases} live={mode === 'live'} /> : null}
      {mode !== 'loading' && tab === 'evaluation' ? <EvaluationPanel cases={cases} evals={evals} setEvals={setEvals} live={mode === 'live'} /> : null}
    </div>
  );
}

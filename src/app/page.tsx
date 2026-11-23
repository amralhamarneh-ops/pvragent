import React from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import { cases, formatAED, projects } from '@/lib/mockData';

export default function PortfolioPage() {
  const pending = projects?.reduce((s, p) => s + p?.pendingExposure, 0);
  const contingencyLeft = projects?.reduce((s, p) => s + p?.contingencyTotal * (1 - p?.contingencyUsedPct / 100), 0);
  const awaiting = cases?.filter((c) => c?.status === 'Awaiting Review');
  const queue = [...awaiting]?.sort((a, b) => b?.ageDays - a?.ageDays);

  return (
    <AppLayout>
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-headline max-w-2xl font-semibold text-foreground">
              {awaiting?.length} cases are waiting for your review, and {formatAED(pending)} of change is still pending.
            </h1>
            <p className="mt-2 text-muted-foreground">Raha Beach has used 91% of its contingency. Start there if you only have a few minutes.</p>
          </div>
          <Link href="/new-pvr" className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-3 font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            <Plus size={16} /> New PVR
          </Link>
        </header>

        <section aria-label="Key numbers" className="grid gap-4 sm:grid-cols-3">
          {[
            { label: 'Pending exposure', value: formatAED(pending), note: 'Across 6 projects' },
            { label: 'Contingency left', value: formatAED(contingencyLeft), note: 'Of all project contingencies' },
            { label: 'Cases awaiting review', value: String(awaiting?.length), note: `Oldest has waited ${queue?.[0]?.ageDays ?? 0} days` },
          ]?.map((n) => (
            <div key={n?.label} className="rounded-lg border border-border bg-card p-5">
              <p className="text-muted-foreground">{n?.label}</p>
              <p className="mt-1 text-3xl font-semibold text-foreground">{n?.value}</p>
              <p className="mt-1 text-sm text-muted-foreground">{n?.note}</p>
            </div>
          ))}
        </section>

        <section aria-label="Review queue">
          <h2 className="text-xl font-semibold text-foreground">Review queue</h2>
          <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-card">
            {queue?.map((c) => (
              <li key={c?.id}>
                <Link href={c?.ref === 'PVR-0418' ? '/case-workspace?demo=1' : '/project-cases'} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 hover:bg-muted/60">
                  <span className="min-w-0">
                    <span className="block font-semibold text-foreground"><span className="font-data">{c?.ref}</span> {c?.title}</span>
                    <span className="block text-muted-foreground">{c?.zone}, requested by {c?.requester}</span>
                  </span>
                  <span className="rounded-full bg-warning/20 px-2.5 py-1 text-sm font-medium text-foreground">Waiting {c?.ageDays} days</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="Projects">
          <h2 className="text-xl font-semibold text-foreground">Projects</h2>
          <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {projects?.map((p) => (
              <Link key={p?.id} href="/project-cases" className="rounded-lg border border-border bg-card p-5 transition-colors hover:border-accent/50">
                <h3 className="font-semibold text-foreground">{p?.name}</h3>
                <p className="text-muted-foreground">{p?.zone}</p>
                <dl className="mt-4 grid grid-cols-2 gap-3">
                  <div><dt className="text-sm text-muted-foreground">Pending</dt><dd className="font-semibold text-foreground">{formatAED(p?.pendingExposure)}</dd></div>
                  <div><dt className="text-sm text-muted-foreground">Open cases</dt><dd className="font-semibold text-foreground">{p?.openCases}</dd></div>
                </dl>
                <div className="mt-4">
                  <div className="flex justify-between text-sm text-muted-foreground"><span>Contingency used</span><span className="font-data">{p?.contingencyUsedPct}%</span></div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted" role="presentation"><div className={`h-full rounded-full ${p?.contingencyUsedPct >= 85 ? 'bg-warning' : 'bg-accent'}`} style={{ width: `${p?.contingencyUsedPct}%` }} /></div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </AppLayout>
  );
}
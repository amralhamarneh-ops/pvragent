import React from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';

export default function CasesHeader() {
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-muted-foreground">Fahid Island Roads Package</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">PVR register</h1>
          <p className="mt-1 text-muted-foreground">12 cases, 3 awaiting review, AED 9.54M net pending, sorted by age</p>
        </div>
        <Link href="/new-pvr" className="inline-flex items-center gap-1.5 self-start rounded-md bg-primary px-4 py-2.5 font-semibold text-primary-foreground transition-opacity hover:opacity-90">
          <Plus size={15} /> New PVR
        </Link>
      </div>
      <dl className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-3">
        <div><dt className="text-sm text-muted-foreground">Contract reference</dt><dd className="font-data font-semibold text-foreground">FIR-CON-2025-011</dd></div>
        <div><dt className="text-sm text-muted-foreground">BoQ set</dt><dd className="font-semibold text-foreground">13 bills, 8,914 items</dd></div>
        <div><dt className="text-sm text-muted-foreground">Baseline schedule</dt><dd className="font-semibold text-foreground">FIR_Baseline_Oct26.xer, data date 12 Oct 2026</dd></div>
      </dl>
    </div>
  );
}
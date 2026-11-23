'use client';

import React, { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import CaseWorkspace from '@/app/case-workspace/components/CaseWorkspace';
import RealCaseWorkspace from '@/app/case-workspace/components/RealCaseWorkspace';
import RequireSignIn from '@/components/RequireSignIn';

function Router() {
  const params = useSearchParams();
  const caseId = params?.get('case');
  const demo = params?.get('demo') === '1';

  // Real and demo cases never share a code path or a storage key.
  if (caseId) return <RequireSignIn purpose="open this case"><RealCaseWorkspace caseId={caseId} /></RequireSignIn>;
  if (demo) {
    return (
      <>
        <p className="-mt-2 mb-4 rounded-md bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground">Demo case: synthetic Fahid Island data. Nothing here comes from an uploaded file.</p>
        <CaseWorkspace />
      </>
    );
  }
  return (
    <div className="mx-auto max-w-2xl rounded-lg border border-border bg-card p-6 shadow-sm">
      <h1 className="text-xl font-semibold text-foreground">No case selected</h1>
      <p className="mt-2 text-muted-foreground">Open a real case from New PVR, or start the synthetic demo. Sample data is never shown for a real case.</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Link href="/new-pvr" className="rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground hover:opacity-90">Go to New PVR</Link>
        <Link href="/case-workspace?demo=1" className="rounded-md border border-input bg-card px-4 py-2 font-semibold hover:bg-muted">Open the synthetic demo</Link>
      </div>
    </div>
  );
}

export default function CaseWorkspaceRouter() {
  return (
    <Suspense fallback={<div className="skeleton h-96 rounded-lg" role="status" aria-label="Loading" />}>
      <Router />
    </Suspense>
  );
}

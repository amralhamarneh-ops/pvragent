import React from 'react';
import AppLayout from '@/components/AppLayout';
import CaseStoryShell from '@/app/case-story/components/CaseStoryShell';

export default function CaseStoryPage() {
  return (
    <AppLayout>
      <p role="note" className="mb-4 rounded-md bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground">Demo content: this case story is a synthetic sample (PVR-0418). It is not generated from any uploaded file.</p>
      <CaseStoryShell />
    </AppLayout>
  );
}
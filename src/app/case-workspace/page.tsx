import React from 'react';
import AppLayout from '@/components/AppLayout';
import CaseWorkspaceRouter from '@/app/case-workspace/components/CaseWorkspaceRouter';
import AppToaster from '@/lib/toaster';

export default function CaseWorkspacePage() {
  return (
    <AppLayout>
      <CaseWorkspaceRouter />
      <AppToaster />
    </AppLayout>
  );
}

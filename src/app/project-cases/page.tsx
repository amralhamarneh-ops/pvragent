import React from 'react';
import AppLayout from '@/components/AppLayout';
import CasesHeader from '@/app/project-cases/components/CasesHeader';
import CasesTable from '@/app/project-cases/components/CasesTable';

export default function ProjectCasesPage() {
  return (
    <AppLayout>
      <div className="space-y-5">
        <CasesHeader />
        <CasesTable />
      </div>
    </AppLayout>
  );
}
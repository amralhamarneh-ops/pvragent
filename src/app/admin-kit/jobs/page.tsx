import React from 'react';
import AdminShell from '@/app/admin-kit/components/AdminShell';
import JobsOverview from '@/app/admin-kit/components/JobsOverview';

export default function JobsPage() {
  return (
    <AdminShell>
      <JobsOverview />
    </AdminShell>
  );
}

import React from 'react';
import AdminShell from '@/app/admin-kit/components/AdminShell';
import RunHistory from '@/app/admin-kit/components/RunHistory';

export default function EvaluationPage() {
  return (
    <AdminShell>
      <RunHistory />
    </AdminShell>
  );
}

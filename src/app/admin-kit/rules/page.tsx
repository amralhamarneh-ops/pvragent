import React from 'react';
import AdminShell from '@/app/admin-kit/components/AdminShell';
import RulesOverview from '@/app/admin-kit/components/RulesOverview';

export default function RulesPage() {
  return (
    <AdminShell>
      <RulesOverview />
    </AdminShell>
  );
}

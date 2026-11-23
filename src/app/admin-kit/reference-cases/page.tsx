import React from 'react';
import AdminShell from '@/app/admin-kit/components/AdminShell';
import ReferenceCasesAdmin from '@/app/admin-kit/reference-cases/components/ReferenceCasesAdmin';

export default function ReferenceCasesPage() {
  return (
    <AdminShell>
      <ReferenceCasesAdmin />
    </AdminShell>
  );
}

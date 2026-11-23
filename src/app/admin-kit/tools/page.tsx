import React from 'react';
import AdminShell from '@/app/admin-kit/components/AdminShell';
import ToolsConnections from '@/app/admin-kit/components/ToolsConnections';

export default function ToolsPage() {
  return (
    <AdminShell>
      <ToolsConnections />
    </AdminShell>
  );
}

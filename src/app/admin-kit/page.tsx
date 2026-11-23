import React from 'react';
import AdminShell from '@/app/admin-kit/components/AdminShell';
import AgentsInventory from '@/app/admin-kit/components/AgentsInventory';

export default function AdminKitHome() {
  return (
    <AdminShell>
      <AgentsInventory />
    </AdminShell>
  );
}

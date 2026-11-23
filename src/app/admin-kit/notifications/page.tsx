import React from 'react';
import AdminShell from '@/app/admin-kit/components/AdminShell';
import NotificationsAdmin from '@/app/admin-kit/components/NotificationsAdmin';

export default function NotificationsPage() {
  return (
    <AdminShell>
      <NotificationsAdmin />
    </AdminShell>
  );
}

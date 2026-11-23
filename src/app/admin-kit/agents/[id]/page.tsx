import React from 'react';
import AdminShell from '@/app/admin-kit/components/AdminShell';
import AgentDetail from '@/app/admin-kit/components/AgentDetail';

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AdminShell>
      <AgentDetail agentId={id} />
    </AdminShell>
  );
}

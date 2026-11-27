import React from 'react';
import Link from 'next/link';
import AppLayout from '@/components/AppLayout';
import NewPvrFlow from '@/app/new-pvr/components/NewPvrFlow';

export default function NewPvrPage() {
  return (
    <AppLayout>
      <div className="mx-auto max-w-7xl px-4 pt-3 lg:px-8"><Link href="/pvr-demo" className="text-sm font-semibold underline">Open browser-only drawing &amp; BOQ rehearsal</Link></div>
      <NewPvrFlow />
    </AppLayout>
  );
}

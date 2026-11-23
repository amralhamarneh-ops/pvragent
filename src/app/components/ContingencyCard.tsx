import React from 'react';
import { ShieldAlert } from 'lucide-react';

export default function ContingencyCard() {
  const remaining = 41;
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-medium tracking-wide text-muted-foreground">Contingency remaining</p>
        <ShieldAlert size={16} className="text-accent" />
      </div>
      <p className="font-data mt-3 text-3xl font-bold text-foreground">{remaining}%</p>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-accent" style={{ width: `${remaining}%` }} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">AED 28.9M of AED 82.7M across the portfolio</p>
    </div>
  );
}
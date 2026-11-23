'use client';

import React from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid } from 'recharts';
import { waterfall } from '@/lib/caseStoryData';

const fillFor: Record<string, string> = {
  add: 'var(--accent)',
  omit: 'var(--success)',
  net: 'var(--primary)',
};

function ChartTip({ active, payload }: { active?: boolean; payload?: Array<{ payload: { name: string; value: number } }> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 text-xs shadow-md">
      <p className="font-semibold text-foreground">{p.name}</p>
      <p className="font-data text-muted-foreground">AED {p.value.toFixed(2)}M</p>
    </div>
  );
}

export default function CostWaterfallChart() {
  return (
    <div className="h-52">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={waterfall} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} />
          <Tooltip content={<ChartTip />} cursor={{ fill: 'var(--muted)' }} />
          <Bar dataKey="base" stackId="wf" fill="transparent" />
          <Bar dataKey="value" stackId="wf" radius={[4, 4, 0, 0]}>
            {waterfall.map((w) => (
              <Cell key={`wf-${w.id}`} fill={fillFor[w.kind]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
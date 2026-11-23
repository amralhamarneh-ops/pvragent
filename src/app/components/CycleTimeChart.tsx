'use client';

import React from 'react';
import { LineChart, Line, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { cycleTimeByWeek } from '@/lib/mockData';

function ChartTip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-card px-2.5 py-1.5 text-xs shadow-md">
      <p className="font-semibold text-foreground">{label}</p>
      <p className="font-data text-muted-foreground">{payload[0].value} days</p>
    </div>
  );
}

export default function CycleTimeChart() {
  return (
    <div className="h-20">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={cycleTimeByWeek} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
          <XAxis dataKey="week" hide />
          <Tooltip content={<ChartTip />} cursor={{ stroke: 'var(--border)' }} />
          <Line type="monotone" dataKey="days" stroke="var(--accent)" strokeWidth={2} dot={{ r: 2, fill: 'var(--accent)' }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
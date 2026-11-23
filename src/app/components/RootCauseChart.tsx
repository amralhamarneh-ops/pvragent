'use client';

import React from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { rootCauses } from '@/lib/mockData';

const fills = ['var(--primary)', 'var(--accent)', 'var(--automated)', 'var(--warning)', 'var(--muted-foreground)'];

function ChartTip({ active, payload }: { active?: boolean; payload?: Array<{ name: string; value: number }> }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 text-xs shadow-md">
      <p className="font-semibold text-foreground">{payload[0].name}</p>
      <p className="font-data text-muted-foreground">AED {payload[0].value.toFixed(1)}M</p>
    </div>
  );
}

export default function RootCauseChart() {
  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Tooltip content={<ChartTip />} />
          <Pie data={rootCauses} dataKey="value" nameKey="name" innerRadius={48} outerRadius={78} paddingAngle={2} stroke="var(--card)">
            {rootCauses.map((c, i) => (
              <Cell key={`cell-${c.name}`} fill={fills[i]} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
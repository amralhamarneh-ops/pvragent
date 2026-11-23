import React from 'react';
import ChapterShell from '@/app/case-story/components/ChapterShell';
import Badge from '@/components/ui/Badge';
import CostWaterfallChart from '@/app/case-story/components/CostWaterfallChart';
import ConfidenceBar from '@/components/ui/ConfidenceBar';
import { boqLines } from '@/lib/caseStoryData';
import { formatAEDFull } from '@/lib/mockData';

export default function ChapterCost() {
  const total = boqLines?.reduce((sum, l) => sum + l?.qty * l?.rate, 0);
  return (
    <ChapterShell chapterId="chapter-cost" agents={[{ name: 'Cost', confidence: 83 }]}>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <div className="rounded-lg border border-border bg-card p-5 xl:col-span-2">
          <p className="text-[13px] font-medium tracking-wide text-muted-foreground">Net cost impact</p>
          <p className="font-data mt-2 text-3xl font-bold text-foreground">{formatAEDFull(Math.round(total))}</p>
          <CostWaterfallChart />
          <p className="text-xs text-muted-foreground">AED millions: additions, abortive and omissions to net.</p>
        </div>

        <div className="overflow-x-auto rounded-lg border border-border bg-card xl:col-span-3">
          <table className="w-full min-w-[620px] text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2.5">Item</th>
                <th className="px-3 py-2.5 text-right">Qty</th>
                <th className="px-3 py-2.5 text-right">Rate</th>
                <th className="px-3 py-2.5 text-right">Amount</th>
                <th className="px-3 py-2.5">Rate source</th>
                <th className="px-4 py-2.5">Conf.</th>
              </tr>
            </thead>
            <tbody>
              {boqLines?.map((l) => {
                const amount = l?.qty * l?.rate;
                const low = l?.confidence < 70;
                return (
                  <tr key={`cost-${l?.id}`} className={`border-b border-border last:border-b-0 hover:bg-muted/50 ${low ? 'bg-warning/10' : ''}`}>
                    <td className="max-w-[240px] px-4 py-2.5">
                      <p className="truncate font-medium text-foreground">{l?.description}</p>
                      <p className="font-data text-xs text-muted-foreground">{l?.code} · {l?.unit}</p>
                    </td>
                    <td className="font-data px-3 py-2.5 text-right text-muted-foreground">{l?.qty?.toLocaleString('en-US')}</td>
                    <td className="font-data px-3 py-2.5 text-right text-muted-foreground">{l?.rate?.toLocaleString('en-US')}</td>
                    <td className={`font-data px-3 py-2.5 text-right font-semibold ${amount < 0 ? 'text-success' : 'text-foreground'}`}>
                      {formatAEDFull(Math.round(amount))}
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge tone={l?.source === 'First principles' ? 'warning' : 'neutral'}>{l?.source}</Badge>
                    </td>
                    <td className="px-4 py-2.5"><ConfidenceBar value={l?.confidence} showLabel={false} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </ChapterShell>
  );
}
import React from 'react';
import Link from 'next/link';
import { projects, formatAED } from '@/lib/mockData';

function gaugeTone(pct: number): string {
  if (pct >= 85) return 'bg-destructive';
  if (pct >= 65) return 'bg-warning';
  return 'bg-success';
}

export default function ProjectTable() {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">Projects</h2>
          <p className="text-xs text-muted-foreground">Contingency consumed includes approved and pending impacts</p>
        </div>
        <Link href="/project-cases" className="text-sm font-semibold text-accent hover:underline">
          Open case register
        </Link>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <th className="px-5 py-3">Project</th>
              <th className="px-3 py-3">Location</th>
              <th className="px-3 py-3 text-right">Contract value</th>
              <th className="px-3 py-3 text-right">Pending</th>
              <th className="px-3 py-3 text-right">Approved</th>
              <th className="px-3 py-3">Contingency used</th>
              <th className="px-3 py-3 text-right">Open PVRs</th>
              <th className="px-5 py-3 text-right">Oldest</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id} className="border-b border-border transition-colors last:border-b-0 hover:bg-muted/50">
                <td className="px-5 py-3 font-semibold text-foreground">{p.name}</td>
                <td className="px-3 py-3 text-muted-foreground">{p.zone}</td>
                <td className="font-data px-3 py-3 text-right text-foreground">{formatAED(p.contractValue)}</td>
                <td className="font-data px-3 py-3 text-right font-semibold text-foreground">{formatAED(p.pendingExposure)}</td>
                <td className="font-data px-3 py-3 text-right text-muted-foreground">{formatAED(p.approvedExposure)}</td>
                <td className="px-3 py-3">
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
                      <div className={`h-full rounded-full ${gaugeTone(p.contingencyUsedPct)}`} style={{ width: `${p.contingencyUsedPct}%` }} />
                    </div>
                    <span className="font-data text-xs text-muted-foreground">{p.contingencyUsedPct}%</span>
                  </div>
                </td>
                <td className="font-data px-3 py-3 text-right text-foreground">{p.openCases}</td>
                <td className={`font-data px-5 py-3 text-right ${p.oldestCaseDays > 30 ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>
                  {p.oldestCaseDays} d
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
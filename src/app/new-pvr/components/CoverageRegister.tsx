'use client';

import React from 'react';
import type { CoverageRow, CoverageTotals } from '@/lib/boq/coverage';

interface CoverageRegisterProps {
  rows: CoverageRow[];
  totals: CoverageTotals;
}

const TONE: Record<CoverageRow['inclusion'], string> = {
  included: 'bg-secondary text-secondary-foreground',
  excluded: 'bg-warning/20 text-foreground',
  superseded: 'bg-muted text-muted-foreground',
  duplicate: 'bg-muted text-muted-foreground',
  reference: 'bg-accent/10 text-accent',
};

const ANALYSIS_TONE: Record<CoverageRow['analysis'], string> = {
  current: 'bg-secondary text-secondary-foreground',
  stale: 'bg-warning/20 text-foreground',
  not_run: 'bg-muted text-muted-foreground',
  not_applicable: 'bg-muted text-muted-foreground',
};
const ANALYSIS_LABEL: Record<CoverageRow['analysis'], string> = { current: 'Analysis current', stale: 'Analysis stale', not_run: 'Not analysed yet', not_applicable: 'Not applicable' };

export default function CoverageRegister({ rows, totals }: CoverageRegisterProps) {
  return (
    <section className="rounded-lg border border-border bg-card p-5 shadow-sm" aria-labelledby="coverage-title">
      <h2 id="coverage-title" className="text-xl font-semibold text-foreground">Document coverage register</h2>
      <p className="mt-1 text-muted-foreground">Every uploaded document is listed here. “Readable”, “processed” and “used in the assessment” are different things: supporting evidence can be reviewed without contributing a quantity or a rate.</p>
      <p role="status" className="mt-2 text-sm text-foreground tabular">
        {totals.uploaded} uploaded · {totals.readable} readable · {totals.processed} processed · {totals.used} used in the assessment · {totals.reviewedOnly} reviewed only · {totals.unread} with unread or unsupported content
      </p>
      {rows.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No documents have been uploaded yet.</p> : (
        <div className="mt-3 overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[980px] text-left text-sm">
            <caption className="sr-only">Document coverage register</caption>
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2">File</th>
                <th scope="col" className="px-3 py-2">Category · role · revision</th>
                <th scope="col" className="px-3 py-2">Assessment status</th>
                <th scope="col" className="px-3 py-2">Original file</th>
                <th scope="col" className="px-3 py-2">Read / parse</th>
                <th scope="col" className="px-3 py-2">Content processed</th>
                <th scope="col" className="px-3 py-2">Consumed by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-border align-top">
                  <th scope="row" className="px-3 py-2 font-medium text-foreground">{r.file}</th>
                  <td className="px-3 py-2 text-foreground">{r.category}<span className="block text-xs text-muted-foreground">{r.assessmentRole} · {r.revision}</span></td>
                  <td className="px-3 py-2">
                    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${TONE[r.inclusion]}`}>{r.inclusionLabel}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{r.inclusionReason}</span>
                  </td>
                  <td className="px-3 py-2"><span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${r.storage.stored ? 'bg-secondary text-secondary-foreground' : 'bg-warning/20 text-foreground'}`}>{r.storage.text}</span></td>
                  <td className="px-3 py-2 text-foreground">{r.read.status === 'parsed' ? 'Parsed' : r.read.status === 'readable_not_parsed' ? 'Readable, not parsed' : r.read.status === 'unsupported' ? 'Unsupported' : r.read.status === 'failed' ? 'Failed' : 'Not attempted'}<span className="block text-xs text-muted-foreground">{r.read.text}</span></td>
                  <td className="px-3 py-2 text-foreground">{r.contentProcessed}{r.unreadContent ? <span className="block text-xs text-warning">Unread: {r.unreadContent}</span> : null}</td>
                  <td className="px-3 py-2 text-foreground">{r.consumedBy}<span className={`mt-1 inline-block rounded px-2 py-0.5 text-xs font-medium ${ANALYSIS_TONE[r.analysis]}`} title={r.analysisText}>{ANALYSIS_LABEL[r.analysis]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

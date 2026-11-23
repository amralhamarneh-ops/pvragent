import React from 'react';
import { FileText, Link2 } from 'lucide-react';
import ChapterShell from '@/app/case-story/components/ChapterShell';
import ConfidenceBar from '@/components/ui/ConfidenceBar';
import { pvrFields } from '@/lib/caseStoryData';

export default function ChapterRequest() {
  return (
    <ChapterShell chapterId="chapter-request" agents={[{ name: 'Intake', confidence: 92 }]}>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <div className="rounded-lg border border-border bg-card p-5 xl:col-span-3">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
            <FileText size={16} className="text-accent" />
            PVR-0418.pdf
            <span className="font-data text-xs font-normal text-muted-foreground">3 pages · sha256 9f2c…a41e</span>
          </div>
          <div className="space-y-3 text-sm leading-relaxed text-foreground">
            <p>
              Following the Employer&apos;s instruction of 20 October 2026, the Contractor notifies a potential variation to
              extend{' '}
              <mark className="rounded bg-warning/30 px-1 text-foreground">access road R4 from CH 5+000 to CH 7+000</mark>{' '}
              within{' '}
              <mark className="rounded bg-warning/30 px-1 text-foreground">Zone C – East Spine</mark>, including{' '}
              <mark className="rounded bg-warning/30 px-1 text-foreground">earthworks, pavement, kerbs and street lighting</mark>.
            </p>
            <p className="text-muted-foreground">
              The Contractor reserves the right to claim an extension of time and associated prolongation costs once
              revised drawings are issued. Reference drawing R4-CIV-101 Rev C.
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card xl:col-span-2">
          <p className="border-b border-border px-4 py-3 text-sm font-semibold text-foreground">Extracted fields</p>
          <ul>
            {pvrFields?.map((f) => (
              <li key={f?.id} className="border-b border-border px-4 py-2.5 last:border-b-0">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{f?.label}</p>
                  <ConfidenceBar value={f?.confidence} />
                </div>
                <p className="mt-0.5 text-sm font-semibold text-foreground">{f?.value}</p>
                <p className="mt-0.5 flex items-center gap-1 text-xs text-accent">
                  <Link2 size={11} />
                  {f?.source}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </ChapterShell>
  );
}
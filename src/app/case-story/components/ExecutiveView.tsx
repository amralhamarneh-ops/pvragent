import React from 'react';
import { ArrowRight, Gavel } from 'lucide-react';

const stats = [
  { id: 'exec-cost', label: 'Net cost impact', value: 'AED 3.26M', tone: 'text-foreground', sub: 'of which AED 0.41M first-principles' },
  { id: 'exec-eot', label: 'Extension of time', value: '+41 days', tone: 'text-destructive', sub: 'Handover 18 Apr 2027' },
  { id: 'exec-cont', label: 'Contingency left', value: 'AED 2.67M', tone: 'text-foreground', sub: '27% of AED 9.90M' },
];

const sentences = [
  'Fahid Island asks to lengthen road R4 from 5.0 km to 7.0 km.',
  'The contract treats this as an eligible variation, notice served on time.',
  'Drawing Rev C adds 2,000 m of road and 14,000 m² of pavement.',
  'Cost rises AED 3.26M and handover moves 41 days, since the work is on the critical path.',
  'Contingency covers the cost, but the programme buffer is exceeded by 11 days.',
];

export default function ExecutiveView() {
  return (
    <div className="fade-up mx-auto max-w-4xl space-y-5 rounded-lg border border-border bg-card p-6 sm:p-8">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Executive view · 30-second read</p>
      <ol className="space-y-2">
        {sentences?.map((s, i) => (
          <li key={`exec-sentence-${i + 1}`} className="flex gap-3 text-base text-foreground">
            <span className="font-data text-sm font-semibold text-accent">{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {stats?.map((s) => (
          <div key={s?.id} className="rounded-lg border border-border bg-background p-4">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{s?.label}</p>
            <p className={`font-data mt-1 text-2xl font-bold ${s?.tone}`}>{s?.value}</p>
            <p className="text-xs text-muted-foreground">{s?.sub}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-warning/50 bg-warning/10 p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-start gap-2 text-sm text-foreground">
          <Gavel size={18} className="mt-0.5 shrink-0" />
          <span>
            <strong>Recommendation:</strong> accept and add a second paving crew to hold the date, at AED 0.74M more.
          </span>
        </p>
        <a
          href="#chapter-decision"
          className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md bg-warning px-4 py-2 text-sm font-bold text-warning-foreground transition-all duration-150 hover:opacity-90 active:scale-95"
        >
          Review and approve
          <ArrowRight size={15} />
        </a>
      </div>
    </div>
  );
}
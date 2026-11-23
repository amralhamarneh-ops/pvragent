'use client';

import React, { useState } from 'react';
import ChapterShell from '@/app/case-story/components/ChapterShell';

const changes = [
  { id: 'change-001', label: 'R4 centreline extension', measure: '+2,000.0 m', layer: 'C-ROAD-CL', confidence: 95 },
  { id: 'change-002', label: 'Carriageway and shoulder pavement', measure: '+14,000 m²', layer: 'C-ROAD-PAVE', confidence: 91 },
  { id: 'change-003', label: 'Precast kerb line', measure: '+4,000 m', layer: 'C-ROAD-KERB', confidence: 93 },
  { id: 'change-004', label: 'Lighting columns', measure: '+67 no', layer: 'E-LITE-COL', confidence: 84 },
  { id: 'change-005', label: 'Temporary end barrier removed', measure: '−60 m', layer: 'C-TEMP-BAR', confidence: 89 },
];

export default function ChapterDrawings() {
  const [split, setSplit] = useState(50);
  const [activeChange, setActiveChange] = useState('change-001');

  return (
    <ChapterShell chapterId="chapter-drawings" agents={[{ name: 'Drawing', confidence: 91 }, { name: 'Schedule', confidence: 88 }]}>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <div className="xl:col-span-3">
          <div className="relative h-72 overflow-hidden rounded-lg border border-border bg-card select-none">
            {/* Revised (Rev C) layer */}
            <svg viewBox="0 0 600 280" className="absolute inset-0 h-full w-full" role="img" aria-label="Drawing Rev C with road extension">
              <rect width="600" height="280" className="fill-card" />
              <g className="stroke-border" strokeWidth="1">
                {[40, 80, 120, 160, 200, 240]?.map((y) => (
                  <line key={`rc-h-${y}`} x1="0" y1={y} x2="600" y2={y} />
                ))}
                {[100, 200, 300, 400, 500]?.map((x) => (
                  <line key={`rc-v-${x}`} x1={x} y1="0" x2={x} y2="280" />
                ))}
              </g>
              <path d="M30 200 C150 180 250 140 340 130 L560 80" className="fill-none stroke-accent" strokeWidth="6" strokeLinecap="round" />
              <path d="M340 130 L560 80" className="fill-none stroke-warning" strokeWidth="6" strokeLinecap="round" />
              <circle cx="560" cy="80" r="6" className="fill-warning" />
              <text x="372" y="96" className="fill-foreground text-[11px]" fontSize="11">CH 7+000 · Rev C</text>
            </svg>

            {/* Original (Rev B) layer clipped to left of slider */}
            <div className="absolute inset-y-0 left-0 overflow-hidden border-r-2 border-warning bg-card" style={{ width: `${split}%` }}>
              <svg viewBox="0 0 600 280" className="h-full w-[600px] max-w-none" style={{ width: `${(100 / Math.max(split, 1)) * 100}%` }} preserveAspectRatio="xMinYMid slice" role="img" aria-label="Drawing Rev B original road">
                <rect width="600" height="280" className="fill-card" />
                <g className="stroke-border" strokeWidth="1">
                  {[40, 80, 120, 160, 200, 240]?.map((y) => (
                    <line key={`rb-h-${y}`} x1="0" y1={y} x2="600" y2={y} />
                  ))}
                  {[100, 200, 300, 400, 500]?.map((x) => (
                    <line key={`rb-v-${x}`} x1={x} y1="0" x2={x} y2="280" />
                  ))}
                </g>
                <path d="M30 200 C150 180 250 140 340 130" className="fill-none stroke-muted-foreground" strokeWidth="6" strokeLinecap="round" />
                <circle cx="340" cy="130" r="6" className="fill-muted-foreground" />
                <text x="260" y="116" className="fill-muted-foreground" fontSize="11">CH 5+000 · Rev B</text>
              </svg>
            </div>

            <span className="absolute left-3 top-3 rounded-md bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground">Rev B · original</span>
            <span className="absolute right-3 top-3 rounded-md bg-accent px-2 py-1 text-xs font-semibold text-accent-foreground">Rev C · revised</span>

            <input
              type="range"
              min={5}
              max={95}
              value={split}
              onChange={(e) => setSplit(Number(e?.target?.value))}
              aria-label="Compare Rev B and Rev C drawings"
              className="absolute bottom-3 left-1/2 w-2/3 -translate-x-1/2 accent-[var(--warning)]"
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Amber line: added road. Unit calibration confirmed once for the set: metres, scale 1:1000.</p>
        </div>

        <div className="rounded-lg border border-border bg-card xl:col-span-2">
          <p className="border-b border-border px-4 py-3 text-sm font-semibold text-foreground">Change list</p>
          <ul>
            {changes?.map((c) => (
              <li key={c?.id}>
                <button
                  type="button"
                  onClick={() => setActiveChange(c?.id)}
                  className={`flex w-full items-center justify-between gap-3 border-b border-border px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/50 ${
                    activeChange === c?.id ? 'glow-impact bg-warning/10' : ''
                  }`}
                >
                  <div>
                    <p className="text-sm font-medium text-foreground">{c?.label}</p>
                    <p className="font-data text-xs text-muted-foreground">Layer {c?.layer} · {c?.confidence}%</p>
                  </div>
                  <span className={`font-data text-sm font-semibold ${c?.measure?.startsWith('−') ? 'text-destructive' : 'text-success'}`}>
                    {c?.measure}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </ChapterShell>
  );
}
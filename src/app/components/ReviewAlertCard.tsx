import React from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';

const queue = [
  { id: 'queue-pvr-0413', ref: 'PVR-0413', age: '23 d', tone: 'text-destructive' },
  { id: 'queue-pvr-0416', ref: 'PVR-0416', age: '14 d', tone: 'text-foreground' },
  { id: 'queue-pvr-0418', ref: 'PVR-0418', age: '6 d', tone: 'text-foreground' },
];

export default function ReviewAlertCard() {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-5">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-medium tracking-wide text-destructive">Awaiting your review</p>
        <AlertTriangle size={16} className="text-destructive" />
      </div>
      <p className="font-data mt-3 text-3xl font-bold text-foreground">3</p>
      <ul className="mt-2 space-y-1">
        {queue?.map((q) => (
          <li key={q?.id}>
            <Link href="/case-story" className="flex items-center justify-between text-xs hover:underline">
              <span className="font-data font-semibold text-foreground">{q?.ref}</span>
              <span className={`font-data ${q?.tone}`}>{q?.age}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
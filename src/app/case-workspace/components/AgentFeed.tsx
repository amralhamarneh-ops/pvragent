'use client';

import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, HelpCircle, PanelRightClose, PanelRightOpen } from 'lucide-react';
import Toggle from '@/components/ui/Toggle';
import type { AgentEvent } from '@/lib/mapping/types';

interface AgentFeedProps {
  events: AgentEvent[];
  live: boolean;
  open: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}

function Icon({ kind }: { kind: AgentEvent['kind'] }) {
  if (kind === 'challenge') return <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-destructive text-destructive-foreground"><AlertCircle size={12} /></span>;
  if (kind === 'question') return <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-warning text-warning-foreground"><HelpCircle size={12} /></span>;
  return <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-automated text-automated-foreground"><Check size={12} /></span>;
}

export default function AgentFeed({ events, live, open, onToggle, children }: AgentFeedProps) {
  const [raw, setRaw] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [events.length]);

  if (!open) {
    return (
      <button type="button" onClick={onToggle} aria-label="Open agent feed" className="flex h-fit items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 font-medium hover:bg-muted">
        <PanelRightOpen size={16} /> Agent feed
      </button>
    );
  }

  return (
    <aside aria-label="Agent feed" className="flex h-full flex-col">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-foreground">Agent feed</h2>
          <span className="rounded-full bg-secondary px-2.5 py-0.5 text-sm font-medium text-secondary-foreground">Scripted demo playback</span>
          {live ? <span className="rounded-full bg-automated/10 px-2.5 py-0.5 text-sm font-medium text-automated">Playing</span> : null}
        </div>
        <button type="button" onClick={onToggle} aria-label="Collapse agent feed" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"><PanelRightClose size={16} /></button>
      </div>

      <div className="mt-4 min-h-[120px] flex-1 overflow-y-auto pr-1" aria-live="polite">
        {events.length === 0 ? (
          <p className="text-muted-foreground">Nothing has run yet. Starting a stage plays a scripted demo sequence on synthetic data. These messages are not output from live agents.</p>
        ) : raw ? (
          <pre className="whitespace-pre-wrap break-words font-data text-sm leading-relaxed text-muted-foreground">
            {events.map((e) => `${e.time} [${e.kind}] ${e.agent}: ${e.text}${e.durationMs ? ` (${e.durationMs} ms)` : ''}`).join('\n')}
          </pre>
        ) : (
          <ul className="space-y-0">
            {events.map((e) => (
              <li key={e.id} className="flex gap-3 border-b border-border py-3 last:border-b-0">
                <Icon kind={e.kind} />
                <div className="min-w-0">
                  <p className="text-body text-foreground"><span className="font-semibold text-automated">{e.agent}</span> {e.text}</p>
                  <p className="font-data text-sm text-muted-foreground">{e.time}{e.durationMs ? ` · ${(e.durationMs / 1000).toFixed(1)} s` : ''}</p>
                </div>
              </li>
            ))}
            <div ref={endRef} />
          </ul>
        )}
      </div>

      <div className="mt-3 flex items-center gap-3 border-t border-border pt-3">
        <Toggle checked={raw} onChange={setRaw} label="Show raw log" />
        <span className="text-muted-foreground">Show raw log</span>
      </div>
      {children}
    </aside>
  );
}

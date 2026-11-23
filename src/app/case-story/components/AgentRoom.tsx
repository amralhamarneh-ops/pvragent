import React from 'react';
import { Radio } from 'lucide-react';
import { agentEvents } from '@/lib/caseStoryData';

const dotFor: Record<string, string> = {
  plan: 'bg-primary',
  finding: 'bg-automated',
  tool_call: 'bg-accent',
  challenge: 'bg-warning',
  handover: 'bg-success',
  escalation: 'bg-destructive',
};

export default function AgentRoom() {
  return (
    <aside className="sticky top-24 rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Radio size={15} className="text-automated" />
          Agent room
        </p>
        <span className="font-data text-xs text-muted-foreground">8 events</span>
      </div>
      <ol className="max-h-[560px] space-y-0 overflow-y-auto p-4">
        {agentEvents.map((e) => (
          <li key={e.id} className="relative border-l border-border pb-4 pl-4 last:pb-0">
            <span className={`absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full ${dotFor[e.type]}`} />
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground">{e.agent}</span>
              <span className="font-data text-[11px] text-muted-foreground">{e.time}</span>
            </div>
            <p className="mt-0.5 text-xs uppercase tracking-wider text-muted-foreground">{e.type.replace('_', ' ')}</p>
            <p className="mt-1 text-sm leading-snug text-foreground">{e.text}</p>
          </li>
        ))}
      </ol>
    </aside>
  );
}
import React from 'react';
import { Bot } from 'lucide-react';

interface AgentTraceProps {
  agents: Array<{ name: string; confidence: number }>;
}

export default function AgentTrace({ agents }: AgentTraceProps) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
      <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Bot size={13} />
        Worked on by
      </span>
      {agents.map((a) => (
        <span
          key={`trace-${a.name}`}
          className="inline-flex items-center gap-1.5 rounded-md bg-automated/10 px-2 py-1 text-xs font-medium text-automated"
        >
          {a.name} agent
          <span className="font-data font-semibold">{a.confidence}%</span>
        </span>
      ))}
    </div>
  );
}
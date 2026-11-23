'use client';

import React, { useState } from 'react';
import { Sparkles, Send, Loader2 } from 'lucide-react';

const suggestions = [
  'Which projects are within 15% of their contingency limit?',
  'Show cases older than 20 days awaiting review',
  'What drove the largest EoT claims this quarter?',
];

export default function QueryBar() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);

  const run = (q: string) => {
    if (!q.trim()) return;
    setLoading(true);
    setAnswer(null);
    // Backend integration: send q to the deterministic query service; answer cites case IDs and BoQ lines.
    setTimeout(() => {
      setAnswer(
        'Raha Beach Promenade (91%) is the only project above 85% of contingency. Saadiyat Lagoons Infra follows at 73%. Source: cost sheets synced from Unifier at 07:30 GST.'
      );
      setLoading(false);
    }, 900);
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(query);
        }}
        className="flex items-center gap-3"
      >
        <Sparkles size={18} className="shrink-0 text-accent" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Ask a question about cases, projects and the portfolio"
          placeholder="Ask about cases, projects or the portfolio. Answers cite their sources."
          className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-foreground transition-all duration-150 hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          Ask
        </button>
      </form>
      <div className="mt-3 flex flex-wrap gap-2">
        {suggestions.map((s) => (
          <button
            key={`suggest-${s}`}
            type="button"
            onClick={() => {
              setQuery(s);
              run(s);
            }}
            className="rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-accent hover:text-accent"
          >
            {s}
          </button>
        ))}
      </div>
      {answer ? (
        <div className="fade-up mt-3 rounded-md border-l-2 border-accent bg-accent/5 px-3 py-2.5 text-sm text-foreground">
          {answer}
        </div>
      ) : null}
    </div>
  );
}
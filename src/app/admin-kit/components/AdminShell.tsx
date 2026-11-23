'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bot, ScrollText, Plug, BookOpen, Layers, Bell, FlaskConical } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import Icon from '@/components/ui/AppIcon';


const SECTIONS = [
  { href: '/admin-kit', label: 'Agents & Responsibilities', icon: Bot, exact: true },
  { href: '/admin-kit/rules', label: 'Rules & Versions', icon: ScrollText },
  { href: '/admin-kit/tools', label: 'Tools & Connections', icon: Plug },
  { href: '/admin-kit/reference-cases', label: 'Reference Cases & Learning', icon: BookOpen },
  { href: '/admin-kit/jobs', label: 'Background Jobs', icon: Layers },
  { href: '/admin-kit/notifications', label: 'Notifications & Workflows', icon: Bell },
  { href: '/admin-kit/evaluation', label: 'Evaluation & Run History', icon: FlaskConical },
];

export default function AdminShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    <AppLayout>
      <div className="space-y-5">
        <header>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Admin Kit</p>
          <p className="text-sm text-muted-foreground">Administrator controls for PVRAgent agents, rules, tools and workflows. Normal PVR users do not see this configuration.</p>
        </header>
        <nav className="flex flex-wrap gap-1 border-b border-border" aria-label="Admin Kit sections">
          {SECTIONS.map((s) => {
            const active = s.exact ? path === s.href || path.startsWith('/admin-kit/agents') : path.startsWith(s.href);
            const Icon = s.icon;
            return (
              <Link key={s.href} href={s.href} aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-semibold transition-colors ${active ? 'border-accent text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
                <Icon size={15} />{s.label}
              </Link>
            );
          })}
        </nav>
        {children}
      </div>
    </AppLayout>
  );
}

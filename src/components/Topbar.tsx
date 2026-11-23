'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Bell, Menu, Search, X } from 'lucide-react';
import AppLogo from '@/components/ui/AppLogo';

interface TopbarProps {
  collapsed: boolean;
}

const drawerLinks = [
  { href: '/', label: 'Portfolio' },
  { href: '/project-cases', label: 'Projects & PVRs' },
    { href: '/new-pvr', label: 'New PVR' },
  { href: '/admin-kit', label: 'Admin Kit' },
];

export default function Topbar({ collapsed }: TopbarProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);

  return (
    <>
      <header
        className={`fixed right-0 top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-card px-4 transition-[left] duration-300 ease-in-out left-0 ${
          collapsed ? 'md:left-16' : 'md:left-60'
        }`}
      >
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="rounded-md p-2 text-muted-foreground hover:bg-muted md:hidden"
          aria-label="Open navigation"
        >
          <Menu size={20} />
        </button>

        <div className="relative hidden max-w-xl flex-1 sm:block">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            aria-label="Search projects, PVRs and documents"
            placeholder="Search projects, PVRs, documents…"
            className="w-full rounded-md border border-input bg-card py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30"
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span className="hidden rounded-md bg-secondary px-2.5 py-1 text-sm font-medium text-secondary-foreground lg:inline">
            Prototype build · sample data only on request
          </span>

          <div className="relative">
            <button
              type="button"
              onClick={() => setBellOpen((v) => !v)}
              className="relative rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Notifications"
            >
              <Bell size={18} />
            </button>
            {bellOpen ? (
              <div className="absolute right-0 top-full mt-2 w-72 rounded-lg border border-border bg-card shadow-lg [animation:modalIn_0.15s_ease_both]">
                <p className="border-b border-border px-4 py-3 text-sm font-semibold text-foreground">Notifications</p>
                <p className="px-4 py-5 text-sm text-muted-foreground">No notifications. Alerts will appear here once notifications are connected.</p>
              </div>
            ) : null}
          </div>

          {/* sign-out link removed: sign-in is not required */}
        </div>
      </header>

      {drawerOpen ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <button type="button" aria-label="Close navigation" onClick={() => setDrawerOpen(false)} className="absolute inset-0 bg-foreground/50" />
          <div className="relative h-full w-72 bg-card shadow-xl">
            <div className="flex h-16 items-center justify-between border-b border-border px-4">
              <div className="flex items-center gap-2">
                <AppLogo size={32} />
                <span className="text-lg font-bold tracking-tight text-foreground">PVRAgent</span>
              </div>
              <button type="button" onClick={() => setDrawerOpen(false)} aria-label="Close" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted">
                <X size={18} />
              </button>
            </div>
            <ul className="p-3">
              {drawerLinks.map((l) => (
                <li key={`drawer-${l.href}`}>
                  <Link
                    href={l.href}
                    onClick={() => setDrawerOpen(false)}
                    className="block rounded-md px-3 py-2.5 text-sm font-medium text-foreground hover:bg-muted"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
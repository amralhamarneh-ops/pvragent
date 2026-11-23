'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutGrid, FolderKanban, FilePlus2, Library, Plug, ShieldCheck, ChevronsLeft, ChevronsRight,  } from 'lucide-react';
import Icon from '@/components/ui/AppIcon';


interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

interface NavItem {
  href: string | null;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  matches: string[];
}

const items: NavItem[] = [
  { href: '/', label: 'Portfolio', icon: LayoutGrid, matches: ['/'] },
  { href: '/project-cases', label: 'Projects & PVRs', icon: FolderKanban, matches: ['/project-cases', '/case-workspace', '/case-story'] },
  { href: '/new-pvr', label: 'New PVR', icon: FilePlus2, matches: ['/new-pvr'] },
  { href: '/admin-kit', label: 'Admin Kit', icon: ShieldCheck, matches: ['/admin-kit'] },
  { href: null, label: 'Project library', icon: Library, matches: [] },
  { href: null, label: 'Integrations', icon: Plug, matches: [] },
];

export default function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-30 hidden flex-col bg-sidebar text-sidebar-foreground transition-[width] duration-300 ease-in-out md:flex ${
        collapsed ? 'w-16' : 'w-60'
      }`}
    >
      <div className={`flex h-16 items-center ${collapsed ? 'justify-center px-0' : 'px-5'}`}>
        <span className="text-xl font-bold tracking-tight text-white">
          {collapsed ? 'P' : <>PVR<span className="text-[#7fe0e0]">Agent</span></>}
        </span>
      </div>

      {!collapsed ? (
        <div className="border-y border-sidebar-border px-5 py-3">
          <p className="font-semibold text-white">Aldar Projects</p>
          <p className="text-sm text-sidebar-muted">Construction variations</p>
        </div>
      ) : null}

      <nav className="flex-1 overflow-y-auto px-2 py-4" aria-label="Main">
        <ul className="space-y-1">
          {items.map((item) => {
            const active = item.matches.some((m) => (m === '/' ? pathname === '/' : pathname === m || pathname.startsWith(m + '/')));
            const Icon = item.icon;
            const base = `flex items-center rounded-md py-2.5 font-medium transition-colors duration-150 ${collapsed ? 'justify-center px-0' : 'gap-3 px-3'}`;
            if (!item.href) {
              return (
                <li key={item.label}>
                  <span
                    aria-disabled="true"
                    title={`${item.label} is not built yet`}
                    className={`${base} cursor-not-allowed text-sidebar-muted/70`}
                  >
                    <Icon size={18} className="shrink-0" />
                    {!collapsed ? (
                      <>
                        <span className="flex-1 truncate">{item.label}</span>
                        <span className="rounded-full border border-sidebar-border px-2 py-0.5 text-xs font-medium text-sidebar-muted">Not built</span>
                      </>
                    ) : null}
                  </span>
                </li>
              );
            }
            return (
              <li key={item.label}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  title={collapsed ? item.label : undefined}
                  className={`${base} ${active ? 'bg-sidebar-active text-white shadow-[inset_3px_0_0_#2cc4c4]' : 'text-sidebar-foreground hover:bg-sidebar-active/60 hover:text-white'}`}
                >
                  <Icon size={18} className="shrink-0" />
                  {!collapsed ? <span className="flex-1 truncate">{item.label}</span> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-sidebar-border p-3">
        <div className={`flex items-center ${collapsed ? 'justify-center' : 'justify-between'}`}>
          {!collapsed ? (
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-sidebar-active text-xs font-bold text-white">SR</div>
              <div className="leading-tight">
                <p className="text-sm font-semibold text-white">Sara Al Rumaithi</p>
                <p className="text-xs text-sidebar-muted">Commercial Manager</p>
              </div>
            </div>
          ) : null}
          <button
            type="button"
            onClick={onToggle}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="rounded-md p-1.5 text-sidebar-muted transition-colors hover:bg-sidebar-active/60 hover:text-white"
          >
            {collapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}
          </button>
        </div>
      </div>
    </aside>
  );
}
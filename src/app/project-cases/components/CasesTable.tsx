'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Search,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Eye,
  Pencil,
  Trash2,
  Download,
  UserCheck,
  FileSearch,
  X,
} from 'lucide-react';
import Badge, { statusTone } from '@/components/ui/Badge';
import ConfidenceBar from '@/components/ui/ConfidenceBar';
import EmptyState from '@/components/ui/EmptyState';
import { cases as seedCases, statusOptions, formatAEDFull, type CaseStatus, type PvrCase } from '@/lib/mockData';

type SortKey = 'ref' | 'netCost' | 'eotDays' | 'confidence' | 'ageDays';

const columnDefs = [
  { key: 'ref', label: 'Ref' },
  { key: 'title', label: 'Change' },
  { key: 'changeType', label: 'Type' },
  { key: 'zone', label: 'Zone' },
  { key: 'discipline', label: 'Discipline' },
  { key: 'status', label: 'Status' },
  { key: 'netCost', label: 'Net cost' },
  { key: 'eotDays', label: 'EoT' },
  { key: 'confidence', label: 'Confidence' },
  { key: 'ageDays', label: 'Age' },
] as const;

type ColKey = (typeof columnDefs)[number]['key'];

export default function CasesTable() {
  const [rows, setRows] = useState<PvrCase[]>(seedCases);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [typeFilter, setTypeFilter] = useState<string>('All');
  const [sortKey, setSortKey] = useState<SortKey>('ageDays');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [selected, setSelected] = useState<string[]>([]);
  const [visible, setVisible] = useState<Record<ColKey, boolean>>({
    ref: true, title: true, changeType: true, zone: true, discipline: true,
    status: true, netCost: true, eotDays: true, confidence: true, ageDays: true,
  });
  const [colMenu, setColMenu] = useState(false);
  const [statusMenuFor, setStatusMenuFor] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(8);
  const [removing, setRemoving] = useState<string[]>([]);

  const types = useMemo(() => ['All', ...Array.from(new Set(seedCases.map((c) => c.changeType)))], []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = rows.filter((c) => {
      const matchQ = !q || c.title.toLowerCase().includes(q) || c.ref.toLowerCase().includes(q) || c.zone.toLowerCase().includes(q);
      const matchS = statusFilter === 'All' || c.status === statusFilter;
      const matchT = typeFilter === 'All' || c.changeType === typeFilter;
      return matchQ && matchS && matchT;
    });
    return [...list].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp = typeof av === 'string' && typeof bv === 'string' ? av.localeCompare(bv) : (av as number) - (bv as number);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [rows, search, statusFilter, typeFilter, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const allOnPage = pageRows.length > 0 && pageRows.every((r) => selected.includes(r.id));

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const toggleRow = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const toggleAll = () => {
    if (allOnPage) setSelected((s) => s.filter((id) => !pageRows.some((r) => r.id === id)));
    else setSelected((s) => Array.from(new Set([...s, ...pageRows.map((r) => r.id)])));
  };

  const changeStatus = (id: string, status: CaseStatus) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, status } : r)));
    setStatusMenuFor(null);
  };

  const deleteSelected = () => {
    setRemoving(selected);
    setTimeout(() => {
      setRows((rs) => rs.filter((r) => !selected.includes(r.id)));
      setSelected([]);
      setRemoving([]);
    }, 280);
  };

  const SortHead = ({ k, label, align }: { k: SortKey; label: string; align?: 'right' }) => (
    <button
      type="button"
      onClick={() => toggleSort(k)}
      className={`inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wider transition-colors hover:text-foreground ${
        sortKey === k ? 'text-accent' : 'text-muted-foreground'
      } ${align === 'right' ? 'ml-auto' : ''}`}
    >
      {label}
      {sortKey === k ? (sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : null}
    </button>
  );

  return (
    <div className="relative rounded-lg border border-border bg-card">
      <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center">
        <div className="relative flex-1 lg:max-w-sm">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            aria-label="Search cases"
            placeholder="Search by ref, title or zone"
            className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30"
          />
        </div>

        <select
          aria-label="Filter by status"
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30"
        >
          <option value="All">All statuses</option>
          {statusOptions.map((s) => (
            <option key={`status-opt-${s}`} value={s}>{s}</option>
          ))}
        </select>

        <select
          aria-label="Filter by change type"
          value={typeFilter}
          onChange={(e) => {
            setTypeFilter(e.target.value);
            setPage(1);
          }}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30"
        >
          {types.map((t) => (
            <option key={`type-opt-${t}`} value={t}>{t === 'All' ? 'All change types' : t}</option>
          ))}
        </select>

        <div className="relative lg:ml-auto">
          <button
            type="button"
            onClick={() => setColMenu((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            <Columns3 size={15} />
            Columns
          </button>
          {colMenu ? (
            <div className="absolute right-0 top-full z-20 mt-2 w-52 rounded-lg border border-border bg-card p-2 shadow-lg [animation:modalIn_0.15s_ease_both]">
              {columnDefs.map((c) => (
                <label key={`col-${c.key}`} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                  <input
                    type="checkbox"
                    checked={visible[c.key]}
                    onChange={() => setVisible((v) => ({ ...v, [c.key]: !v[c.key] }))}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                  {c.label}
                </label>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="p-6">
          <EmptyState
            icon={<FileSearch size={22} />}
            title="No PVRs match these filters"
            description="Clear the search or status filter to see all cases on this project, or start a new PVR case from an evidence pack."
            actionLabel="Clear filters"
            onAction={() => {
              setSearch('');
              setStatusFilter('All');
              setTypeFilter('All');
            }}
          />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left">
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label="Select all rows on this page"
                    checked={allOnPage}
                    onChange={toggleAll}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                </th>
                {visible.ref ? <th className="px-3 py-3"><SortHead k="ref" label="Ref" /></th> : null}
                {visible.title ? <th className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Change</th> : null}
                {visible.changeType ? <th className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Type</th> : null}
                {visible.zone ? <th className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Zone</th> : null}
                {visible.discipline ? <th className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Discipline</th> : null}
                {visible.status ? <th className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</th> : null}
                {visible.netCost ? <th className="px-3 py-3 text-right"><SortHead k="netCost" label="Net cost" align="right" /></th> : null}
                {visible.eotDays ? <th className="px-3 py-3 text-right"><SortHead k="eotDays" label="EoT" align="right" /></th> : null}
                {visible.confidence ? <th className="px-3 py-3"><SortHead k="confidence" label="Confidence" /></th> : null}
                {visible.ageDays ? <th className="px-3 py-3 text-right"><SortHead k="ageDays" label="Age" align="right" /></th> : null}
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {pageRows.map((c) => {
                const isSel = selected.includes(c.id);
                const leaving = removing.includes(c.id);
                return (
                  <tr
                    key={c.id}
                    className={`group border-b border-border transition-all duration-300 last:border-b-0 hover:bg-muted/50 ${
                      isSel ? 'bg-accent/5' : ''
                    } ${leaving ? 'opacity-0' : 'opacity-100'}`}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        aria-label={`Select ${c.ref}`}
                        checked={isSel}
                        onChange={() => toggleRow(c.id)}
                        className="h-4 w-4 accent-[var(--accent)]"
                      />
                    </td>
                    {visible.ref ? <td className="font-data px-3 py-3 font-semibold text-foreground">{c.ref}</td> : null}
                    {visible.title ? (
                      <td className="max-w-[280px] px-3 py-3">
                        <Link href="/case-story" className="line-clamp-2 font-medium text-foreground hover:text-accent hover:underline">
                          {c.title}
                        </Link>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">Requested by {c.requester}</p>
                      </td>
                    ) : null}
                    {visible.changeType ? <td className="px-3 py-3 text-muted-foreground">{c.changeType}</td> : null}
                    {visible.zone ? <td className="px-3 py-3 text-muted-foreground">{c.zone}</td> : null}
                    {visible.discipline ? <td className="px-3 py-3 text-muted-foreground">{c.discipline}</td> : null}
                    {visible.status ? (
                      <td className="relative px-3 py-3">
                        <button
                          type="button"
                          onClick={() => setStatusMenuFor(statusMenuFor === c.id ? null : c.id)}
                          aria-label={`Change status of ${c.ref}`}
                          className="transition-transform active:scale-95"
                        >
                          <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                        </button>
                        {statusMenuFor === c.id ? (
                          <div className="absolute left-3 top-full z-20 mt-1 w-52 rounded-lg border border-border bg-card p-1.5 shadow-lg [animation:modalIn_0.15s_ease_both]">
                            {statusOptions.map((s) => (
                              <button
                                key={`${c.id}-status-${s}`}
                                type="button"
                                onClick={() => changeStatus(c.id, s)}
                                className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-muted"
                              >
                                {s}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </td>
                    ) : null}
                    {visible.netCost ? (
                      <td className={`font-data px-3 py-3 text-right font-semibold ${c.netCost < 0 ? 'text-success' : 'text-foreground'}`}>
                        {formatAEDFull(c.netCost)}
                      </td>
                    ) : null}
                    {visible.eotDays ? (
                      <td className={`font-data px-3 py-3 text-right ${c.eotDays > 20 ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>
                        {c.eotDays > 0 ? `+${c.eotDays}` : c.eotDays} d
                      </td>
                    ) : null}
                    {visible.confidence ? <td className="px-3 py-3"><ConfidenceBar value={c.confidence} /></td> : null}
                    {visible.ageDays ? (
                      <td className={`font-data px-3 py-3 text-right ${c.ageDays > 20 && c.status === 'Awaiting Review' ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>
                        {c.ageDays} d
                      </td>
                    ) : null}
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                        <Link href="/case-story" aria-label={`View ${c.ref}`} title="Open case story" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                          <Eye size={15} />
                        </Link>
                        <Link href="/intake-confirmation" aria-label={`Edit ${c.ref}`} title="Edit extracted fields" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                          <Pencil size={15} />
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-col items-center justify-between gap-3 border-t border-border px-4 py-3 sm:flex-row">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Rows per page</span>
          <select
            aria-label="Rows per page"
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
          >
            {[5, 8, 12].map((n) => (
              <option key={`size-${n}`} value={n}>{n}</option>
            ))}
          </select>
          <span className="font-data">
            {filtered.length === 0 ? 0 : (safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, filtered.length)} of {filtered.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={safePage === 1}
            onClick={() => setPage(safePage - 1)}
            aria-label="Previous page"
            className="rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft size={16} />
          </button>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
            <button
              key={`page-${n}`}
              type="button"
              onClick={() => setPage(n)}
              className={`font-data h-8 w-8 rounded-md text-sm transition-colors ${
                n === safePage ? 'bg-primary font-semibold text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {n}
            </button>
          ))}
          <button
            type="button"
            disabled={safePage === totalPages}
            onClick={() => setPage(safePage + 1)}
            aria-label="Next page"
            className="rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {selected.length > 0 ? (
        <div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-lg bg-primary px-4 py-3 text-primary-foreground shadow-xl [animation:slideUpBar_0.25s_ease_both]">
          <span className="font-data text-sm font-semibold">{selected.length} selected</span>
          <span className="h-4 w-px bg-primary-foreground/30" />
          <button type="button" className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium transition-colors hover:bg-primary-foreground/10">
            <UserCheck size={15} /> Assign reviewer
          </button>
          <button type="button" className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium transition-colors hover:bg-primary-foreground/10">
            <Download size={15} /> Export XLSX
          </button>
          <button type="button" onClick={deleteSelected} className="inline-flex items-center gap-1.5 rounded-md px-2py-1 text-sm font-medium text-destructive-foreground transition-colors bg-destructive hover:opacity-90">
            <Trash2 size={15} /> Delete
          </button>
          <button
            type="button"
            onClick={() => setSelected([])}
            aria-label="Clear selection"
            className="rounded-md p-1 transition-colors hover:bg-primary-foreground/10"
          >
            <X size={15} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
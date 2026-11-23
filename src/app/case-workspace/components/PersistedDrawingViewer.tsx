'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, Layers, Maximize2, Minimize2, Minus, Plus, ScanSearch } from 'lucide-react';
import type { DxfCoverage, PolyGeo, PreviewKind } from '@/lib/drawings/jobView';

export interface PaneGeometry { layers: Record<string, PolyGeo[]>; delivered: number; total: number; extents: { minX: number; minY: number; maxX: number; maxY: number } | null }

interface Props {
  title: string;
  /** The drawing being shown (original or the only drawing). */
  primary: PaneGeometry | null;
  primaryName: string;
  /** Counterpart revision, when paired. */
  secondary?: PaneGeometry | null;
  secondaryName?: string;
  coverage?: DxfCoverage;
  preview: { kind: PreviewKind; label: string; detail: string };
  /** Bounding box (drawing units) of the geometry behind a selected measured change, for fit-to-change. */
  changeBox?: { minX: number; minY: number; maxX: number; maxY: number } | null;
  changeLabel?: string;
}

type Vp = { x: number; y: number; w: number; h: number };
type Mode = 'single' | 'before_after' | 'overlay';

const fit = (e: { minX: number; minY: number; maxX: number; maxY: number } | null, pad = 0.05): Vp => {
  if (!e) return { x: 0, y: 0, w: 100, h: 100 };
  const w = Math.max(e.maxX - e.minX, 1e-6); const h = Math.max(e.maxY - e.minY, 1e-6);
  return { x: e.minX - w * pad, y: -(e.maxY + h * pad), w: w * (1 + 2 * pad), h: h * (1 + 2 * pad) };
};
const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#dc2626', '#4d7c0f', '#be185d'];

function Pane({ geo, hidden, vp, setVp, tint, label, fill, dashed }: { geo: PaneGeometry | null; hidden: Set<string>; vp: Vp; setVp: (v: Vp) => void; tint?: string; label: string; fill: boolean; dashed?: boolean }) {
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; vp: Vp } | null>(null);
  const names = useMemo(() => Object.keys(geo?.layers ?? {}).sort(), [geo]);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const h = (ev: WheelEvent) => {
      ev.preventDefault();
      const r = el.getBoundingClientRect(); const k = Math.max(vp.w / r.width, vp.h / r.height);
      const wx = vp.x + (ev.clientX - r.left) * k; const wy = vp.y + (ev.clientY - r.top) * k;
      const f = ev.deltaY < 0 ? 1 / 1.2 : 1.2;
      setVp({ x: wx - (wx - vp.x) * f, y: wy - (wy - vp.y) * f, w: vp.w * f, h: vp.h * f });
    };
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  }, [vp, setVp]);
  const stroke = Math.max(vp.w, vp.h) / 700;
  return (
    <div className="relative min-w-0 flex-1">
      <p className="pointer-events-none absolute left-2 top-2 z-10 max-w-[90%] truncate rounded bg-card/90 px-2 py-0.5 text-xs font-semibold text-foreground shadow-sm">{label}</p>
      <svg ref={ref} role="img" aria-label={`${label} geometry`} viewBox={`${vp.x} ${vp.y} ${vp.w} ${vp.h}`} preserveAspectRatio="xMidYMid meet"
        className={`block w-full cursor-grab touch-none select-none rounded-md border border-border bg-background active:cursor-grabbing ${fill ? 'h-full min-h-[480px]' : 'h-[380px]'}`}
        onPointerDown={(e) => { (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, vp }; }}
        onPointerMove={(e) => { const d = drag.current; const r = ref.current?.getBoundingClientRect(); if (!d || !r) return; const k = Math.max(d.vp.w / r.width, d.vp.h / r.height); setVp({ ...d.vp, x: d.vp.x - (e.clientX - d.x) * k, y: d.vp.y - (e.clientY - d.y) * k }); }}
        onPointerUp={() => { drag.current = null; }}>
        {names.filter((n) => !hidden.has(n)).map((n, i) => (
          <g key={n} stroke={tint ?? PALETTE[i % PALETTE.length]} strokeWidth={stroke} fill="none" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={dashed ? `${stroke * 6} ${stroke * 4}` : undefined} opacity={tint ? 0.9 : 1}>
            {geo!.layers[n].map((g, k) => <polyline key={k} points={g.points.map(([x, y]) => `${x},${-y}`).join(' ')} />)}
          </g>
        ))}
      </svg>
    </div>
  );
}

/**
 * Viewer for geometry the background job actually processed. The banner states exactly what is shown (partial /
 * supported geometry only / replay) and never presents a partial DXF rendering as the complete CAD content.
 */
export default function PersistedDrawingViewer({ title, primary, primaryName, secondary = null, secondaryName = '', coverage, preview, changeBox = null, changeLabel }: Props) {
  const [mode, setMode] = useState<Mode>(secondary ? 'overlay' : 'single');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [full, setFull] = useState(false);
  const extent = useMemo(() => {
    const a = primary?.extents; const b = secondary?.extents;
    if (a && b) return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
    return a ?? b ?? null;
  }, [primary, secondary]);
  const [vp, setVp] = useState<Vp>(() => fit(extent));
  const [vp2, setVp2] = useState<Vp>(() => fit(extent));
  const moved = useRef(false);
  const fittedFor = useRef('');
  // Fit once per drawing; later batches never reset a viewport the user has moved.
  useEffect(() => {
    const key = `${primaryName}|${secondaryName}`;
    if (extent && (fittedFor.current !== key || !moved.current)) { const v = fit(extent); setVp(v); setVp2(v); fittedFor.current = key; }
  }, [extent, primaryName, secondaryName]);
  useEffect(() => { setMode(secondary ? 'overlay' : 'single'); setHidden(new Set()); moved.current = false; }, [primaryName, secondaryName, secondary]);

  const userVp = useCallback((v: Vp) => { moved.current = true; setVp(v); setVp2(v); }, []);
  const zoom = (f: number) => userVp({ x: vp.x + (vp.w - vp.w * f) / 2, y: vp.y + (vp.h - vp.h * f) / 2, w: vp.w * f, h: vp.h * f });
  const layerNames = useMemo(() => { const s = new Set<string>(); for (const g of [primary, secondary]) if (g) Object.keys(g.layers).forEach((k) => s.add(k)); return [...s].sort(); }, [primary, secondary]);
  const toggle = (n: string) => setHidden((h) => { const x = new Set(h); if (x.has(n)) x.delete(n); else x.add(n); return x; });
  const tone = preview.kind === 'partial' ? 'border-warning bg-warning/10' : preview.kind === 'replay' ? 'border-accent bg-accent/10' : preview.kind === 'none' ? 'border-border bg-muted' : 'border-border bg-card';

  return (
    <div className={`${full ? 'fixed inset-0 z-50 overflow-auto bg-background p-4' : ''}`}>
      <div className="rounded-lg border border-border bg-card p-3 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-foreground">{title}</h4>
          <div className="flex flex-wrap items-center gap-1">
            {secondary ? (['single', 'before_after', 'overlay'] as Mode[]).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m} className={`rounded border px-2 py-1 text-xs ${mode === m ? 'border-primary bg-primary text-primary-foreground' : 'border-input hover:bg-muted'}`}>{m === 'single' ? 'Original only' : m === 'before_after' ? 'Before / after' : 'Overlay'}</button>
            )) : null}
            <button type="button" onClick={() => { moved.current = false; const v = fit(extent); setVp(v); setVp2(v); }} className="inline-flex items-center gap-1 rounded border border-input px-2 py-1 text-xs hover:bg-muted" aria-label="Fit whole drawing"><ScanSearch size={13} aria-hidden />Fit drawing</button>
            <button type="button" disabled={!changeBox} onClick={() => { if (changeBox) userVp(fit(changeBox, 0.35)); }} className="inline-flex items-center gap-1 rounded border border-input px-2 py-1 text-xs hover:bg-muted disabled:opacity-50" aria-label="Fit to change"><Crosshair size={13} aria-hidden />Fit to change</button>
            <button type="button" onClick={() => zoom(1 / 1.4)} className="rounded border border-input p-1 hover:bg-muted" aria-label="Zoom in"><Plus size={14} /></button>
            <button type="button" onClick={() => zoom(1.4)} className="rounded border border-input p-1 hover:bg-muted" aria-label="Zoom out"><Minus size={14} /></button>
            <button type="button" onClick={() => setFull((v) => !v)} className="rounded border border-input p-1 hover:bg-muted" aria-label={full ? 'Exit full screen' : 'Full screen'}>{full ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
          </div>
        </div>
        <p role="status" className={`mt-2 rounded border px-3 py-1.5 text-xs ${tone}`}><span className="font-semibold text-foreground">{preview.label}.</span> <span className="text-muted-foreground">{preview.detail}</span>{primary && primary.total > 0 ? <span className="ml-1 font-data text-muted-foreground">{primary.delivered}/{primary.total} geometry entities received.</span> : null}</p>
        {changeLabel ? <p className="mt-1 text-xs text-muted-foreground">Selected change: {changeLabel}</p> : null}
        <div className="mt-2 flex flex-col gap-2 lg:flex-row">
          <div className="min-w-0 flex-1">
            <div className={`flex gap-2 ${mode === 'before_after' ? 'flex-col md:flex-row' : ''}`}>
              {mode === 'overlay' && secondary ? (
                <div className="relative min-w-0 flex-1">
                  <Pane geo={primary} hidden={hidden} vp={vp} setVp={userVp} tint="#dc2626" label={`Overlay: ${primaryName} (red) over ${secondaryName} (green)`} fill={full} />
                  <div className="pointer-events-none absolute inset-0 top-0"><OverlayTop geo={secondary} hidden={hidden} vp={vp} /></div>
                </div>
              ) : mode === 'before_after' && secondary ? (
                <>
                  <Pane geo={primary} hidden={hidden} vp={vp} setVp={userVp} label={`Before: ${primaryName}`} fill={full} />
                  <Pane geo={secondary} hidden={hidden} vp={vp2} setVp={userVp} label={`After: ${secondaryName}`} fill={full} />
                </>
              ) : (
                <Pane geo={primary} hidden={hidden} vp={vp} setVp={userVp} label={primaryName} fill={full} />
              )}
            </div>
          </div>
          <aside className="w-full shrink-0 lg:w-52" aria-label="Layers">
            <p className="flex items-center gap-1 text-xs font-semibold text-foreground"><Layers size={13} aria-hidden />Layers ({layerNames.length})</p>
            <ul className="mt-1 max-h-72 space-y-0.5 overflow-auto text-xs">
              {layerNames.map((n) => (
                <li key={n}><label className="flex cursor-pointer items-center gap-1.5"><input type="checkbox" checked={!hidden.has(n)} onChange={() => toggle(n)} /><span className="truncate text-foreground">{n}</span><span className="ml-auto font-data text-muted-foreground">{(primary?.layers[n]?.length ?? 0) + (secondary?.layers[n]?.length ?? 0)}</span></label></li>
              ))}
              {layerNames.length === 0 ? <li className="text-muted-foreground">No layers received yet.</li> : null}
            </ul>
          </aside>
        </div>
        {coverage && !coverage.complete ? (
          <div className="mt-2 rounded border border-warning/50 bg-warning/10 px-3 py-2 text-xs text-foreground">
            <p className="font-semibold">Coverage limitation</p>
            <p className="text-muted-foreground">{coverage.scope}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function OverlayTop({ geo, hidden, vp }: { geo: PaneGeometry | null; hidden: Set<string>; vp: Vp }) {
  const stroke = Math.max(vp.w, vp.h) / 700;
  return (
    <svg viewBox={`${vp.x} ${vp.y} ${vp.w} ${vp.h}`} preserveAspectRatio="xMidYMid meet" className="block h-full w-full" aria-hidden>
      {Object.keys(geo?.layers ?? {}).filter((n) => !hidden.has(n)).map((n) => (
        <g key={n} stroke="#16a34a" strokeWidth={stroke} fill="none" opacity={0.75} strokeDasharray={`${stroke * 6} ${stroke * 4}`}>{geo!.layers[n].map((g, k) => <polyline key={k} points={g.points.map(([x, y]) => `${x},${-y}`).join(' ')} />)}</g>
      ))}
    </svg>
  );
}

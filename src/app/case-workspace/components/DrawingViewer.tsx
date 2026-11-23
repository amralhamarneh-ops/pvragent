'use client';

import React, { useMemo, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { buildFahidDrawings, entityBBox, type DrawingSet, type DxfEntity } from '@/lib/mapping/drawingEngine';
import type { DrawingChange } from '@/lib/mapping/types';

type View = 'before' | 'after' | 'overlay' | 'swipe';

interface DrawingViewerProps {
  changes: DrawingChange[];
  focusId: string | null;
  onFocus: (id: string | null) => void;
  measureMode: boolean;
  onMeasured: (meters: number) => void;
}

const COLORS = { added: '#1f7a74', removed: '#b3261e', modified: '#d98e04', unchanged: '#8a97a8' };
const W = 760;
const H = 300;

function project(x: number, y: number): [number, number] {
  return [30 + (x / 7000) * (W - 60), H / 2 - y * 1.1];
}

function drawEntity(e: DxfEntity, color: string, key: string, width = 2, dashed = false): React.ReactNode {
  if ((e.kind === 'LWPOLYLINE' || e.kind === 'LINE') && e.vertices) {
    if (e.layer.endsWith('PAVE')) {
      const pts = e.vertices.map((v) => project(v.x, v.y * 1.5).join(',')).join(' ');
      return <polygon key={key} points={pts} fill={color} fillOpacity={0.18} stroke={color} strokeWidth={1} />;
    }
    const pts = e.vertices.map((v) => project(v.x, v.y).join(',')).join(' ');
    return <polyline key={key} points={pts} fill="none" stroke={color} strokeWidth={width} strokeDasharray={dashed ? '5 4' : undefined} />;
  }
  if (e.kind === 'INSERT' && e.center) {
    const [cx, cy] = project(e.center.x, e.center.y + (e.layer.endsWith('LIGHT') ? -12 : 0));
    return e.layer.endsWith('TEMP') ? <circle key={key} cx={cx} cy={cy} r={8} fill="none" stroke={color} strokeWidth={2} /> : <circle key={key} cx={cx} cy={cy} r={2.2} fill={color} />;
  }
  return null;
}

export default function DrawingViewer({ changes, focusId, onFocus, measureMode, onMeasured }: DrawingViewerProps) {
  const [view, setView] = useState<View>('overlay');
  const [swipe, setSwipe] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [layers, setLayers] = useState<Record<string, boolean>>({ 'R4-ROAD-CL': true, 'R4-PAVE': true, 'R4-KERB': true, 'R4-LIGHT': true, 'R4-TEMP': true, 'R4-BARRIER': true });
  const [pts, setPts] = useState<{ x: number; y: number }[]>([]);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const { revB, revC } = useMemo(() => buildFahidDrawings(), []);
  const focus = changes.find((c) => c.id === focusId);

  const diffKeys = useMemo(() => {
    const bh = new Set(revB.entities.map((e) => e.handle));
    const ch = new Set(revC.entities.map((e) => e.handle));
    return { added: new Set(revC.entities.filter((e) => !bh.has(e.handle)).map((e) => e.handle)), removed: new Set(revB.entities.filter((e) => !ch.has(e.handle)).map((e) => e.handle)), modified: new Set(['2B']) };
  }, [revB, revC]);

  const render = (set: DrawingSet, mode: 'before' | 'after' | 'overlay') =>
    set.entities
      .filter((e) => layers[e.layer] !== false)
      .map((e) => {
        let color = COLORS.unchanged;
        let w = 1.6;
        if (mode !== 'before' && diffKeys.added.has(e.handle)) { color = COLORS.added; w = 2.6; }
        if (mode !== 'after' && diffKeys.removed.has(e.handle)) { color = COLORS.removed; w = 2.6; }
        if (diffKeys.modified.has(e.handle) && mode !== 'before') { color = COLORS.modified; w = 2.6; }
        return drawEntity(e, color, `${mode}-${e.handle}`, w, mode === 'overlay' && diffKeys.removed.has(e.handle));
      });

  const removedOnly = revB.entities.filter((e) => diffKeys.removed.has(e.handle) && layers[e.layer] !== false);

  const onClick = (ev: React.MouseEvent<SVGSVGElement>) => {
    if (!measureMode) return;
    const r = ev.currentTarget.getBoundingClientRect();
    const sx = ((ev.clientX - r.left) / r.width) * W;
    const mx = ((sx - 30) / (W - 60)) * 7000;
    const next = [...pts, { x: mx, y: 0 }].slice(-2);
    setPts(next);
    if (next.length === 2) onMeasured(Math.round(Math.abs(next[1].x - next[0].x)));
  };

  const fb = focus ? (() => { const [x, y] = project(focus.bbox.x, 0); const [x2] = project(focus.bbox.x + focus.bbox.w, 0); return { x, y: y - 40, w: Math.max(16, x2 - x), h: 80 }; })() : null;

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-3">
        <div role="tablist" aria-label="Drawing view" className="inline-flex rounded-md border border-border bg-background p-0.5">
          {(['before', 'after', 'overlay', 'swipe'] as View[]).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} type="button" onClick={() => setView(v)} className={`rounded px-3 py-1.5 font-medium capitalize ${view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>{v}</button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(1, z - 0.5))} className="rounded-md border border-input p-1.5 hover:bg-muted"><Minus size={14} /></button>
          <span className="w-12 text-center font-data text-sm text-muted-foreground">{Math.round(zoom * 100)}%</span>
          <button type="button" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(4, z + 0.5))} className="rounded-md border border-input p-1.5 hover:bg-muted"><Plus size={14} /></button>
        </div>
      </div>

      <div className="relative overflow-hidden bg-background" style={{ cursor: measureMode ? 'crosshair' : zoom > 1 ? 'grab' : 'default' }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block w-full select-none"
          role="img"
          aria-label="Drawing R4-CIV-101 comparing Rev B and Rev C"
          onClick={onClick}
          onMouseDown={(e) => { if (zoom > 1 && !measureMode) dragRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }; }}
          onMouseMove={(e) => { if (dragRef.current) setPan({ x: e.clientX - dragRef.current.x, y: e.clientY - dragRef.current.y }); }}
          onMouseUp={() => { dragRef.current = null; }}
          onMouseLeave={() => { dragRef.current = null; }}
        >
          <defs>
            <clipPath id="clip-left"><rect x="0" y="0" width={(W * swipe) / 100} height={H} /></clipPath>
            <clipPath id="clip-right"><rect x={(W * swipe) / 100} y="0" width={W} height={H} /></clipPath>
          </defs>
          <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`} style={{ transformOrigin: '50% 50%' }}>
            {[1000, 2000, 3000, 4000, 5000, 6000, 7000].map((m) => {
              const [x] = project(m, 0);
              return (
                <g key={m}>
                  <line x1={x} y1={20} x2={x} y2={H - 30} stroke="#e1e7ee" strokeWidth={1} />
                  <text x={x} y={H - 14} fontSize={11} textAnchor="middle" fill="#5b6b80">CH {m / 1000}+000</text>
                </g>
              );
            })}
            {view === 'before' ? render(revB, 'before') : null}
            {view === 'after' ? render(revC, 'after') : null}
            {view === 'overlay' ? <>{render(revC, 'overlay')}{removedOnly.map((e) => drawEntity(e, COLORS.removed, `rm-${e.handle}`, 2.6, true))}</> : null}
            {view === 'swipe' ? <><g clipPath="url(#clip-left)">{render(revB, 'before')}</g><g clipPath="url(#clip-right)">{render(revC, 'after')}</g></> : null}
            {fb ? <rect x={fb.x - 4} y={fb.y} width={fb.w + 8} height={fb.h} fill="none" stroke="#d98e04" strokeWidth={2} strokeDasharray="6 4" /> : null}
            {pts.map((p, i) => { const [x, y] = project(p.x, 0); return <circle key={i} cx={x} cy={y} r={4} fill="#d98e04" />; })}
          </g>
          {view === 'swipe' ? <line x1={(W * swipe) / 100} y1={0} x2={(W * swipe) / 100} y2={H} stroke="#14213d" strokeWidth={2} /> : null}
        </svg>
        {view === 'swipe' ? (
          <input type="range" min={0} max={100} value={swipe} onChange={(e) => setSwipe(Number(e.target.value))} aria-label="Swipe between Rev B and Rev C" className="absolute bottom-2 left-1/2 w-64 -translate-x-1/2 accent-[var(--primary)]" />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-3">
        <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
          {[['Added', COLORS.added], ['Removed', COLORS.removed], ['Modified', COLORS.modified], ['Unchanged', COLORS.unchanged]].map(([l, c]) => (
            <span key={l} className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: c }} />{l}</span>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {Object.keys(layers).map((l) => (
            <label key={l} className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-1 text-sm">
              <input type="checkbox" checked={layers[l]} onChange={() => setLayers((s) => ({ ...s, [l]: !s[l] }))} className="accent-[var(--accent)]" />
              <span className="font-data">{l.replace('R4-', '')}</span>
            </label>
          ))}
        </div>
      </div>
      {measureMode ? <p role="status" className="border-t border-border bg-warning/10 px-4 py-2 text-foreground">Click two points along the road to measure. {pts.length === 2 ? `Measured ${Math.round(Math.abs(pts[1].x - pts[0].x)).toLocaleString('en-US')} m.` : `${pts.length} of 2 points placed.`}</p> : null}
      {focusId ? <button type="button" onClick={() => onFocus(null)} className="m-3 rounded-md border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted">Clear focus</button> : null}
    </div>
  );
}

export { entityBBox };

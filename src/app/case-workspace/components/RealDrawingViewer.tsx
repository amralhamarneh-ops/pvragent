'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Crosshair, Expand, Layers, Maximize2, Minimize2, Minus, Plus, ScanSearch, Search } from 'lucide-react';
import { detailWindows, entitiesBox, fitViewport, pixelToWorld, zoomAt, type DiffState, type LiveModel, type ViewEntity, type ViewModel, type Viewport } from '@/lib/drawings/viewModel';
import type { ReconciledChange } from '@/lib/drawings/types';

export type ViewMode = 'original' | 'revised' | 'overlay' | 'side';

interface Props {
  /** Comparison model. Null while a live run has geometry but nothing has been compared yet. */
  model: ViewModel | null;
  /** Geometry received so far in a running analysis (drawn before any comparison exists). */
  live?: LiveModel | null;
  /** True while geometry is still arriving; the viewport is then never reset by new batches. */
  streaming?: boolean;
  changes: ReconciledChange[];
  selectedChangeId: string | null;
  onSelectChange: (id: string | null) => void;
  /** Layers revealed so far during a labelled Replay; null shows every layer. */
  revealedLayers?: string[] | null;
  replaying?: boolean;
  /** Reports how many entities the viewer is actually drawing, for status only. */
  onRendered?: (info: { entities: number }) => void;
}

const STATE_STYLE: Record<DiffState, { stroke: string; width: number; opacity: number; dash?: string }> = {
  unchanged: { stroke: 'var(--muted-foreground, #64748b)', width: 1.2, opacity: 0.55 },
  added: { stroke: '#16a34a', width: 2.6, opacity: 1 },
  removed: { stroke: '#dc2626', width: 2.6, opacity: 1, dash: '6 4' },
  modified: { stroke: '#d97706', width: 2.6, opacity: 1 },
};
const STATE_LABEL: Record<DiffState, string> = { added: 'Added', removed: 'Removed', modified: 'Modified', unchanged: 'Unchanged' };
const STATE_MARK: Record<DiffState, string> = { added: '+', removed: '−', modified: '~', unchanged: '' };
const unitText = (u: string) => (u === 'm2' ? 'm²' : u === 'm3' ? 'm³' : u);
const MAX_LABELLED = 60;

function Pane({ entities, vp, setVp, hidden, selected, onPick, label, fill }: {
  entities: ViewEntity[]; vp: Viewport; setVp: (v: Viewport) => void; hidden: Set<string>; selected: Set<string>; onPick: (e: ViewEntity) => void; label: string; fill: boolean;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; vp: Viewport; moved: boolean } | null>(null);
  const visible = useMemo(() => entities.filter((e) => !hidden.has(e.layer)), [entities, hidden]);
  const rect = () => ref.current?.getBoundingClientRect();
  // Pixel size of one world unit, using the same letterboxed scale as the transform used for hit tests and dragging.
  const px = (() => { const r = rect(); return r && r.width > 0 && r.height > 0 ? Math.max(vp.w / r.width, vp.h / r.height) : vp.w / 900; })();

  // Wheel must not scroll the page; React registers wheel listeners as passive, so attach it natively.
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const h = (ev: WheelEvent) => {
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      const w = pixelToWorld(vp, r, ev.clientX, ev.clientY);
      setVp(zoomAt(vp, w.x, w.y, ev.deltaY < 0 ? 1.2 : 1 / 1.2));
    };
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  }, [vp, setVp]);

  return (
    <div className="relative min-w-0 flex-1">
      <p className="pointer-events-none absolute left-2 top-2 z-10 rounded bg-card/90 px-2 py-0.5 text-xs font-semibold text-foreground shadow-sm">{label}</p>
      <svg
        ref={ref} role="img" aria-label={`${label} drawing geometry`} viewBox={`${vp.x} ${vp.y} ${vp.w} ${vp.h}`} preserveAspectRatio="xMidYMid meet"
        className={`block w-full cursor-grab touch-none select-none rounded-md border border-border bg-background active:cursor-grabbing ${fill ? 'h-full min-h-[480px]' : 'h-[420px]'}`}
        onPointerDown={(e) => { (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, vp, moved: false }; }}
        onPointerMove={(e) => {
          const d = drag.current; const r = rect(); if (!d || !r) return;
          const dx = e.clientX - d.x; const dy = e.clientY - d.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
          const s = Math.max(d.vp.w / r.width, d.vp.h / r.height);
          setVp({ ...d.vp, x: d.vp.x - dx * s, y: d.vp.y - dy * s });
        }}
        onPointerUp={() => { drag.current = null; }}
      >
        {visible.map((e) => {
          const st = STATE_STYLE[e.state]; const sel = selected.has(e.key);
          const w = (sel ? st.width + 1.6 : st.width) * px;
          const click = (ev: React.MouseEvent) => { ev.stopPropagation(); if (drag.current?.moved) return; onPick(e); };
          if (e.point) return <g key={e.key} onClick={click} className="cursor-pointer"><circle cx={e.point.x} cy={e.point.y} r={5 * px} fill={st.stroke} fillOpacity={e.state === 'unchanged' ? 0.35 : 0.9} stroke={sel ? '#0f172a' : st.stroke} strokeWidth={w} /><title>{`${e.blockName || e.kind} · ${e.layer} · ${STATE_LABEL[e.state]}`}</title></g>;
          return (
            <g key={e.key} onClick={click} className="cursor-pointer" transform={e.offset ? `translate(${e.offset.x} ${e.offset.y})` : undefined}>
              <path d={e.d} fill="none" stroke="transparent" strokeWidth={10 * px} />
              <path d={e.d} fill={e.closed && e.state !== 'unchanged' ? st.stroke : 'none'} fillOpacity={0.12} stroke={sel ? '#0f172a' : st.stroke} strokeWidth={w} strokeOpacity={st.opacity} strokeDasharray={st.dash ? st.dash.split(' ').map((n) => Number(n) * px).join(' ') : undefined} strokeLinejoin="round" strokeLinecap="round" />
              <title>{`${e.kind} · layer ${e.layer} · handle ${e.handle || '—'} · ${STATE_LABEL[e.state]}`}</title>
            </g>
          );
        })}
        {/* Text labels for changed geometry, so state is never carried by colour alone. */}
        {visible.filter((e) => e.state !== 'unchanged').slice(0, MAX_LABELLED).map((e) => {
          const cx = (e.bbox.minX + e.bbox.maxX) / 2; const cy = (e.bbox.minY + e.bbox.maxY) / 2;
          return <text key={`l-${e.key}`} x={cx} y={cy} fontSize={12 * px} fontWeight={700} textAnchor="middle" fill={STATE_STYLE[e.state].stroke} stroke="var(--background, #fff)" strokeWidth={3 * px} paintOrder="stroke" className="pointer-events-none">{STATE_MARK[e.state]}</text>;
        })}
      </svg>
    </div>
  );
}

/** Small whole-drawing view with the current viewport outlined. Clicking it re-centres the main view. */
function Overview({ extent, vp, entities, hidden, onCentre }: { extent: ViewModel['extent']; vp: Viewport; entities: ViewEntity[]; hidden: Set<string>; onCentre: (x: number, y: number) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const box = fitViewport(extent, 260, 90, 0.04);
  const strokeW = Math.max(box.w, box.h) / 400;
  return (
    <svg ref={ref} role="img" aria-label="Overview of the whole drawing" viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} preserveAspectRatio="xMidYMid meet" className="h-[90px] w-full cursor-crosshair rounded border border-border bg-background"
      onClick={(ev) => { const r = ref.current?.getBoundingClientRect(); if (!r) return; const w = pixelToWorld(box, r, ev.clientX, ev.clientY); onCentre(w.x, w.y); }}>
      {entities.filter((e) => !hidden.has(e.layer) && !e.point).slice(0, 4000).map((e) => <path key={e.key} d={e.d} transform={e.offset ? `translate(${e.offset.x} ${e.offset.y})` : undefined} fill="none" stroke={e.state === 'unchanged' ? '#94a3b8' : STATE_STYLE[e.state].stroke} strokeWidth={strokeW * (e.state === 'unchanged' ? 1 : 2.5)} />)}
      <rect x={vp.x} y={vp.y} width={vp.w} height={vp.h} fill="rgba(37,99,235,0.08)" stroke="#2563eb" strokeWidth={strokeW * 2} />
    </svg>
  );
}

export default function RealDrawingViewer({ model, live = null, streaming = false, changes, selectedChangeId, onSelectChange, revealedLayers = null, replaying = false, onRendered }: Props) {
  const [mode, setMode] = useState<ViewMode>('overlay');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [layerQuery, setLayerQuery] = useState('');
  const [isolated, setIsolated] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [pickedEntity, setPickedEntity] = useState<ViewEntity | null>(null);
  const [detail, setDetail] = useState<number | null>(null);
  const [sync, setSync] = useState(true);
  const wrap = useRef<HTMLDivElement>(null);
  const [sizePx, setSizePx] = useState({ w: 900, h: 560 });

  // Which geometry is on screen: the comparison when it exists, otherwise what the parser has delivered so far.
  const liveEntities = useMemo(() => (live ? live.files.flatMap((f) => f.entities) : []), [live]);
  const liveExtent = useMemo(() => { const b = entitiesBox(liveEntities); return b ?? { minX: 0, maxX: 1, minY: 0, maxY: 1 }; }, [liveEntities]);
  const showingLive = !model && liveEntities.length > 0;
  const extent = model ? model.extent : liveExtent;
  const layerRows = useMemo(() => {
    if (model) return model.layers.map((l) => ({ name: l.name, total: l.total, added: l.added, removed: l.removed }));
    const m = new Map<string, number>();
    for (const e of liveEntities) m.set(e.layer, (m.get(e.layer) ?? 0) + 1);
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([name, total]) => ({ name, total, added: 0, removed: 0 }));
  }, [model, liveEntities]);

  const initial = useMemo(() => fitViewport(extent, sizePx.w, sizePx.h), [extent, sizePx.w, sizePx.h]);
  const [vp, setVp] = useState<Viewport>(initial);
  const [vp2, setVp2] = useState<Viewport>(initial);
  // The viewport belongs to the user once they have moved it. New batches or a resize never reset it.
  const userMoved = useRef(false);
  const fittedFor = useRef<string>('');
  const windows = useMemo(() => (model?.elongated ? detailWindows(model.extent) : []), [model]);

  useEffect(() => { const el = wrap.current; if (!el) return; const ro = new ResizeObserver(() => setSizePx({ w: Math.max(320, el.clientWidth), h: Math.max(480, el.clientHeight) })); ro.observe(el); return () => ro.disconnect(); }, [full, leftOpen]);

  // Fit once for each new subject (a different pair, or the first geometry of a run), then leave the viewport alone.
  const subject = model ? `pair:${model.originalFile}|${model.revisedFile}` : showingLive ? `live:${live?.files.map((f) => f.fileName).join('|')}` : '';
  useEffect(() => {
    if (!subject) return;
    if (fittedFor.current !== subject) { fittedFor.current = subject; userMoved.current = false; setVp(initial); setVp2(initial); setDetail(null); setPickedEntity(null); }
    else if (!userMoved.current && !streaming) { setVp(initial); setVp2(initial); }
  }, [subject, initial, streaming]);
  // While geometry streams in and the user has not touched the view, keep the whole drawing in frame as it grows.
  useEffect(() => { if (streaming && showingLive && !userMoved.current) { setVp(initial); setVp2(initial); } }, [streaming, showingLive, initial]);

  const revealed = useMemo(() => (revealedLayers ? new Set(revealedLayers) : null), [revealedLayers]);
  const hiddenAll = useMemo(() => {
    const h = new Set(hidden);
    if (isolated) layerRows.forEach((l) => { if (l.name !== isolated) h.add(l.name); });
    if (revealed) layerRows.forEach((l) => { if (!revealed.has(l.name)) h.add(l.name); });
    return h;
  }, [hidden, isolated, revealed, layerRows]);

  const original = useMemo(() => (model ? model.entities.filter((e) => e.side === 'original') : []), [model]);
  const revised = useMemo(() => (model ? model.entities.filter((e) => e.side === 'revised') : []), [model]);
  const overlay = useMemo(() => [...original.filter((e) => e.state === 'removed' || e.state === 'modified'), ...revised], [original, revised]);
  const mainEntities = showingLive ? liveEntities : mode === 'original' ? original : mode === 'revised' ? revised : overlay;

  const drawn = useMemo(() => mainEntities.filter((e) => !hiddenAll.has(e.layer)).length, [mainEntities, hiddenAll]);
  useEffect(() => { if (drawn > 0) onRendered?.({ entities: drawn }); }, [drawn, onRendered]);

  const selectedChange = useMemo(() => changes.find((c) => c.id === selectedChangeId) ?? null, [changes, selectedChangeId]);
  const selectedKeys = useMemo(() => {
    const s = new Set<string>();
    if (pickedEntity) s.add(pickedEntity.key);
    if (model && selectedChange?.entityRefs) {
      const r = selectedChange.entityRefs;
      const orig = new Set(r.original.map((x) => x.handle)); const rev = new Set(r.revised.map((x) => x.handle));
      model.entities.forEach((e) => { if (e.layer !== r.layer) return; if ((e.side === 'original' && orig.has(e.handle)) || (e.side === 'revised' && rev.has(e.handle))) s.add(e.key); });
    }
    return s;
  }, [pickedEntity, selectedChange, model]);

  const markMoved = () => { userMoved.current = true; };
  const setPrimary = (v: Viewport) => { markMoved(); setVp(v); if (sync) setVp2(v); };
  const setSecondary = (v: Viewport) => { markMoved(); setVp2(v); if (sync) setVp(v); };
  const fitAll = () => { userMoved.current = false; setVp(initial); setVp2(initial); setDetail(null); };
  const fitSelected = useCallback(() => {
    if (!model) return;
    const list = model.entities.filter((e) => selectedKeys.has(e.key));
    const box = entitiesBox(list);
    if (!box) return;
    const w = Math.max(box.maxX - box.minX, 0.5); const h = Math.max(box.maxY - box.minY, 0.5);
    const v = fitViewport({ minX: box.minX, maxX: box.minX + w, minY: box.minY, maxY: box.minY + h }, sizePx.w, sizePx.h, 0.35);
    markMoved(); setVp(v); setVp2(v);
  }, [model, selectedKeys, sizePx]);
  // Selecting a change focuses its actual entities.
  useEffect(() => { if (selectedChangeId) fitSelected(); }, [selectedChangeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoomBtn = (f: number) => { const c = { x: vp.x + vp.w / 2, y: vp.y + vp.h / 2 }; setPrimary(zoomAt(vp, c.x, c.y, f)); };
  const centreOn = (x: number, y: number) => setPrimary({ ...vp, x: x - vp.w / 2, y: y - vp.h / 2 });
  const pick = (e: ViewEntity) => { setPickedEntity(e); setEvidenceOpen(true); if (e.changeIds[0]) onSelectChange(e.changeIds[0]); };
  const toggleLayer = (n: string) => { setIsolated(null); setHidden((h) => { const x = new Set(h); if (x.has(n)) x.delete(n); else x.add(n); return x; }); };
  const goDetail = (i: number) => { setDetail(i); const v = fitViewport(windows[i].box, sizePx.w, sizePx.h, 0.04); markMoved(); setVp(v); setVp2(v); };
  const filteredLayers = useMemo(() => layerRows.filter((l) => l.name.toLowerCase().includes(layerQuery.trim().toLowerCase())), [layerRows, layerQuery]);

  const entityChange = pickedEntity?.changeIds[0] ? changes.find((c) => c.id === pickedEntity.changeIds[0]) : null;
  const counts = useMemo(() => ({ added: revised.filter((e) => e.state === 'added').length, removed: original.filter((e) => e.state === 'removed').length, modified: revised.filter((e) => e.state === 'modified').length, unchanged: revised.filter((e) => e.state === 'unchanged').length }), [original, revised]);
  const measuredChanges = changes.filter((c) => c.entityRefs);

  if (!model && !showingLive) return null;
  const sideBySide = !!model && mode === 'side';

  return (
    <div className={full ? 'fixed inset-0 z-50 flex flex-col overflow-auto bg-background p-4' : 'rounded-lg border border-border bg-card p-4 shadow-sm'} aria-label="Drawing viewer">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-foreground">
            {model ? <>Drawing {model.drawingNumber || '(number not found)'} · Rev {model.originalRevision || '?'} → Rev {model.revisedRevision || '?'}</> : 'Geometry received so far'}
            {replaying ? <span className="ml-2 rounded bg-muted px-2 py-0.5 text-xs font-semibold">Replay</span> : streaming ? <span className="ml-2 rounded bg-accent/15 px-2 py-0.5 text-xs font-semibold">Live</span> : null}
          </h3>
          <p className="text-xs text-muted-foreground">
            {model ? `${model.originalFile} → ${model.revisedFile} · ${model.unitSource || 'units not declared'}` : live?.files.map((f) => `${f.fileName} · units ${f.unit} · ${f.delivered}${f.total ? ` of ${f.total}` : ''} entities`).join('  |  ')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {model ? (['original', 'revised', 'overlay', 'side'] as ViewMode[]).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={`rounded-md border px-3 py-1.5 text-sm font-medium ${mode === m ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card text-foreground hover:bg-muted'}`}>{m === 'side' ? 'Side by side' : m[0].toUpperCase() + m.slice(1)}</button>
          )) : null}
          <span className="mx-1 h-6 w-px bg-border" aria-hidden />
          <button type="button" onClick={() => zoomBtn(1.4)} aria-label="Zoom in" className="rounded-md border border-input bg-card p-2 hover:bg-muted"><Plus size={16} /></button>
          <button type="button" onClick={() => zoomBtn(1 / 1.4)} aria-label="Zoom out" className="rounded-md border border-input bg-card p-2 hover:bg-muted"><Minus size={16} /></button>
          <button type="button" onClick={fitAll} className="inline-flex items-center gap-1 rounded-md border border-input bg-card px-2.5 py-1.5 text-sm hover:bg-muted"><Expand size={14} aria-hidden />Fit drawing</button>
          <button type="button" onClick={fitSelected} disabled={selectedKeys.size === 0} className="inline-flex items-center gap-1 rounded-md border border-input bg-card px-2.5 py-1.5 text-sm hover:bg-muted disabled:opacity-50"><Crosshair size={14} aria-hidden />Fit selected change</button>
          <button type="button" onClick={() => setLeftOpen((v) => !v)} aria-pressed={leftOpen} aria-label={leftOpen ? 'Collapse side panels' : 'Expand side panels'} className="inline-flex items-center gap-1 rounded-md border border-input bg-card px-2.5 py-1.5 text-sm hover:bg-muted">{leftOpen ? <ChevronRight size={14} aria-hidden /> : <ChevronLeft size={14} aria-hidden />}Panels</button>
          <button type="button" onClick={() => setFull((v) => !v)} aria-label={full ? 'Exit fullscreen' : 'Fullscreen'} className="rounded-md border border-input bg-card p-2 hover:bg-muted">{full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
        </div>
      </div>

      {model ? (
        <p className={`mb-2 rounded-md px-3 py-1.5 text-sm ${model.alignmentOk ? 'bg-success/10 text-foreground' : 'border border-warning bg-warning/10 text-foreground'}`} role={model.alignmentOk ? 'status' : 'alert'}>{model.alignmentOk ? 'Aligned: ' : ''}{model.alignmentNote}</p>
      ) : (
        <p className="mb-2 rounded-md bg-muted px-3 py-1.5 text-sm text-foreground" role="status">Showing geometry as the parser delivers it. Nothing has been compared yet, so no change colours are shown.</p>
      )}
      {model && model.info.coverageNotes.length ? <p className="mb-2 rounded-md border border-warning bg-warning/10 px-3 py-1.5 text-sm text-foreground" role="alert">Coverage limited: {model.info.coverageNotes.join(' | ')}</p> : null}
      {model?.elongated ? (
        <div className="mb-2 rounded-md border border-border bg-background px-3 py-2 text-sm">
          <p className="text-foreground">This drawing is long and narrow (about {model.aspect >= 1 ? model.aspect.toFixed(0) : (1 / model.aspect).toFixed(0)}:1). It is shown with its true proportions. Use the overview or the detail sections.</p>
          <div className="mt-1 flex flex-wrap gap-1.5">{windows.map((w, i) => <button key={w.label} type="button" onClick={() => goDetail(i)} aria-pressed={detail === i} className={`rounded border px-2 py-0.5 text-xs ${detail === i ? 'border-primary bg-primary text-primary-foreground' : 'border-input hover:bg-muted'}`}>{w.label}</button>)}<button type="button" onClick={fitAll} className="rounded border border-input px-2 py-0.5 text-xs hover:bg-muted">Whole drawing</button></div>
        </div>
      ) : null}

      <div className={`grid min-h-0 gap-3 ${full ? 'flex-1' : ''} ${leftOpen ? 'lg:grid-cols-[minmax(0,1fr)_300px]' : 'lg:grid-cols-[minmax(0,1fr)]'}`}>
        <div ref={wrap} className="min-w-0">
          <div className={`flex gap-2 ${full ? 'h-[calc(100vh-300px)]' : ''}`}>
            {sideBySide ? (
              <>
                <Pane entities={original} vp={vp} setVp={setPrimary} hidden={hiddenAll} selected={selectedKeys} onPick={pick} label={`Original · Rev ${model!.originalRevision || '?'}`} fill={full} />
                <Pane entities={revised} vp={sync ? vp : vp2} setVp={setSecondary} hidden={hiddenAll} selected={selectedKeys} onPick={pick} label={`Revised · Rev ${model!.revisedRevision || '?'}`} fill={full} />
              </>
            ) : (
              <Pane entities={mainEntities} vp={vp} setVp={setPrimary} hidden={hiddenAll} selected={selectedKeys} onPick={pick} label={showingLive ? 'Parsed geometry' : mode === 'overlay' ? 'Overlay (revised with removed elements)' : mode === 'original' ? 'Original' : 'Revised'} fill={full} />
            )}
          </div>
          {model?.elongated || showingLive ? <div className="mt-2"><Overview extent={extent} vp={vp} entities={mainEntities} hidden={hiddenAll} onCentre={centreOn} /></div> : null}
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground" aria-label="Legend">
            {model ? (['added', 'removed', 'modified', 'unchanged'] as DiffState[]).map((s) => <span key={s} className="inline-flex items-center gap-1"><span className="inline-block h-0.5 w-5" style={{ background: STATE_STYLE[s].stroke, borderTop: s === 'removed' ? `2px dashed ${STATE_STYLE[s].stroke}` : undefined }} />{STATE_MARK[s]} {STATE_LABEL[s]} ({counts[s]})</span>) : <span>{drawn} entities drawn</span>}
            {model ? <span>· units {model.info.originalUnit}/{model.info.revisedUnit} · {model.info.originalEntities}/{model.info.revisedEntities} entities read</span> : null}
            {sideBySide ? <label className="ml-auto inline-flex items-center gap-1"><input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} />Synchronise pan and zoom</label> : null}
          </div>
        </div>

        {leftOpen ? (
          <aside className="min-w-0 space-y-3">
            <section className="rounded-md border border-border bg-background p-2.5" aria-label="Layers">
              <h4 className="flex items-center justify-between gap-1.5 text-sm font-semibold text-foreground"><span className="inline-flex items-center gap-1.5"><Layers size={14} aria-hidden />Layers ({layerRows.length})</span>
                <span className="flex gap-1"><button type="button" onClick={() => { setIsolated(null); setHidden(new Set()); }} className="rounded border border-input px-1.5 py-0.5 text-xs font-normal hover:bg-muted">Show all</button></span></h4>
              <label className="relative mt-1.5 block"><span className="sr-only">Search layers</span><Search size={13} className="pointer-events-none absolute left-2 top-2 text-muted-foreground" aria-hidden /><input value={layerQuery} onChange={(e) => setLayerQuery(e.target.value)} placeholder="Search layers" className="w-full rounded border border-input bg-card py-1 pl-7 pr-2 text-sm" /></label>
              <ul className="mt-1.5 max-h-48 space-y-0.5 overflow-auto text-sm">
                {filteredLayers.map((l) => {
                  const pending = revealed ? !revealed.has(l.name) : false;
                  const iso = isolated === l.name;
                  return (
                    <li key={l.name} className="flex items-center gap-1.5">
                      <label className="flex min-w-0 flex-1 items-center gap-2"><input type="checkbox" checked={!hiddenAll.has(l.name)} disabled={pending} onChange={() => toggleLayer(l.name)} /><span className="min-w-0 flex-1 truncate text-foreground">{l.name}</span><span className="font-data text-xs text-muted-foreground">{pending ? 'queued' : l.total}</span></label>
                      <button type="button" onClick={() => setIsolated(iso ? null : l.name)} aria-pressed={iso} title={iso ? 'Show all layers' : 'Show only this layer'} className={`rounded border px-1.5 text-xs ${iso ? 'border-primary bg-primary text-primary-foreground' : 'border-input hover:bg-muted'}`}>Only</button>
                    </li>
                  );
                })}
                {filteredLayers.length === 0 ? <li className="text-muted-foreground">No layer matches.</li> : null}
              </ul>
            </section>
            <section className="rounded-md border border-border bg-background p-2.5" aria-label="Changes">
              <h4 className="flex items-center gap-1.5 text-sm font-semibold text-foreground"><ScanSearch size={14} aria-hidden />Changes ({measuredChanges.length})</h4>
              <ul className="mt-1 max-h-60 space-y-1 overflow-auto">
                {measuredChanges.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => { setPickedEntity(null); onSelectChange(c.id === selectedChangeId ? null : c.id); }} aria-pressed={c.id === selectedChangeId} className={`w-full rounded border px-2 py-1.5 text-left text-sm ${c.id === selectedChangeId ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted'}`}>
                      <span className="flex items-center justify-between gap-2"><span className="truncate font-medium text-foreground">{c.component}</span><span className={`rounded px-1.5 text-xs font-medium ${c.change === 'added' ? 'bg-success/15 text-success' : c.change === 'removed' ? 'bg-destructive/10 text-destructive' : 'bg-warning/20 text-foreground'}`}>{c.change ? `${STATE_MARK[c.change]} ${c.change}` : 'change'}</span></span>
                      <span className="font-data text-xs text-muted-foreground">{c.changeQty} {unitText(c.unit)}{c.ambiguity ? ' · ambiguous' : ''}</span>
                    </button>
                  </li>
                ))}
                {measuredChanges.length === 0 ? <li className="text-sm text-muted-foreground">{model ? 'No change was measured from the drawing geometry.' : 'Changes appear after comparison.'}</li> : null}
              </ul>
            </section>
          </aside>
        ) : null}
      </div>

      <details open={evidenceOpen} onToggle={(e) => setEvidenceOpen((e.currentTarget as HTMLDetailsElement).open)} className="mt-3 rounded-md border border-border bg-background p-3">
        <summary className="cursor-pointer text-sm font-semibold text-foreground">Evidence {selectedChange ? `· ${selectedChange.component}` : pickedEntity ? `· ${pickedEntity.kind} ${pickedEntity.handle}` : ''}</summary>
        {selectedChange || entityChange ? (() => { const c = (selectedChange ?? entityChange)!; return (
          <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div><dt className="text-muted-foreground">Drawing / revision</dt><dd className="text-foreground">{c.entityRefs?.drawingNumber || model?.drawingNumber || '—'} · {c.entityRefs?.originalRevision || '?'} → {c.entityRefs?.revisedRevision || '?'}</dd></div>
            <div><dt className="text-muted-foreground">Layer</dt><dd className="text-foreground">{c.entityRefs?.layer ?? c.component}</dd></div>
            <div><dt className="text-muted-foreground">Location</dt><dd className="text-foreground">{c.location || '—'}</dd></div>
            <div><dt className="text-muted-foreground">Quantity (measured)</dt><dd className="font-data text-foreground">{c.changeQty} {unitText(c.unit)} <span className="font-sans text-muted-foreground">(original {c.originalQty || '—'}, revised {c.revisedQty || '—'}; added {c.addedQty ?? '—'}, omitted {c.omittedQty ?? '—'})</span></dd></div>
            {c.trace ? <div className="sm:col-span-2"><dt className="text-muted-foreground">Formula</dt><dd className="text-foreground">{c.trace.formula} · {c.trace.entityCount.original} original / {c.trace.entityCount.revised} revised entities · tolerance {c.trace.toleranceM * 1000} mm · revision {c.trace.drawingRevision}</dd></div> : null}
            <div className="sm:col-span-2"><dt className="text-muted-foreground">Measurement basis</dt><dd className="text-foreground">{c.measurementBasis}</dd></div>
            {c.trace?.missingForDerivation?.length ? <div className="sm:col-span-2"><dt className="text-muted-foreground">Not derived (dimension not evidenced)</dt><dd className="text-foreground">{c.trace.missingForDerivation.join('; ')}</dd></div> : null}
            {c.entityRefs?.originShift ? <div className="sm:col-span-2"><dt className="text-muted-foreground">Origin shift applied</dt><dd className="font-data text-foreground">{c.entityRefs.originShift.dx.toFixed(3)} m, {c.entityRefs.originShift.dy.toFixed(3)} m</dd></div> : null}
            {c.relocationEvidence?.sentence ? <div className="sm:col-span-2"><dt className="text-muted-foreground">Relocation evidence ({c.relocationEvidence.source})</dt><dd className="text-foreground">“{c.relocationEvidence.sentence}” <span className="text-muted-foreground">matched on {c.relocationEvidence.matchedOn.join(', ')}</span></dd></div> : null}
            {c.ambiguity ? <div className="sm:col-span-2 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-foreground">Ambiguous correspondence: {c.ambiguity.reason}</div> : null}
            <div className="sm:col-span-2"><dt className="text-muted-foreground">Entities</dt><dd className="font-data text-xs text-foreground">{[...(c.entityRefs?.original ?? []).map((r) => `original ${r.kind} ${r.handle || '·'}${r.fromBlock ? ` (block ${r.fromBlock})` : ''}`), ...(c.entityRefs?.revised ?? []).map((r) => `revised ${r.kind} ${r.handle || '·'}${r.fromBlock ? ` (block ${r.fromBlock})` : ''}`)].slice(0, 12).join(' · ') || '—'}</dd></div>
            {c.alternatives.length ? <div className="sm:col-span-2"><dt className="text-muted-foreground">Other evidence (kept separate)</dt><dd className="text-foreground">{c.alternatives.map((a) => `${a.value} ${unitText(a.unit)} · ${a.source}`).join('; ')}</dd></div> : null}
            {c.conflict ? <div className="sm:col-span-2 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-foreground">{c.conflictNote}</div> : null}
          </dl>
        ); })() : pickedEntity ? (
          <p className="mt-2 text-sm text-muted-foreground">{pickedEntity.kind} on layer {pickedEntity.layer} (handle {pickedEntity.handle || '—'}), {pickedEntity.side} drawing, {STATE_LABEL[pickedEntity.state].toLowerCase()}. {pickedEntity.state === 'unchanged' ? 'It matched the other revision, so it is not part of a change.' : 'It is not linked to a quantified change.'} Length {pickedEntity.length.toFixed(3)} m{pickedEntity.area > 0 ? `, area ${pickedEntity.area.toFixed(3)} m²` : ''}{pickedEntity.curved ? ' (curved: measured on the true arc)' : ''}.</p>
        ) : <p className="mt-2 text-sm text-muted-foreground">Select a change or click an element in the drawing to see its evidence.</p>}
      </details>
    </div>
  );
}

'use client';

import React, { useMemo, useState } from 'react';
import { entitiesBox, fitViewport, type Side, type ViewEntity, type ViewModel, type Viewport } from '@/lib/drawings/viewModel';
import type { ReconciledChange } from '@/lib/drawings/types';

const INK = '#23364a';
const FAINT = '#7b8ba0';
const RED = '#b91c1c';
const GREEN = '#04734e';
const AMBER = '#a45309';
const shade = (e: ViewEntity) => ({ added: GREEN, removed: RED, modified: AMBER, unchanged: INK })[e.state];
const unit = (u: string) => u === 'm2' ? 'm²' : u === 'm3' ? 'm³' : u;
type Box = NonNullable<ReturnType<typeof entitiesBox>>;
type Region = { change: ReconciledChange; original: Box | null; revised: Box | null; all: Box; number: number };

function Geometry({ entity: e, color, width, radius, emphasize = false }: {
  entity: ViewEntity; color: string; width: number; radius: number; emphasize?: boolean;
}) {
  return e.point
    ? <circle cx={e.point.x} cy={e.point.y} r={radius} fill={color} />
    : <path d={e.d} transform={e.offset ? `translate(${e.offset.x} ${e.offset.y})` : undefined}
        fill={e.closed && emphasize ? color : 'none'} fillOpacity={0.15}
        stroke={color} strokeWidth={width} vectorEffect="non-scaling-stroke" strokeLinejoin="round"
        strokeLinecap="round" strokeDasharray={emphasize && e.state === 'removed' ? '7 4' : undefined} />;
}

function Redline({ box, vp, number, absent, active }: { box: Box; vp: Viewport; number: number; absent: boolean; active: boolean }) {
  const r = vp.w / 112;
  const x = box.minX - r;
  const y = (box.minY + box.maxY) / 2 - Math.max(box.maxY - box.minY + 2 * r, 3 * r) / 2;
  const w = Math.max(box.maxX - box.minX + 2 * r, 3 * r);
  const h = Math.max(box.maxY - box.minY + 2 * r, 3 * r);
  const labelX = number % 2 ? x - 1.4 * r : x + w + 1.4 * r;
  return <g>
    <rect x={x} y={y} width={w} height={h} rx={r * 0.45} fill="none" stroke={RED} strokeWidth={active ? 2.5 : 1.5}
      vectorEffect="non-scaling-stroke" strokeDasharray={absent ? '5 4' : undefined} />
    <circle cx={labelX} cy={y + h / 2} r={1.35 * r} fill={RED} stroke="white" strokeWidth={0.75} vectorEffect="non-scaling-stroke" />
    <text x={labelX} y={y + h / 2} dy=".36em" fontSize={r * 1.6} fontWeight={700} textAnchor="middle" fill="white">{number}</text>
  </g>;
}

function Sheet({ model, side, regions, active }: { model: ViewModel; side: Side; regions: Region[]; active?: Region }) {
  const isOriginal = side === 'original';
  // A and B independently render their own stored CAD entities, against exactly the same coordinate frame.
  const b = active?.all ?? model.extent;
  const minSpan = active ? Math.max((model.extent.maxX - model.extent.minX) * 0.04, (model.extent.maxY - model.extent.minY) * 0.04, 0.01) : 0.01;
  const framed = {
    minX: b.minX - minSpan, minY: b.minY - minSpan, maxX: b.maxX + minSpan, maxY: b.maxY + minSpan,
  };
  const vp = fitViewport(framed, 620, active ? 230 : 190, active ? 0.28 : 0.13);
  const entities = model.entities.filter(e => e.side === side);
  const title = isOriginal ? 'Original' : 'Revised';
  const revision = (isOriginal ? model.originalRevision : model.revisedRevision) || 'not specified';
  const file = isOriginal ? model.originalFile : model.revisedFile;
  const notes = active ? [active] : regions;
  const visible = active ? entities.filter(e => e.changeIds.includes(active.change.id) || (
    e.bbox.maxX >= vp.x && e.bbox.minX <= vp.x + vp.w && e.bbox.maxY >= vp.y && e.bbox.minY <= vp.y + vp.h
  )) : entities;
  return <figure className="min-w-0 overflow-hidden rounded-md border border-slate-400 bg-white text-slate-900">
    <div className="flex flex-wrap items-center justify-between gap-1 border-b border-slate-400 bg-slate-100 px-3 py-2">
      <figcaption className="text-sm font-bold">{title} drawing · Rev {revision}</figcaption>
      <span className="text-xs text-slate-600">{active ? 'Enlarged detail' : 'Full sheet view'}</span>
    </div>
    <div className={active ? '' : 'grid grid-cols-[minmax(0,1fr)_7rem] sm:grid-cols-[minmax(0,1fr)_9rem]'}>
      <svg className="block w-full" style={{ aspectRatio: active ? '620 / 230' : '620 / 190' }} role="img"
        aria-label={`${title} revision ${revision}: ${active ? active.change.component : 'full drawing with numbered red change boxes'}`}
        viewBox={`${vp.x} ${vp.y} ${vp.w} ${vp.h}`}>
        {visible.map(e => {
          const marked = e.state !== 'unchanged' && (!active || e.changeIds.includes(active.change.id));
          return <Geometry key={e.key} entity={e} color={marked ? shade(e) : active ? FAINT : INK}
            width={marked ? 3.2 : active ? 1.15 : 1.35} radius={vp.w / (marked ? 150 : 265)} emphasize={marked} />;
        })}
        {notes.map(r => <Redline key={r.change.id} box={r[side] ?? r.all} vp={vp} number={r.number} absent={!r[side]} active={!!active} />)}
      </svg>
      {!active ? <dl className="space-y-1.5 border-l border-slate-400 bg-slate-50 p-2.5 text-xs">
        <dt className="font-bold uppercase text-slate-600">Drawing no.</dt>
        <dd className="break-words font-semibold">{model.drawingNumber || 'Not specified'}</dd>
        <dt className="font-bold uppercase text-slate-600">Revision</dt><dd>{revision}</dd>
        <dt className="font-bold uppercase text-slate-600">Source file</dt><dd className="break-words">{file}</dd>
      </dl> : null}
    </div>
    {active ? <p className="border-t border-slate-200 px-3 py-2 text-xs font-medium text-slate-700">
      {active[side] ? 'Solid red box: changed geometry on this revision.' : 'Dashed red box: corresponding location. No changed geometry on this revision.'}
    </p> : null}
  </figure>;
}

export default function DrawingChangeSheets({ model, changes }: { model: ViewModel; changes: ReconciledChange[] }) {
  const [selected, setSelected] = useState('');
  const regions = useMemo(() => changes.flatMap(change => {
    if (!change.entityRefs) return [];
    const linked = model.entities.filter(e => e.state !== 'unchanged' && e.changeIds.includes(change.id));
    const all = entitiesBox(linked);
    if (!all) return [];
    return [{ change, all, original: entitiesBox(linked.filter(e => e.side === 'original')), revised: entitiesBox(linked.filter(e => e.side === 'revised')) }];
  }).map((region, i) => ({ ...region, number: i + 1 })), [changes, model]);
  const active = regions.find(r => r.change.id === selected) ?? regions[0];
  return <section aria-label="Drawing change sheets" className="space-y-3 rounded-lg border border-border bg-card p-4">
    <div>
      <h2 className="text-xl font-semibold">What changed on the drawing</h2>
      <p className="mt-1 text-sm text-muted-foreground">Compare the two revisions at the same scale. Red boxes mark the exact locations; dashed boxes show the same locations before an addition or after a removal.</p>
    </div>
    <div className="grid gap-3 xl:grid-cols-2">
      <Sheet model={model} side="original" regions={regions} />
      <Sheet model={model} side="revised" regions={regions} />
    </div>
    <p className="text-xs text-muted-foreground">The views show all supported CAD geometry from each revision. The outer frame and side panel are presentation aids, not a reproduction of the native sheet border or title block.{model.info.coverageNotes.length ? ` Reader limitations: ${model.info.coverageNotes.join(' | ')}` : ''}</p>
    {active ? <div className="space-y-2 border-t border-border pt-3">
      <h3 className="text-base font-semibold">Zoom into a boxed change</h3>
      <div className="flex flex-wrap gap-2">{regions.map(r => <button key={r.change.id} type="button" aria-pressed={active === r} onClick={() => setSelected(r.change.id)}
        className="inline-flex items-center gap-2 rounded border border-input px-3 py-2 text-sm font-semibold hover:bg-muted aria-pressed:border-red-700 aria-pressed:bg-red-50 aria-pressed:text-red-950">
        <span className="rounded-full bg-red-700 px-1.5 text-white">{r.number}</span>
        <span className="capitalize">{r.change.component.toLowerCase()}</span>
        <span className="text-xs">{r.change.change === 'added' ? '+' : r.change.change === 'removed' ? '−' : ''}{r.change.change === 'added' ? (r.change.addedQty ?? r.change.changeQty) : r.change.change === 'removed' ? (r.change.omittedQty ?? r.change.changeQty) : r.change.changeQty} {unit(r.change.unit)}</span>
      </button>)}</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Sheet model={model} side="original" regions={regions} active={active} />
        <Sheet model={model} side="revised" regions={regions} active={active} />
      </div>
    </div> : <p className="text-sm text-muted-foreground">No quantified changes were linked to geometry on these drawings.</p>}
  </section>;
}

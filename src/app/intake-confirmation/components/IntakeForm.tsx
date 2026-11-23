'use client';

import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { Loader2, AlertTriangle, Link2, Check } from 'lucide-react';
import { toast } from 'sonner';
import AppToaster from '@/lib/toaster';
import ConfidenceBar from '@/components/ui/ConfidenceBar';
import Badge from '@/components/ui/Badge';

interface IntakeValues {
  project: string;
  zone: string;
  location: string;
  discipline: string;
  changeType: string;
  description: string;
  requester: string;
  eventDate: string;
  statedQty: string;
  statedUnit: string;
  priorQty: string;
  drawingRef: string;
  contractRef: string;
  notes: string;
}

const defaults: IntakeValues = {
  project: 'Fahid Island Roads Package',
  zone: 'Zone C – East Spine',
  location: 'R4 CH 5+000 to CH 7+000',
  discipline: 'Civil – Roads',
  changeType: 'Scope increase',
  description: 'Extend access road R4 from 5.0 km to 7.0 km including earthworks, pavement, kerbs and street lighting, per Employer instruction of 20 October 2026.',
  requester: 'Faisal Al Mansoori',
  eventDate: '2026-10-20',
  statedQty: '2000',
  statedUnit: 'm',
  priorQty: '5000',
  drawingRef: 'R4-CIV-101 Rev B → Rev C',
  contractRef: 'FIR-CON-2025-011',
  notes: '',
};

const meta: Record<keyof IntakeValues, { label: string; help?: string; confidence: number; source: string }> = {
  project: { label: 'Project', confidence: 99, source: 'PVR-0418.pdf · p1' },
  zone: { label: 'Zone', help: 'Used to filter the WBS for impacted activities.', confidence: 94, source: 'PVR-0418.pdf · p1' },
  location: { label: 'Location', confidence: 86, source: 'PVR-0418.pdf · p2' },
  discipline: { label: 'Discipline', help: 'Mapped from drawing layer naming rules.', confidence: 97, source: 'R4-CIV-101 title block' },
  changeType: { label: 'Change type', confidence: 92, source: 'Intake agent classification' },
  description: { label: 'Change description', confidence: 90, source: 'PVR-0418.pdf · p2' },
  requester: { label: 'Requested by', confidence: 99, source: 'PVR-0418.pdf · p3' },
  eventDate: { label: 'Event date', help: 'The nearest baseline before this date is used for the programme.', confidence: 68, source: 'Email 2026-10-20.eml' },
  statedQty: { label: 'Stated quantity', confidence: 74, source: 'PVR-0418.pdf · p2' },
  statedUnit: { label: 'Unit', confidence: 96, source: 'PVR-0418.pdf · p2' },
  priorQty: { label: 'Existing quantity', confidence: 83, source: 'BoQ item 3.1.01' },
  drawingRef: { label: 'Drawing versions', confidence: 95, source: 'Evidence pack' },
  contractRef: { label: 'Contract reference', confidence: 91, source: 'Contract cover page' },
  notes: { label: 'Reviewer notes', confidence: 100, source: 'You' },
};

const changeTypes = [
  'Scope increase',
  'Scope decrease',
  'Specification change',
  'Material replacement',
  'Site condition',
  'Supervision consultancy',
  'Provisional sum',
];

const inputBase =
  'w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/30';

function FieldShell({
  name,
  error,
  children,
}: {
  name: keyof IntakeValues;
  error?: string;
  children: React.ReactNode;
}) {
  const m = meta[name];
  const low = m.confidence < 75;
  return (
    <div className={`rounded-lg border p-4 ${low ? 'border-warning/60 bg-warning/10' : 'border-border bg-card'}`}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <label htmlFor={name} className="text-sm font-semibold text-foreground">
          {m.label}
        </label>
        {name !== 'notes' ? <ConfidenceBar value={m.confidence} /> : null}
      </div>
      {m.help ? <p className="mb-2 text-xs text-muted-foreground">{m.help}</p> : null}
      {children}
      {error ? <p className="mt-1.5 text-xs font-medium text-destructive">{error}</p> : null}
      <p className="mt-2 flex items-center gap-1 text-xs text-accent">
        <Link2 size={11} /> {m.source}
        {low ? <span className="ml-auto flex items-center gap-1 font-semibold text-foreground"><AlertTriangle size={11} /> Please check</span> : null}
      </p>
    </div>
  );
}

export default function IntakeForm() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isDirty },
  } = useForm<IntakeValues>({ defaultValues: defaults });

  const onSubmit = (values: IntakeValues) => {
    setSaving(true);
    // Backend integration: PATCH /cases/PVR-0418/intake with corrected fields; corrections are written to the audit log.
    console.log('intake values', values);
    setTimeout(() => {
      setSaving(false);
      toast.success('Fields confirmed. Contract, drawing, cost and schedule agents are starting.');
      setTimeout(() => router.push('/case-story'), 900);
    }, 1000);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6 pb-24">
      <AppToaster />
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">New case · Step 2 of 3</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">Confirm what the Intake agent extracted</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Six files were classified. Two fields have low confidence and are highlighted. Your corrections are saved and logged.
          </p>
        </div>
        <div className="flex gap-2">
          <Badge tone="automated">6 files classified</Badge>
          <Badge tone="warning">2 need checking</Badge>
        </div>
      </div>

      <fieldset className="space-y-4">
        <legend className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Where and what</legend>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          <FieldShell name="project" error={errors.project?.message}>
            <input id="project" className={`${inputBase} border-input`} {...register('project', { required: 'Project is required' })} />
          </FieldShell>
          <FieldShell name="zone" error={errors.zone?.message}>
            <input id="zone" className={`${inputBase} border-input`} {...register('zone', { required: 'Zone is required to filter the WBS' })} />
          </FieldShell>
          <FieldShell name="location" error={errors.location?.message}>
            <input id="location" className={`${inputBase} border-input`} {...register('location', { required: 'Location is required' })} />
          </FieldShell>
          <FieldShell name="discipline" error={errors.discipline?.message}>
            <input id="discipline" className={`${inputBase} border-input`} {...register('discipline', { required: 'Discipline is required' })} />
          </FieldShell>
          <FieldShell name="changeType" error={errors.changeType?.message}>
            <select id="changeType" className={`${inputBase} border-input`} {...register('changeType', { required: true })}>
              {changeTypes.map((t) => (
                <option key={`ct-${t}`} value={t}>{t}</option>
              ))}
            </select>
          </FieldShell>
          <FieldShell name="drawingRef" error={errors.drawingRef?.message}>
            <input id="drawingRef" className={`${inputBase} border-input`} {...register('drawingRef', { required: 'Name at least two drawing versions' })} />
          </FieldShell>
        </div>
        <FieldShell name="description" error={errors.description?.message}>
          <textarea
            id="description"
            rows={3}
            className={`${inputBase} border-input`}
            {...register('description', {
              required: 'Describe the change',
              minLength: { value: 20, message: 'Add a little more detail so the agents can match BoQ items' },
            })}
          />
        </FieldShell>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Quantities, dates and parties</legend>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          <FieldShell name="statedQty" error={errors.statedQty?.message}>
            <input
              id="statedQty"
              inputMode="decimal"
              className={`${inputBase} font-data border-input`}
              {...register('statedQty', {
                required: 'Enter the stated quantity',
                pattern: { value: /^\d+(\.\d+)?$/, message: 'Use digits only, for example 2000' },
              })}
            />
          </FieldShell>
          <FieldShell name="statedUnit" error={errors.statedUnit?.message}>
            <input id="statedUnit" className={`${inputBase} border-input`} {...register('statedUnit', { required: 'Unit is required' })} />
          </FieldShell>
          <FieldShell name="priorQty" error={errors.priorQty?.message}>
            <input id="priorQty" inputMode="decimal" className={`${inputBase} font-data border-input`} {...register('priorQty')} />
          </FieldShell>
          <FieldShell name="eventDate" error={errors.eventDate?.message}>
            <input id="eventDate" type="date" className={`${inputBase} border-input`} {...register('eventDate', { required: 'Event date drives the baseline choice' })} />
          </FieldShell>
          <FieldShell name="requester" error={errors.requester?.message}>
            <input id="requester" className={`${inputBase} border-input`} {...register('requester', { required: 'Requester is required' })} />
          </FieldShell>
          <FieldShell name="contractRef" error={errors.contractRef?.message}>
            <input id="contractRef" className={`${inputBase} font-data border-input`} {...register('contractRef')} />
          </FieldShell>
        </div>
        <FieldShell name="notes">
          <textarea id="notes" rows={2} placeholder="Anything the agents should know, for example access constraints or an earlier verbal instruction." className={`${inputBase} border-input`} {...register('notes')} />
        </FieldShell>
      </fieldset>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card/95 backdrop-blur md:left-60">
        <div className="mx-auto flex max-w-screen-2xl items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8 2xl:px-16">
          <p className="text-sm text-muted-foreground">
            {isDirty ? 'You have unsaved corrections.' : 'No corrections made yet.'}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => router.push('/upload-evidence-pack')}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-all duration-150 hover:bg-muted active:scale-95"
            >
              Back to evidence pack
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex min-w-[190px] items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-all duration-150 hover:opacity-90 active:scale-95 disabled:opacity-70"
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
              {saving ? 'Starting agents' : 'Confirm and start assessment'}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
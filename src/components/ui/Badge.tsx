import React from 'react';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'automated';

interface BadgeProps {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
}

const toneClasses: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  info: 'bg-accent/10 text-accent',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/15 text-foreground',
  danger: 'bg-destructive/10 text-destructive',
  automated: 'bg-automated/10 text-automated',
};

export default function Badge({ tone = 'neutral', children, className = '' }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${toneClasses[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function statusTone(status: string): Tone {
  switch (status) {
    case 'Approved': case'VO Issued':
      return 'success';
    case 'Awaiting Review':
      return 'warning';
    case 'Rejected':
      return 'danger';
    case 'Declined – Outside Scope':
      return 'neutral';
    case 'Impact Assessment': case'Contract Review':
      return 'info';
    default:
      return 'automated';
  }
}
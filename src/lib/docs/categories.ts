import { isProcessedPvrFile } from '@/lib/intake/processedReference';
import type { FileRole } from '@/lib/intake/triage';

/** User-facing categories. Each maps to the processing role used by triage, parsers and readiness. */
export interface CategoryOption { key: string; label: string; role: FileRole }

const CATEGORY_OPTIONS: CategoryOption[] = [
  { key: 'pvr', label: 'PVR/change request', role: 'pvr' },
  { key: 'boq', label: 'BOQ', role: 'boq' },
  { key: 'boq_preamble', label: 'BOQ preambles', role: 'boq' },
  { key: 'programme', label: 'Programme/XER', role: 'schedule' },
  { key: 'drawings', label: 'Drawings', role: 'drawings' },
  { key: 'contract', label: 'Contract/amendments', role: 'contract' },
  { key: 'processed_pvr_reference', label: 'Processed PVR (comparison only)', role: 'reference' },
  { key: 'productivity', label: 'Productivity references', role: 'reference' },
  { key: 'correspondence', label: 'Correspondence', role: 'correspondence' },
  { key: 'site', label: 'Site reports', role: 'site' },
  { key: 'other', label: 'Other supporting documents', role: 'unused' },
];

const DRAWING_SUBROLES = [
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'original', label: 'Original' },
  { key: 'revised', label: 'Revised' },
];

const PROGRAMME_SUBROLES = [
  { key: 'baseline', label: 'Baseline' },
  { key: 'current', label: 'Current update' },
  { key: 'reference', label: 'Other reference' },
];

/** Categories are stored as `<role>` plus a `categoryKey` in metadata so BOQ preambles and Productivity can be told apart. */
function categoryKeyOf(role: string, metadata?: Record<string, string>, fileName?: string): string {
  const k = metadata?.categoryKey;
  if (k && CATEGORY_OPTIONS.some((c) => c.key === k && c.role === role)) return k;
  if (role === 'reference' && fileName && isProcessedPvrFile(fileName)) return 'processed_pvr_reference';
  const first = CATEGORY_OPTIONS.filter((c) => c.key !== 'processed_pvr_reference').find((c) => c.role === role);
  return first ? first.key : 'other';
}

function categoryLabel(role: string, metadata?: Record<string, string>, fileName?: string): string {
  const key = categoryKeyOf(role, metadata, fileName);
  return CATEGORY_OPTIONS.find((c) => c.key === key)?.label ?? 'Other supporting documents';
}

function subroleLabel(role: string, subrole?: string): string {
  if (!subrole) return '';
  const list = role === 'drawings' ? DRAWING_SUBROLES : role === 'schedule' ? PROGRAMME_SUBROLES : [];
  return list.find((s) => s.key === subrole)?.label ?? '';
}

export { CATEGORY_OPTIONS, DRAWING_SUBROLES, PROGRAMME_SUBROLES, categoryKeyOf, categoryLabel, subroleLabel };
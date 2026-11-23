import type { ClassifiedFile, FileRole } from '@/lib/intake/triage';

export type GroupKey = 'pvr' | 'boq' | 'programme' | 'drawings' | 'contract' | 'productivity' | 'supporting';

export interface DocGroup {
  key: GroupKey;
  label: string;
  roles: FileRole[];
  /** Role a file is given when the user adds it directly to this group. */
  addAs: FileRole | null;
  optional: boolean;
  emptyHint: string;
}

export const DOC_GROUPS: DocGroup[] = [
  { key: 'pvr', label: 'PVR / change request', roles: ['pvr'], addAs: 'pvr', optional: true, emptyHint: 'Add the PVR, or describe the change below.' },
  { key: 'boq', label: 'BOQ & preambles', roles: ['boq'], addAs: 'boq', optional: false, emptyHint: 'Required for BOQ-based valuation.' },
  { key: 'programme', label: 'Programme', roles: ['schedule'], addAs: 'schedule', optional: false, emptyHint: 'Required for programme impact.' },
  { key: 'drawings', label: 'Drawings', roles: ['drawings'], addAs: 'drawings', optional: true, emptyHint: 'Only needed for drawing comparison.' },
  { key: 'contract', label: 'Contract & amendments', roles: ['contract'], addAs: 'contract', optional: true, emptyHint: 'Optional for an indicative estimate.' },
  { key: 'productivity', label: 'Productivity references', roles: ['reference'], addAs: 'reference', optional: true, emptyHint: 'Optional. Used later to turn quantities into durations.' },
  { key: 'supporting', label: 'Supporting evidence', roles: ['correspondence', 'site'], addAs: 'correspondence', optional: true, emptyHint: 'Add specifications or correspondence.' },
];

export function filesForGroup(files: ClassifiedFile[], g: DocGroup): ClassifiedFile[] {
  return files.filter((f) => g.roles.includes(f.role));
}

export function unusedFiles(files: ClassifiedFile[]): ClassifiedFile[] {
  return files.filter((f) => f.role === 'unused');
}

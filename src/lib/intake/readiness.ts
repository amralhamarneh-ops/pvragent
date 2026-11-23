import type { ClassifiedFile, FileRole } from '@/lib/intake/triage';

export type ReadyState = 'ready' | 'ready_assumptions' | 'choice' | 'missing' | 'not_processed';

export interface OutputReadiness {
  key: 'change' | 'cost' | 'programme' | 'contract';
  label: string;
  state: ReadyState;
  stateLabel: string;
  detail: string;
  /** Outputs blocked by this gap, plain language. */
  blocks?: string;
}

export interface ReadinessInput {
  files: ClassifiedFile[];
  /** True only after the triage service has returned for these files. */
  processed: boolean;
  /** Triage or upload error, if the files could not be processed. */
  failed: boolean;
  narrative: string;
  scheduleChoice: string;
}

const by = (files: ClassifiedFile[], r: FileRole) => files.filter((f) => f.role === r);

export function narrativeIsUsable(text: string): boolean {
  return text.trim().length >= 20;
}

export function computeReadiness(i: ReadinessInput): OutputReadiness[] {
  const hasNarrative = narrativeIsUsable(i.narrative);
  const uploaded = i.files.length > 0;
  const pvr = by(i.files, 'pvr');
  const boq = by(i.files, 'boq');
  const sched = by(i.files, 'schedule');
  const contract = by(i.files, 'contract');
  const pending = uploaded && !i.processed && !i.failed;

  const pendingNote = (what: string): OutputReadiness | null => {
    if (pending) return { key: 'change', label: '', state: 'not_processed', stateLabel: 'Not processed yet', detail: `${what}: files are added but have not been read yet. Select "Read my documents".` };
    return null;
  };

  // Change identification
  let change: OutputReadiness;
  if (pvr.length > 0 && i.processed) change = { key: 'change', label: 'Change identification', state: 'ready', stateLabel: 'Ready', detail: `Change request read: ${pvr[0].name}` };
  else if (hasNarrative) change = { key: 'change', label: 'Change identification', state: 'ready_assumptions', stateLabel: 'Ready with assumptions', detail: 'Based on your narrative. Quantities will be marked as narrative-stated.' };
  else if (pending && pvr.length > 0) change = { ...(pendingNote('Change request') as OutputReadiness), label: 'Change identification' };
  else change = { key: 'change', label: 'Change identification', state: 'missing', stateLabel: 'Missing evidence', detail: 'Add a PVR document or describe the change.', blocks: 'Blocks every output: nothing says what changed.' };

  // Cost assessment
  let cost: OutputReadiness;
  if (boq.length > 0 && i.processed && change.state !== 'missing') cost = { key: 'cost', label: 'Cost assessment', state: change.state === 'ready' ? 'ready' : 'ready_assumptions', stateLabel: change.state === 'ready' ? 'Ready' : 'Ready with assumptions', detail: `${boq.length} BOQ ${boq.length === 1 ? 'file' : 'files'} read.` };
  else if (boq.length > 0 && pending) cost = { key: 'cost', label: 'Cost assessment', state: 'not_processed', stateLabel: 'Not processed yet', detail: 'BOQ files are added but have not been read yet.' };
  else if (boq.length > 0) cost = { key: 'cost', label: 'Cost assessment', state: 'choice', stateLabel: 'Needs your choice', detail: 'BOQ is present but the change is not yet identified.' };
  else cost = { key: 'cost', label: 'Cost assessment', state: 'missing', stateLabel: 'Missing evidence', detail: 'No BOQ selected.', blocks: 'Blocks BOQ-based valuation. Scope can still proceed to a new-rate workflow.' };

  // Programme impact
  let programme: OutputReadiness;
  if (sched.length === 0) programme = { key: 'programme', label: 'Programme impact', state: 'missing', stateLabel: 'Missing evidence', detail: 'No schedule selected.', blocks: 'Cost assessment can continue. Programme impact is unavailable until a schedule is added.' };
  else if (pending) programme = { key: 'programme', label: 'Programme impact', state: 'not_processed', stateLabel: 'Not processed yet', detail: 'Schedule files are added but have not been read yet.' };
  else if (sched.length > 1 && !i.scheduleChoice) programme = { key: 'programme', label: 'Programme impact', state: 'choice', stateLabel: 'Confirm schedule', detail: `${sched.length} schedules found. Choose which one to assess against.`, blocks: 'Programme impact waits for this choice.' };
  else programme = { key: 'programme', label: 'Programme impact', state: 'ready', stateLabel: 'Ready', detail: 'Schedule selected.' };

  // Contract review
  let contractR: OutputReadiness;
  if (contract.length > 0 && i.processed) contractR = { key: 'contract', label: 'Contract review', state: 'ready', stateLabel: 'Ready', detail: `${contract.length} contract ${contract.length === 1 ? 'file' : 'files'} read.` };
  else if (contract.length > 0) contractR = { key: 'contract', label: 'Contract review', state: 'not_processed', stateLabel: 'Not processed yet', detail: 'Contract files are added but have not been read yet.' };
  else contractR = { key: 'contract', label: 'Contract review', state: 'missing', stateLabel: 'Evidence needed', detail: 'No contract or amendments selected.', blocks: 'Does not block an indicative cost assessment. Contract review is unavailable.' };

  return [change, cost, programme, contractR];
}

export function primaryAction(r: OutputReadiness[], hasFiles: boolean, processed: boolean, narrative: string): { label: string; kind: 'read' | 'confirm' | 'disabled'; hint: string } {
  let change = r.find((x) => x.key === 'change');
  if (hasFiles && !processed) return { label: 'Read my documents', kind: 'read', hint: 'Files must be read before readiness can be confirmed.' };
  if (!hasFiles && narrativeIsUsable(narrative)) return { label: 'Read my documents', kind: 'read', hint: 'Continue with the narrative only. Quantities will be marked as stated.' };
  if (!change || change.state === 'missing') return { label: 'Confirm documents', kind: 'disabled', hint: 'Add a PVR document or describe the change to continue.' };
  const unresolved = r.filter((x) => x.state === 'choice' || x.state === 'not_processed');
  if (unresolved.length > 0) return { label: 'Confirm documents', kind: 'disabled', hint: `Resolve first: ${unresolved.map((u) => u.label).join(', ')}.` };
  return { label: 'Confirm documents', kind: 'confirm', hint: '' };
}

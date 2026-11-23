import type { BoqModel } from './documents';
import { documentKeyOf } from './documents';

/**
 * Document coverage register. One row for EVERY uploaded document, so nothing can disappear silently.
 *
 * It distinguishes four separate facts that were previously blurred:
 *   uploaded   - the file reached the registry
 *   readable   - a reader exists for the file type and the contents parsed
 *   processed  - an analysis step actually ran on it
 *   used       - it contributed to the assessment (BOQ rows searched/valued, or evidence consulted)
 * Supporting evidence can be "reviewed" without contributing a quantity or a rate.
 */

export type AssessmentRole = 'boq' | 'evidence' | 'drawing' | 'programme' | 'contract' | 'other' | 'unused';
export type InclusionStatus = 'included' | 'excluded' | 'superseded' | 'duplicate' | 'reference';
export type ReadStatus = 'parsed' | 'readable_not_parsed' | 'unsupported' | 'failed' | 'not_attempted';

export interface RegisterDocInput {
  id: string;
  name: string;
  category: string;
  role: string;
  sha256: string;
  version: number;
  stored: boolean;
  storageDetail: string;
  state: string;
  stateDetail: string;
  hasBytes: boolean;
}

export interface AgentConsumption {
  /** Document names the run actually read, with what was consumed. */
  readNames: string[];
  /** Names the run could not read, with the reason. */
  unreadNotes: Record<string, string>;
  runAt: string | null;
  /** Signature of the BOQ set the run used, to decide whether it is current. */
  importSignature: string | null;
}

export interface CoverageRow {
  key: string;
  docId: string;
  file: string;
  category: string;
  revision: string;
  assessmentRole: string;
  inclusion: InclusionStatus;
  inclusionLabel: string;
  inclusionReason: string;
  storage: { stored: boolean; text: string };
  read: { status: ReadStatus; text: string };
  contentProcessed: string;
  unreadContent: string;
  consumedBy: string;
  analysis: 'current' | 'stale' | 'not_run' | 'not_applicable';
  analysisText: string;
  uploaded: boolean;
  readable: boolean;
  processed: boolean;
  used: boolean;
}

export interface CoverageTotals { uploaded: number; readable: number; processed: number; used: number; reviewedOnly: number; unread: number }

const READABLE_EXT = /\.(xlsx|csv|txt|md|json|eml|log|xer|dxf|pdf)$/i;
const BOQ_EXT = /\.(xlsx|csv)$/i;

function readOf(d: RegisterDocInput, isBoqParsed: boolean): { status: ReadStatus; text: string } {
  if (d.state === 'failed') return { status: 'failed', text: d.stateDetail || 'Reading failed.' };
  if (isBoqParsed) return { status: 'parsed', text: 'Workbook parsed into BOQ rows.' };
  if (d.state === 'parsed') return { status: 'parsed', text: d.stateDetail || 'Parsed.' };
  if (!d.hasBytes) return { status: 'not_attempted', text: 'The file contents are not in this browser, so it cannot be read until reconnected.' };
  if (/\.(dwg)$/i.test(d.name)) return { status: 'unsupported', text: 'DWG needs conversion before geometry can be read.' };
  if (!READABLE_EXT.test(d.name)) return { status: 'unsupported', text: 'No reader exists for this file type.' };
  return { status: 'readable_not_parsed', text: 'A reader exists but this file has not been processed yet.' };
}

/**
 * Build the register. `model` is the BOQ model of COMPLETE imports; `docs` is every document in the registry.
 * A BOQ workbook is matched to its document by hash (identical content) so a re-uploaded copy is shown as a duplicate.
 */
export function buildCoverage(docs: RegisterDocInput[], model: BoqModel, agent: AgentConsumption, currentSignature: string | null): { rows: CoverageRow[]; totals: CoverageTotals } {
  const revBySha = new Map<string, { docKey: string; label: 'selected' | 'superseded' | 'duplicate'; revision: number; importId: string; included: boolean; excludedReason: string }>();
  for (const d of model.documents) {
    for (const r of d.revisions) {
      // A duplicate shares its sha with the original; the original entry wins for display of the first occurrence.
      if (!revBySha.has(r.sha256) || r.label !== 'duplicate') revBySha.set(r.sha256, { docKey: d.key, label: r.label, revision: r.revision, importId: r.importId, included: d.included, excludedReason: d.excludedReason });
    }
  }
  const seenSha = new Set<string>();
  const rows: CoverageRow[] = [];
  const stale = !!agent.importSignature && !!currentSignature && agent.importSignature !== currentSignature;

  for (const d of docs) {
    const isBoqFile = d.role === 'boq' && BOQ_EXT.test(d.name);
    const rev = isBoqFile ? revBySha.get(d.sha256) : undefined;
    const docDup = seenSha.has(d.sha256);
    seenSha.add(d.sha256);

    let inclusion: InclusionStatus = 'reference';
    let reason = '';
    let revisionText = d.version > 1 ? `File version ${d.version}` : 'Version 1';
    let consumed = '';
    let used = false;
    let processed = false;
    let contentProcessed = '';
    let unreadContent = '';
    let analysis: CoverageRow['analysis'] = 'not_applicable';
    let analysisText = '';

    const parsedBoq = !!rev;
    const read = readOf(d, parsedBoq);

    if (isBoqFile) {
      if (!rev) {
        inclusion = 'excluded';
        reason = 'Not imported as BOQ rows yet (still being read, awaiting a question, or the import did not complete). It is not used until its import is complete.';
        analysis = 'not_run';
        analysisText = 'Not part of any analysis.';
      } else {
        revisionText = `Revision ${rev.revision}`;
        if (docDup) { inclusion = 'duplicate'; reason = 'Identical to another uploaded copy. Counted once; never valued twice.'; }
        else if (rev.label === 'duplicate') { inclusion = 'duplicate'; reason = 'Identical content was imported before. Counted once; never valued twice.'; }
        else if (!rev.included) { inclusion = 'excluded'; reason = rev.excludedReason || 'Excluded by you.'; }
        else if (rev.label === 'superseded') { inclusion = 'superseded'; reason = 'A different revision of this document is selected.'; }
        else { inclusion = 'included'; reason = 'Included in the assessment as the selected revision of its document.'; }
        const docModel = model.documents.find((x) => x.key === rev.docKey);
        const sel = docModel?.revisions.find((r) => r.importId === rev.importId);
        contentProcessed = sel ? `${sel.items} item row(s)${sel.unpriced ? `, ${sel.unpriced} without a rate` : ''}` : '';
        if (inclusion === 'included') {
          const ran = agent.readNames.some((n) => documentKeyOf(n) === rev.docKey);
          processed = ran; used = ran;
          consumed = ran ? `BOQ search, AI matching and valuation${agent.runAt ? ` (run ${agent.runAt.slice(0, 19).replace('T', ' ')} UTC)` : ''}` : 'Not yet consumed by an analysis run.';
          analysis = ran ? (stale ? 'stale' : 'current') : 'not_run';
          analysisText = ran ? (stale ? 'The BOQ set changed after the last run. Run the analysis again.' : 'Current: the last run used this exact set.') : 'No analysis has used it yet.';
        } else {
          consumed = 'Not consumed.';
          analysis = 'not_applicable';
          analysisText = inclusion === 'excluded' ? 'Excluded from analysis.' : 'Kept for provenance; not analysed.';
        }
      }
    } else {
      const named = agent.readNames.some((n) => documentKeyOf(n) === documentKeyOf(d.name));
      const unreadNote = agent.unreadNotes[d.name] ?? Object.entries(agent.unreadNotes).find(([n]) => documentKeyOf(n) === documentKeyOf(d.name))?.[1] ?? '';
      if (docDup) { inclusion = 'duplicate'; reason = 'Identical to another uploaded copy. Reviewed once.'; }
      else if (d.role === 'unused') { inclusion = 'reference'; reason = 'Not assigned a role in the assessment. Kept as a reference.'; }
      else { inclusion = 'reference'; reason = 'Supporting evidence: reviewed for context. It does not contribute a quantity or a rate by itself.'; }
      if (named) { processed = true; used = true; consumed = `Evidence read by the analysis${agent.runAt ? ` (run ${agent.runAt.slice(0, 19).replace('T', ' ')} UTC)` : ''}.`; contentProcessed = 'Text contents read.'; analysis = stale ? 'stale' : 'current'; analysisText = stale ? 'The case changed after the last run.' : 'Current.'; }
      else if (unreadNote) { processed = true; consumed = 'Listed by the analysis but not read.'; unreadContent = unreadNote; analysis = 'not_run'; analysisText = 'Its content did not reach the analysis.'; }
      else { consumed = 'Not yet consumed by an analysis run.'; analysis = 'not_run'; analysisText = 'No analysis has used it yet.'; if (read.status === 'unsupported') unreadContent = read.text; }
      if (d.state === 'parsed' && !named) { processed = true; contentProcessed = d.stateDetail || 'Parsed during intake.'; consumed = consumed || 'Processed during intake.'; }
    }

    const inclusionLabel = inclusion === 'included' ? 'Included in assessment'
      : inclusion === 'excluded' ? 'Excluded from assessment'
      : inclusion === 'superseded' ? 'Superseded revision'
      : inclusion === 'duplicate'? 'Duplicate upload' :'Reviewed as supporting evidence';

    rows.push({
      key: d.id,
      docId: d.id,
      file: d.name,
      category: d.category,
      revision: revisionText,
      assessmentRole: isBoqFile ? 'BOQ' : d.role === 'unused' ? 'Not assigned' : d.category,
      inclusion,
      inclusionLabel,
      inclusionReason: reason,
      storage: { stored: d.stored, text: d.stored ? 'Original stored privately' : d.storageDetail || 'Original NOT stored' },
      read,
      contentProcessed: contentProcessed || (read.status === 'parsed' ? 'Parsed.' : 'Nothing processed yet.'),
      unreadContent,
      consumedBy: consumed || 'Not consumed.',
      analysis,
      analysisText,
      uploaded: true,
      readable: read.status === 'parsed' || read.status === 'readable_not_parsed',
      processed,
      used,
    });
  }

  const totals: CoverageTotals = {
    uploaded: rows.length,
    readable: rows.filter((r) => r.readable).length,
    processed: rows.filter((r) => r.processed).length,
    used: rows.filter((r) => r.used).length,
    reviewedOnly: rows.filter((r) => r.inclusion === 'reference' && r.processed && !r.used).length,
    unread: rows.filter((r) => r.unreadContent !== '' || r.read.status === 'unsupported' || r.read.status === 'failed').length,
  };
  return { rows, totals };
}

/**
 * Detect the same BOQ work priced in more than one INCLUDED document (alternative commercial BOQs overlapping a
 * complementary bill). Pure and deterministic: same normalised description and unit and bill-independent reference.
 * Returned groups are surfaced for a human decision; nothing is dropped or valued twice silently.
 */
export function overlappingItems(items: { id: string; importId: string; sourceFile: string; ref: string; description: string; unit: string; sheet: string; rowNumber: number }[]): { signature: string; members: { id: string; sourceFile: string; ref: string; sheet: string; rowNumber: number }[] }[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const groups = new Map<string, typeof items>();
  for (const it of items) {
    const sig = `${norm(it.description)}|${norm(it.unit)}`;
    if (norm(it.description).length < 12) continue;
    const g = groups.get(sig) ?? [];
    g.push(it);
    groups.set(sig, g);
  }
  const out: { signature: string; members: { id: string; sourceFile: string; ref: string; sheet: string; rowNumber: number }[] }[] = [];
  for (const [signature, g] of groups) {
    if (new Set(g.map((x) => x.importId)).size < 2) continue;
    out.push({ signature, members: g.map((x) => ({ id: x.id, sourceFile: x.sourceFile, ref: x.ref, sheet: x.sheet, rowNumber: x.rowNumber })) });
  }
  return out;
}

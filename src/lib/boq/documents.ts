import type { BoqImport } from './types';

/**
 * BOQ data model.
 *
 *  - BOQ set       : every document included in this assessment.
 *  - BOQ document  : one bill or workbook, identified by a normalised document key (its file name).
 *  - Revision      : one import of that document. Two imports of the same document with different content are
 *                    competing revisions. Two imports with identical content are a duplicate upload.
 *
 * Different documents are complementary and are ALL included. Only revisions of the same document compete, and only
 * one revision per document is selected. Nothing here deletes anything: excluded, superseded and duplicate records
 * stay stored and remain available as provenance for saved calculations.
 */

export interface BoqInclusionState {
  /** Document keys the user excluded from the assessment. */
  excluded: Record<string, string>;
  /** Explicit selected revision (import id) per document key. Absent = the newest complete revision. */
  selected: Record<string, string>;
}

export const EMPTY_INCLUSION: BoqInclusionState = { excluded: {}, selected: {} };

/** Reserved key inside case evidence `answers`, so the state persists without a schema change. */
export const INCLUSION_ANSWER_KEY = '__boqInclusion';

export function documentKeyOf(fileName: string): string {
  return fileName.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function parseInclusion(answers: Record<string, string> | undefined | null): BoqInclusionState {
  const raw = answers?.[INCLUSION_ANSWER_KEY];
  if (!raw) return EMPTY_INCLUSION;
  try {
    const p = JSON.parse(raw) as Partial<BoqInclusionState>;
    return { excluded: p.excluded && typeof p.excluded === 'object' ? p.excluded : {}, selected: p.selected && typeof p.selected === 'object' ? p.selected : {} };
  } catch { return EMPTY_INCLUSION; }
}

export function serialiseInclusion(s: BoqInclusionState): string {
  return JSON.stringify(s);
}

export type RevisionLabel = 'selected' | 'superseded' | 'duplicate';

export interface DocumentRevision {
  importId: string;
  revision: number;
  revisionLabel: string;
  sha256: string;
  confirmedAt: string | null;
  label: RevisionLabel;
  /** Import id of the earlier identical upload when label is 'duplicate'. */
  duplicateOf: string | null;
  items: number;
  unpriced: number;
}

export interface BoqDocument {
  key: string;
  fileName: string;
  included: boolean;
  /** Why the document is excluded (empty when included). */
  excludedReason: string;
  /** Import id of the selected revision, or null when the document has no complete revision. */
  selectedImportId: string | null;
  revisions: DocumentRevision[];
  /** More than one distinct content version exists, so the user may need to choose. */
  competing: boolean;
}

export interface BoqModel {
  documents: BoqDocument[];
  /** One import per included document: exactly what search, AI matching and valuation use. */
  assessmentImports: BoqImport[];
  includedDocuments: number;
  excludedDocuments: number;
  /** Selected revisions of included documents. */
  selectedRevisions: number;
  duplicateUploads: number;
  supersededRevisions: number;
  itemCount: number;
  summary: string;
}

function countItems(imp: BoqImport): { items: number; unpriced: number } {
  let items = 0; let unpriced = 0;
  for (const r of imp.rows) {
    if (!r.included || (r.rowClass !== 'item' && r.rowClass !== 'unpriced_item')) continue;
    items += 1;
    if (r.rate.state !== 'value') unpriced += 1;
  }
  return { items, unpriced };
}

/**
 * Group complete imports into documents and revisions.
 *
 * Revision rules, per document key:
 *  - Imports are ordered by revision number. The first import carrying a given SHA-256 is the "original upload" of that
 *    content; any later import with the same SHA-256 is a duplicate upload and never competes or is valued.
 *  - Distinct contents are competing revisions. The selected one is the user's explicit choice when it still exists,
 *    else (for the legacy case-level selection) the case's selected import when it belongs to this document, else the newest.
 */
export function buildBoqModel(imports: BoqImport[], inclusion: BoqInclusionState = EMPTY_INCLUSION, caseSelectedImportId: string | null = null): BoqModel {
  const complete = imports.filter((i) => i.confirmedAt);
  const byKey = new Map<string, BoqImport[]>();
  for (const imp of complete) {
    const k = documentKeyOf(imp.source.fileName);
    const list = byKey.get(k) ?? [];
    list.push(imp);
    byKey.set(k, list);
  }

  const documents: BoqDocument[] = [];
  const assessmentImports: BoqImport[] = [];
  let duplicateUploads = 0; let supersededRevisions = 0; let itemCount = 0; let selectedRevisions = 0;

  for (const [key, list] of byKey) {
    const ordered = [...list].sort((a, b) => a.revision - b.revision || a.id.localeCompare(b.id));
    const firstBySha = new Map<string, BoqImport>();
    for (const imp of ordered) if (!firstBySha.has(imp.source.sha256)) firstBySha.set(imp.source.sha256, imp);
    const distinct = Array.from(firstBySha.values());

    let selected: BoqImport | null = null;
    const wanted = inclusion.selected[key];
    if (wanted) {
      const w = ordered.find((i) => i.id === wanted);
      if (w) selected = firstBySha.get(w.source.sha256) ?? w;
    }
    if (!selected && caseSelectedImportId) {
      const c = ordered.find((i) => i.id === caseSelectedImportId);
      if (c) selected = firstBySha.get(c.source.sha256) ?? c;
    }
    if (!selected) selected = distinct[distinct.length - 1] ?? null;

    const isExcluded = Object.prototype.hasOwnProperty.call(inclusion.excluded, key);
    const excludedReason = isExcluded ? inclusion.excluded[key] : '';
    const included = !isExcluded;

    const revisions: DocumentRevision[] = ordered.map((imp) => {
      const first = firstBySha.get(imp.source.sha256);
      const isDuplicate = !!first && first.id !== imp.id;
      const label: RevisionLabel = isDuplicate ? 'duplicate' : selected && imp.source.sha256 === selected.source.sha256 ? 'selected' : 'superseded';
      const n = countItems(imp);
      return { importId: imp.id, revision: imp.revision, revisionLabel: imp.source.revisionLabel, sha256: imp.source.sha256, confirmedAt: imp.confirmedAt, label, duplicateOf: isDuplicate ? first!.id : null, items: n.items, unpriced: n.unpriced };
    });
    duplicateUploads += revisions.filter((r) => r.label === 'duplicate').length;
    supersededRevisions += revisions.filter((r) => r.label === 'superseded').length;

    documents.push({ key, fileName: selected?.source.fileName ?? ordered[0].source.fileName, included, excludedReason: included ? '' : excludedReason || 'Excluded by you.', selectedImportId: selected?.id ?? null, revisions, competing: distinct.length > 1 });
    if (included && selected) {
      assessmentImports.push(selected);
      selectedRevisions += 1;
      itemCount += countItems(selected).items;
    }
  }

  documents.sort((a, b) => a.fileName.localeCompare(b.fileName));
  assessmentImports.sort((a, b) => a.source.fileName.localeCompare(b.source.fileName));
  const includedDocuments = documents.filter((d) => d.included).length;
  const excludedDocuments = documents.length - includedDocuments;
  const summary = `${includedDocuments} BOQ document${includedDocuments === 1 ? '' : 's'} included; 1 selected revision per document.${excludedDocuments ? ` ${excludedDocuments} excluded.` : ''}${duplicateUploads ? ` ${duplicateUploads} duplicate upload${duplicateUploads === 1 ? '' : 's'} ignored.` : ''}`;
  return { documents, assessmentImports, includedDocuments, excludedDocuments, selectedRevisions, duplicateUploads, supersededRevisions, itemCount, summary };
}

export const REVISION_LABEL_TEXT: Record<RevisionLabel, string> = {
  selected: 'Selected revision',
  superseded: 'Superseded revision',
  duplicate: 'Duplicate upload',
};

/** Stable identity of one parsed upload: the document and its exact content. */
export function uploadIdentity(fileName: string, sha256: string): string {
  return `${documentKeyOf(fileName)}#${sha256}`;
}

export type UploadDecision =
  | { kind: 'new_document' }
  | { kind: 'new_revision'; previous: BoqImport }
  | { kind: 'duplicate'; existing: BoqImport };

/**
 * Decide what an incoming parsed workbook is relative to the case, BEFORE anything is written.
 * Identical content for the same document is a duplicate and must reuse the existing import (idempotent).
 */
export function classifyUpload(fileName: string, sha256: string, existing: BoqImport[]): UploadDecision {
  const key = documentKeyOf(fileName);
  const same = existing.filter((i) => i.confirmedAt && documentKeyOf(i.source.fileName) === key);
  const dup = same.find((i) => i.source.sha256 === sha256);
  if (dup) return { kind: 'duplicate', existing: dup };
  if (same.length === 0) return { kind: 'new_document' };
  return { kind: 'new_revision', previous: [...same].sort((a, b) => b.revision - a.revision)[0] };
}

/**
 * Safe reconciliation report for duplicates that already exist. Nothing is deleted: duplicates keep their rows and any
 * calculation that references them. They are simply never valued twice.
 */
export function duplicateReport(model: BoqModel): { documentKey: string; fileName: string; keptImportId: string; duplicateImportIds: string[] }[] {
  return model.documents
    .map((d) => ({ documentKey: d.key, fileName: d.fileName, keptImportId: d.revisions.find((r) => r.label !== 'duplicate' && r.sha256 === d.revisions.find((x) => x.importId === d.selectedImportId)?.sha256)?.importId ?? d.selectedImportId ?? '', duplicateImportIds: d.revisions.filter((r) => r.label === 'duplicate').map((r) => r.importId) }))
    .filter((r) => r.duplicateImportIds.length > 0);
}

/** Items from the assessment set, with each source row appearing once even if two documents repeat the same import. */
export function dedupeImports(imports: BoqImport[]): BoqImport[] {
  const seen = new Set<string>();
  const out: BoqImport[] = [];
  for (const i of imports) {
    if (seen.has(i.id)) continue;
    seen.add(i.id);
    out.push(i);
  }
  return out;
}

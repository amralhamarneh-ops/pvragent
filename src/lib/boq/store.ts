import type { BoqImport, CaseRecord } from './types';

/**
 * Storage contract for real cases. Two implementations exist:
 *  - Supabase REST (server side, via /api/boq-cases)
 *  - Memory (tests only, and the labelled session-only fallback in the browser)
 * Nothing in this contract returns fixture data. A case that does not exist returns null.
 */
export interface CaseStore {
  createCase(c: CaseRecord): Promise<CaseRecord>;
  getCase(id: string): Promise<CaseRecord | null>;
  listImports(caseId: string): Promise<BoqImport[]>;
  saveImport(imp: BoqImport): Promise<BoqImport>;
  selectImport(caseId: string, importId: string): Promise<CaseRecord>;
}

export class MemoryCaseStore implements CaseStore {
  private cases = new Map<string, CaseRecord>();
  private imports = new Map<string, BoqImport[]>();

  async createCase(c: CaseRecord): Promise<CaseRecord> {
    if (this.cases.has(c.id)) throw new Error(`Case ${c.id} already exists.`);
    this.cases.set(c.id, { ...c });
    this.imports.set(c.id, []);
    return { ...c };
  }
  async getCase(id: string): Promise<CaseRecord | null> {
    const c = this.cases.get(id);
    return c ? { ...c } : null;
  }
  async listImports(caseId: string): Promise<BoqImport[]> {
    return (this.imports.get(caseId) ?? []).map((i) => JSON.parse(JSON.stringify(i)) as BoqImport);
  }
  async saveImport(imp: BoqImport): Promise<BoqImport> {
    const c = this.cases.get(imp.caseId);
    if (!c) throw new Error(`Case ${imp.caseId} does not exist.`);
    const list = this.imports.get(imp.caseId) ?? [];
    const existing = list.findIndex((i) => i.id === imp.id);
    const copy = JSON.parse(JSON.stringify(imp)) as BoqImport;
    if (existing >= 0) list[existing] = copy; else list.push(copy);
    this.imports.set(imp.caseId, list);
    if (imp.confirmedAt && !c.selectedImportId) this.cases.set(c.id, { ...c, selectedImportId: imp.id });
    return copy;
  }
  async selectImport(caseId: string, importId: string): Promise<CaseRecord> {
    const c = this.cases.get(caseId);
    if (!c) throw new Error(`Case ${caseId} does not exist.`);
    const imp = (this.imports.get(caseId) ?? []).find((i) => i.id === importId);
    if (!imp) throw new Error('That import does not belong to this case.');
    if (!imp.confirmedAt) throw new Error('Only a confirmed import can be selected.');
    const next = { ...c, selectedImportId: importId };
    this.cases.set(caseId, next);
    return { ...next };
  }
}

/** Highest revision number plus one. Revisions are per case. */
export function nextRevision(imports: BoqImport[]): number {
  return imports.reduce((m, i) => Math.max(m, i.revision), 0) + 1;
}

export function newId(prefix: string): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${rnd}`;
}

export function newCase(title: string, currency: string): CaseRecord {
  return { id: newId('case'), title, mode: 'real', currency, createdAt: new Date().toISOString(), selectedImportId: null };
}

/** The records a calculation may use for a case: only the selected, confirmed import. */
export function selectedImportOf(c: CaseRecord | null, imports: BoqImport[]): BoqImport | null {
  if (!c || !c.selectedImportId) return null;
  const imp = imports.find((i) => i.id === c.selectedImportId && i.caseId === c.id);
  return imp && imp.confirmedAt ? imp : null;
}

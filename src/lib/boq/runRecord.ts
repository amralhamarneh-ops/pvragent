/**
 * Small record of what the last BOQ analysis run consumed. Written by the workspace after a run and read by the
 * coverage register, so the register states real consumption (which documents, which run, which set) rather than
 * guessing. Stored per case in this browser only; it is a display aid, never an input to any calculation.
 */
export interface RunRecord {
  runAt: string;
  importSignature: string;
  /** File names of the BOQ documents in the set the run used. */
  boqFiles: string[];
  /** Evidence documents the run read, and those it listed but could not read (with the reason). */
  evidenceRead: string[];
  evidenceUnread: Record<string, string>;
}

const KEY = (caseId: string) => `pvr-last-run:${caseId}`;

export function writeRunRecord(caseId: string, r: RunRecord): void {
  try { window.localStorage.setItem(KEY(caseId), JSON.stringify(r)); } catch { /* display aid only */ }
}

export function readRunRecord(caseId: string): RunRecord | null {
  try {
    const raw = window.localStorage.getItem(KEY(caseId));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<RunRecord>;
    if (!p || typeof p.runAt !== 'string' || typeof p.importSignature !== 'string' || !Array.isArray(p.boqFiles)) return null;
    return { runAt: p.runAt, importSignature: p.importSignature, boqFiles: p.boqFiles, evidenceRead: Array.isArray(p.evidenceRead) ? p.evidenceRead : [], evidenceUnread: p.evidenceUnread && typeof p.evidenceUnread === 'object' ? p.evidenceUnread : {} };
  } catch { return null; }
}

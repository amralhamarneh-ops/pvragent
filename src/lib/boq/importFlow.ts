import { interpretWorkbook } from './interpret';
import { interpretWorkbookAuto, type WorkbookInterpretation } from './autoInterpret';
import { readWorkbook } from './readers';
import { newId } from './store';
import type { BoqImport, RawWorkbook, SheetMapping } from './types';

export interface StagedImport {
  workbook: RawWorkbook;
  mappings: SheetMapping[];
  /** How the structure was inferred, including any genuine ambiguity. */
  interpretation: WorkbookInterpretation;
}

/** Step 1: read the uploaded bytes and infer sheet selection, header rows and columns automatically. */
export async function stageUpload(fileName: string, bytes: Uint8Array): Promise<StagedImport> {
  const workbook = await readWorkbook(fileName, bytes);
  const interpretation = interpretWorkbookAuto(workbook.sheets);
  return { workbook, mappings: interpretation.mappings, interpretation };
}

/** Step 2: apply the inferred (or user-corrected) mapping to produce reviewable rows. */
export function buildImport(args: { caseId: string; staged: StagedImport; mappings: SheetMapping[]; currency: string; revisionLabel: string; revision: number; rowOverrides?: Record<string, boolean> }): { imp: BoqImport; warnings: string[] } {
  const { workbook } = args.staged;
  const res = interpretWorkbook(workbook.sheets, args.mappings);
  const rows = res.rows.map((r) => (args.rowOverrides && r.id in args.rowOverrides ? { ...r, included: args.rowOverrides[r.id] } : r));
  const imp: BoqImport = {
    id: newId('imp'),
    caseId: args.caseId,
    revision: args.revision,
    source: { fileName: workbook.fileName, sha256: workbook.sha256, sizeBytes: workbook.sizeBytes, format: workbook.format, currency: args.currency, revisionLabel: args.revisionLabel },
    mappings: args.mappings,
    rows,
    confirmedAt: null,
  };
  return { imp, warnings: [...workbook.warnings, ...res.warnings] };
}

/** Step 3: the reviewer confirms. Only confirmed imports can be selected for calculation. */
export function confirmImport(imp: BoqImport, when = new Date().toISOString()): BoqImport {
  return { ...imp, confirmedAt: when };
}

/** True when the structure was inferred cleanly: nothing ambiguous and every included sheet validated. */
export function needsNoQuestion(staged: StagedImport): boolean {
  return staged.interpretation.clear;
}

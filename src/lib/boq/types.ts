/** Types for the real BOQ import and cost workflow. No fixtures live in this folder. */

export type FormulaStatus = 'none' | 'cached' | 'no_cached_value' | 'error';

export interface RawCell {
  /** A1-style address, for example "E4". */
  address: string;
  /** Display/value text. Empty string when the cell is blank. */
  text: string;
  /** True when the cell contained nothing at all (distinct from "0"). */
  blank: boolean;
  /** True when the cell held a numeric value. */
  numeric: boolean;
  numberText?: string;
  formula?: string;
  formulaStatus: FormulaStatus;
}

export interface RawSheet {
  name: string;
  /** rows[i] is sheet row number rowNumbers[i]. Rows keep their original number. */
  rows: { rowNumber: number; cells: RawCell[] }[];
  /** Maximum column count seen. */
  columnCount: number;
}

export interface RawWorkbook {
  fileName: string;
  /** SHA-256 of the exact bytes uploaded. This is the file version. */
  sha256: string;
  sizeBytes: number;
  format: 'xlsx' | 'csv';
  sheets: RawSheet[];
  warnings: string[];
}

export type MappedField = 'ref' | 'description' | 'unit' | 'quantity' | 'rate' | 'amount';
export const MAPPED_FIELDS: MappedField[] = ['ref', 'description', 'unit', 'quantity', 'rate', 'amount'];
export const FIELD_LABEL: Record<MappedField, string> = {
  ref: 'BOQ reference',
  description: 'Description',
  unit: 'Unit',
  quantity: 'Quantity',
  rate: 'Rate',
  amount: 'Amount',
};

/** Zero-based column index per field, or null when not mapped. */
export type ColumnMap = Record<MappedField, number | null>;

export interface SheetMapping {
  sheet: string;
  included: boolean;
  /** Sheet row number of the header row, or null if none. Rows above are title rows. */
  headerRow: number | null;
  columns: ColumnMap;
}

export type RowClass = 'item' | 'title' | 'blank' | 'repeated_heading' | 'subtotal' | 'bill_heading' | 'unpriced_item' | 'note';

export interface RateValue {
  /** 'value' = a number was present (including an explicit 0). 'missing' = blank. 'invalid' = text that is not a number. */
  state: 'value' | 'missing' | 'invalid';
  /** Source text exactly as imported. */
  text: string;
  /** Decimal string when state is 'value'. */
  value?: string;
  explicitZero?: boolean;
  cell: string;
  formula?: string;
  formulaStatus: FormulaStatus;
}

export interface QuantityValue {
  state: 'value' | 'missing' | 'invalid';
  text: string;
  value?: string;
  cell?: string;
}

export interface ParsedRow {
  id: string;
  sheet: string;
  rowNumber: number;
  rowClass: RowClass;
  /** Why it was classified this way. Shown in the review table. */
  classReason: string;
  bill: string;
  ref: string;
  description: string;
  unit: string;
  quantity: QuantityValue;
  rate: RateValue;
  amount: { text: string; value?: string; cell?: string };
  cells: Partial<Record<MappedField, string>>;
  /** User can exclude a row at review. */
  included: boolean;
  issues: string[];
}

export interface ImportSource {
  fileName: string;
  sha256: string;
  sizeBytes: number;
  format: 'xlsx' | 'csv';
  currency: string;
  /** Free-text revision label chosen by the user, for example "Rev A". */
  revisionLabel: string;
  /** Private-bucket object path of the original file. Absent until the upload to the bucket succeeded. */
  storagePath?: string;
  /** True only after the original file was written to the private bucket. */
  fileStored?: boolean;
  /** When the original file was uploaded to the bucket. */
  uploadedAt?: string;
}

export interface BoqImport {
  id: string;
  caseId: string;
  source: ImportSource;
  mappings: SheetMapping[];
  rows: ParsedRow[];
  confirmedAt: string | null;
  /** Monotonic number for this case. A later import supersedes an earlier one only when selected. */
  revision: number;
}

export interface BoqItemRecord {
  id: string;
  importId: string;
  caseId: string;
  sheet: string;
  rowNumber: number;
  bill: string;
  ref: string;
  description: string;
  unit: string;
  rate: RateValue;
  quantity: QuantityValue;
  cells: Partial<Record<MappedField, string>>;
  sourceFile: string;
  sourceSha256: string;
  currency: string;
}

export interface CaseRecord {
  id: string;
  title: string;
  mode: 'real' | 'demo';
  currency: string;
  createdAt: string;
  /** Import revision selected for calculation. */
  selectedImportId: string | null;
  /** Auth user that owns the case. Set by the server from the verified session, never taken from the client. */
  ownerId?: string;
}

export type ChangeDirection = 'addition' | 'omission';

/** Supporting dimension supplied for a derivation, e.g. width 3 m. */
export interface DerivationInputRecord {
  name: string;
  value: string;
  unit: string;
}

export interface ConversionAuditRecord {
  type: 'identity' | 'same_dimension' | 'derivation';
  originalQuantity: string;
  originalUnit: string;
  derivedQuantity: string;
  derivedUnit: string;
  derivation: string;
  supportingInputs: { name: string; value: string; unit: string; valueInBaseUnit: string }[];
  basis: { kind: 'source' | 'user_confirmed'; statement: string } | null;
}

export type CalcResult =
  | { ok: true; direction: ChangeDirection; quantity: string; quantityUnit: string; boqUnit: string; converted: string; rate: string; currency: string; signedAmount: string; formula: string; itemId: string; conversion: ConversionAuditRecord; sources: { file: string; sha256: string; sheet: string; rateCell: string; refCell?: string; unitCell?: string }[]; rateFormulaNote?: string }
  | { ok: false; kind: 'unpriced' | 'unit_mismatch' | 'invalid_input' | 'no_item' | 'unsupported'; message: string; itemId?: string };
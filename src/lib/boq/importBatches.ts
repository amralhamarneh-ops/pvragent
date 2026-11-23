import type { ParsedRow } from './types';

/**
 * Staged-import batching. Pure functions only (no network), shared by the browser client, the API routes and the tests.
 *
 * Batches are bounded by SERIALISED UTF-8 BYTES as well as by row count. A fixed row count alone is not safe because
 * description lengths vary. The byte ceiling is deliberately well below the commonly documented ~4.5 MB serverless
 * request-body limit. The real limit of the deployment host has NOT been verified from its logs.
 */

/** Maximum serialised JSON bytes of one batch request body (rows + envelope). */
export const MAX_BATCH_BYTES = 1_000_000;
/** Maximum rows in one batch, applied together with the byte ceiling. */
export const MAX_BATCH_ROWS = 500;
/** Envelope allowance (importId, batchId, checksum, counts) reserved inside MAX_BATCH_BYTES. */
export const ENVELOPE_BYTES = 2_000;
/** A single row larger than this cannot be sent in any batch. It is reported, never truncated. */
export const MAX_ROW_BYTES = MAX_BATCH_BYTES - ENVELOPE_BYTES;

export interface BatchPlan {
  /** Zero-based position in the import. */
  index: number;
  /** Stable id derived from the import id, position and checksum, so a retry sends the same id. */
  batchId: string;
  /** Index of the first row of this batch within the full ordered row list. */
  start: number;
  rows: ParsedRow[];
  /** Serialised UTF-8 bytes of the rows array. */
  bytes: number;
  /** SHA-256 hex of the serialised rows array. */
  checksum: string;
}

export interface OversizedRow {
  rowId: string;
  sheet: string;
  rowNumber: number;
  bytes: number;
}

export interface BatchPlanResult {
  batches: BatchPlan[];
  totalRows: number;
  /** Rows that individually exceed MAX_ROW_BYTES. When non-empty, the import cannot be saved and nothing is dropped. */
  oversized: OversizedRow[];
  /** Checksum over every batch checksum in order, used to verify the whole import at finalisation. */
  importChecksum: string;
}

const encoder = new TextEncoder();

export function utf8Bytes(s: string): number {
  return encoder.encode(s).byteLength;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Canonical serialisation of a batch's rows. Client and server must use exactly this. */
export function serialiseRows(rows: ParsedRow[]): string {
  return JSON.stringify(rows);
}

/**
 * Split ordered rows into batches that each stay under the byte ceiling and the row ceiling.
 * Row order is preserved exactly. No row is dropped, merged or truncated.
 */
export async function planBatches(importId: string, rows: ParsedRow[], opts: { maxBytes?: number; maxRows?: number } = {}): Promise<BatchPlanResult> {
  const maxBytes = opts.maxBytes ?? MAX_BATCH_BYTES;
  const maxRows = opts.maxRows ?? MAX_BATCH_ROWS;
  const rowLimit = maxBytes - ENVELOPE_BYTES;
  const groups: { start: number; rows: ParsedRow[] }[] = [];
  const oversized: OversizedRow[] = [];
  let cur: ParsedRow[] = [];
  let curBytes = 2; // the surrounding [ ]
  let curStart = 0;
  rows.forEach((r, i) => {
    const b = utf8Bytes(JSON.stringify(r));
    if (b > rowLimit) oversized.push({ rowId: r.id, sheet: r.sheet, rowNumber: r.rowNumber, bytes: b });
    const add = b + (cur.length ? 1 : 0); // comma
    if (cur.length > 0 && (cur.length >= maxRows || curBytes + add > rowLimit)) {
      groups.push({ start: curStart, rows: cur });
      cur = [];
      curBytes = 2;
      curStart = i;
    }
    cur.push(r);
    curBytes += b + (cur.length > 1 ? 1 : 0);
  });
  if (cur.length) groups.push({ start: curStart, rows: cur });

  const batches: BatchPlan[] = [];
  const sums: string[] = [];
  for (let index = 0; index < groups.length; index++) {
    const g = groups[index];
    const text = serialiseRows(g.rows);
    const checksum = await sha256Hex(text);
    sums.push(checksum);
    batches.push({ index, batchId: `${importId}:b${String(index).padStart(5, '0')}:${checksum.slice(0, 12)}`, start: g.start, rows: g.rows, bytes: utf8Bytes(text), checksum });
  }
  return { batches, totalRows: rows.length, oversized, importChecksum: await sha256Hex(sums.join('|')) };
}

/** Serialised size of a request body, for the diagnostic record. Never includes document contents in logs. */
export function bodyBytes(body: string): number {
  return utf8Bytes(body);
}

export type BatchState = 'pending' | 'saved';

export interface BatchStatus {
  batchId: string;
  index: number;
  rowCount: number;
  checksum: string;
  state: BatchState;
}

/** Small acknowledgement returned for every staged operation. Never contains rows. */
export interface StageAck {
  importId: string;
  status: 'pending' | 'complete';
  expectedRows: number;
  expectedBatches: number;
  savedRows: number;
  savedBatches: number;
  /** Batch ids already stored, so a client can resume only the missing ones. */
  savedBatchIds: string[];
  /** Set for the batch just handled. */
  batch?: { batchId: string; state: 'saved' | 'already_saved'; rowCount: number };
}

export interface InitPayload {
  importId: string;
  revision: number;
  expectedRows: number;
  expectedBatches: number;
  importChecksum: string;
  /** Small metadata only: no rows. */
  meta: {
    fileName: string;
    sha256: string;
    sizeBytes: number;
    format: 'xlsx' | 'csv';
    currency: string;
    revisionLabel: string;
    mappings: unknown;
    confirmedAt: string | null;
    storagePath?: string | null;
    uploadedAt?: string | null;
    fileStored?: boolean;
  };
}

export interface BatchPayload {
  importId: string;
  batchId: string;
  index: number;
  checksum: string;
  rows: ParsedRow[];
}

/** Server-side validation of a batch envelope. Returns an error message or an empty string. */
export async function verifyBatch(b: BatchPayload): Promise<string> {
  if (!b || typeof b.importId !== 'string' || typeof b.batchId !== 'string' || !Number.isInteger(b.index) || b.index < 0) return 'The batch is malformed.';
  if (!Array.isArray(b.rows) || b.rows.length === 0) return 'The batch has no rows.';
  if (b.rows.length > MAX_BATCH_ROWS) return `A batch may hold at most ${MAX_BATCH_ROWS} rows.`;
  if (!/^[a-f0-9]{64}$/.test(b.checksum ?? '')) return 'The batch checksum is missing or invalid.';
  const actual = await sha256Hex(serialiseRows(b.rows));
  if (actual !== b.checksum) return 'The batch contents do not match their checksum. Nothing was stored for this batch.';
  if (!b.batchId.startsWith(`${b.importId}:b`)) return 'The batch id does not belong to this import.';
  return '';
}

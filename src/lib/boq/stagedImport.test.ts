import { describe, expect, it } from 'vitest';
import { SupabaseRestStore, AccessDeniedError, type VerifiedUser } from './supabaseStore';
import { MAX_BATCH_BYTES, MAX_BATCH_ROWS, MAX_ROW_BYTES, planBatches, serialiseRows, sha256Hex, utf8Bytes, verifyBatch, type InitPayload } from './importBatches';
import { newCase } from './store';
import { selectedImportOf } from './store';
import type { ParsedRow } from './types';

/**
 * Staged BOQ import tests. They run the REAL SupabaseRestStore and importBatches code against a fake PostgREST that
 * models the staged-import schema: the batch ledger, import_status, deterministic row ids with merge-duplicates, owner
 * filtering, and a finalise function that applies the same completeness checks as pvr_finalise_boq_import.
 * They do NOT prove the live database function; that needs the migration applied.
 */

const URL_ = 'https://fake.supabase.test';
const ANON = 'anon-key';

interface Row { [k: string]: unknown }

function makeServer(opts: { failBatchWrite?: (batchIndex: number) => boolean } = {}) {
  const tables: Record<string, Row[]> = { pvr_cases: [], pvr_boq_imports: [], pvr_boq_rows: [], pvr_boq_import_batches: [] };
  const sessions: Record<string, string> = { 'token-alice': 'alice', 'token-bob': 'bob' };
  const counters = { rowInserts: 0, batchInserts: 0, maxBodyBytes: 0, requests: 0 };
  const matches = (row: Row, q: URLSearchParams) => {
    for (const [k, v] of q.entries()) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;
      if (v.startsWith('eq.') && String(row[k]) !== decodeURIComponent(v.slice(3))) return false;
    }
    return true;
  };
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    counters.requests += 1;
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const headers = new Headers(init?.headers);
    const token = (headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (init?.body) counters.maxBodyBytes = Math.max(counters.maxBodyBytes, utf8Bytes(String(init.body)));
    const uid = sessions[token];
    if (!uid) return new Response('{"code":"42501","message":"row-level security"}', { status: 401 });
    const path = url.pathname.replace('/rest/v1/', '');
    const q = url.searchParams;
    const method = init?.method ?? 'GET';

    if (path === 'rpc/pvr_finalise_boq_import') {
      const b = JSON.parse(String(init?.body)) as { p_case_id: string; p_import_id: string; p_import_checksum: string };
      const imp = tables.pvr_boq_imports.find((r) => r.id === b.p_import_id && r.case_id === b.p_case_id && r.owner_id === uid);
      if (!imp) return new Response(JSON.stringify({ ok: false, code: 'not_found', message: 'That import was not found for this case.' }), { status: 200 });
      if (imp.import_status === 'complete') return new Response(JSON.stringify({ ok: true, already: true }), { status: 200 });
      if (imp.import_checksum !== b.p_import_checksum) return new Response(JSON.stringify({ ok: false, code: 'checksum_mismatch', message: 'checksum' }), { status: 200 });
      const ledger = tables.pvr_boq_import_batches.filter((r) => r.import_id === b.p_import_id);
      const rows = tables.pvr_boq_rows.filter((r) => r.import_id === b.p_import_id);
      const batchRows = ledger.reduce((n, r) => n + Number(r.row_count), 0);
      if (ledger.length !== imp.expected_batches || batchRows !== imp.expected_rows || rows.length !== imp.expected_rows) return new Response(JSON.stringify({ ok: false, code: 'incomplete', message: 'The import is not complete yet.' }), { status: 200 });
      imp.import_status = 'complete';
      imp.confirmed_at = imp.pending_confirmed_at ?? imp.confirmed_at;
      const c = tables.pvr_cases.find((x) => x.id === b.p_case_id);
      if (c && !c.selected_import_id && imp.pending_confirmed_at) c.selected_import_id = imp.id;
      return new Response(JSON.stringify({ ok: true, already: false }), { status: 200 });
    }

    const rows = tables[path];
    if (!rows) return new Response('{"code":"PGRST205","message":"missing"}', { status: 404 });
    if (method === 'GET') {
      let out = rows.filter((r) => r.owner_id === uid && matches(r, q));
      const order = q.get('order') ?? '';
      if (order.startsWith('sheet.asc,row_number.asc')) out = [...out].sort((a, b) => (a.sheet === b.sheet ? Number(a.row_number) - Number(b.row_number) : String(a.sheet).localeCompare(String(b.sheet))));
      if (order.startsWith('batch_index')) out = [...out].sort((a, b) => Number(a.batch_index) - Number(b.batch_index));
      let off = Number(q.get('offset') ?? 0);
      const lim = q.get('limit') ? Number(q.get('limit')) : out.length;
      return new Response(JSON.stringify(out.slice(off, off + lim)), { status: 200 });
    }
    if (method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Row | Row[];
      const list = Array.isArray(body) ? body : [body];
      for (const r of list) {
        if (r.owner_id !== uid) return new Response('{"code":"42501","message":"new row violates row-level security policy"}', { status: 403 });
        if (path === 'pvr_boq_imports' && r.import_status === 'pending' && r.confirmed_at) return new Response('{"code":"23514","message":"pending cannot be confirmed"}', { status: 400 });
        if (path !== 'pvr_cases') {
          const c = tables.pvr_cases.find((x) => x.id === r.case_id);
          if (!c || c.owner_id !== uid) return new Response('{"code":"42501","message":"Not permitted to write to case"}', { status: 403 });
        }
        if (path === 'pvr_boq_import_batches' && opts.failBatchWrite?.(Number(r.batch_index))) return new Response('{"message":"boom"}', { status: 500 });
        const key = path === 'pvr_boq_import_batches' ? 'batch_id' : 'id';
        const i = rows.findIndex((x) => x[key] === r[key]);
        if (i >= 0 && q.get('on_conflict')) rows[i] = { ...rows[i], ...r };
        else if (i >= 0) return new Response('{"code":"23505","message":"duplicate key"}', { status: 409 });
        else rows.push(r);
        if (path === 'pvr_boq_rows') counters.rowInserts += 1;
        if (path === 'pvr_boq_import_batches') counters.batchInserts += 1;
      }
      return new Response(/return=representation/i.test(headers.get('prefer') ?? '') ? JSON.stringify(list) : null, { status: 201 });
    }
    if (method === 'PATCH') {
      const patch = JSON.parse(String(init?.body)) as Row;
      const hit = rows.filter((r) => r.owner_id === uid && matches(r, q));
      hit.forEach((r) => Object.assign(r, patch));
      return new Response(JSON.stringify(hit), { status: 200 });
    }
    if (method === 'DELETE') {
      tables[path] = rows.filter((r) => !(r.owner_id === uid && matches(r, q)));
      return new Response(null, { status: 204 });
    }
    return new Response('', { status: 405 });
  };
  return { tables, fetchImpl, counters };
}

async function withFetch<T>(fake: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

const asUser = (id: string): VerifiedUser => ({ id, email: `${id}@example.com`, token: `token-${id}` });
const store = (id: string) => new SupabaseRestStore(URL_, ANON, asUser(id));

/** Synthetic parsed rows with variable-length descriptions. Quantities and rates are exact decimal strings. */
function makeRows(n: number, descBase = 600): ParsedRow[] {
  return Array.from({ length: n }, (_, i) => {
    const desc = `Item ${i} ` + 'x'.repeat(descBase + ((i * 37) % 900));
    return {
      id: `r${i}`, sheet: i % 2 === 0 ? 'Bill 1' : 'Bill 2', rowNumber: i + 1, rowClass: 'item', classReason: 'priced', bill: 'B', ref: `REF-${i}`,
      description: desc, unit: 'm3', quantity: { state: 'value', text: `${i}.125`, value: `${i}.125`, cell: `D${i + 1}` },
      rate: { state: 'value', text: `${(i % 97) + 0.5}`, value: `${(i % 97) + 0.5}`, cell: `E${i + 1}`, formulaStatus: 'none' },
      amount: { text: '' }, cells: {}, included: true, issues: [],
    } as ParsedRow;
  });
}

async function initPayload(importId: string, rows: ParsedRow[], overrides: Partial<InitPayload['meta']> = {}): Promise<{ init: InitPayload; plan: Awaited<ReturnType<typeof planBatches>> }> {
  const plan = await planBatches(importId, rows);
  return { plan, init: { importId, revision: 1, expectedRows: plan.totalRows, expectedBatches: plan.batches.length, importChecksum: plan.importChecksum, meta: { fileName: 'big.xlsx', sha256: 'a'.repeat(64), sizeBytes: 1000, format: 'xlsx', currency: 'AED', revisionLabel: 'Revision 1', mappings: [], confirmedAt: '2026-11-18T00:00:00.000Z', ...overrides } } };
}

describe('batch planning', () => {
  it('bounds every batch by serialised bytes AND row count, preserves order and loses no row', async () => {
    const rows = makeRows(5000);
    const total = utf8Bytes(JSON.stringify({ import: { rows } }));
    expect(total).toBeGreaterThan(4_500_000); // larger than the commonly documented serverless request limit
    const plan = await planBatches('imp-1', rows);
    expect(plan.oversized).toEqual([]);
    expect(plan.batches.length).toBeGreaterThan(1);
    for (const b of plan.batches) {
      expect(b.rows.length).toBeLessThanOrEqual(MAX_BATCH_ROWS);
      const body = JSON.stringify({ action: 'batch', batch: { importId: 'imp-1', batchId: b.batchId, index: b.index, checksum: b.checksum, rows: b.rows } });
      expect(utf8Bytes(body)).toBeLessThanOrEqual(MAX_BATCH_BYTES);
      expect(b.bytes).toBe(utf8Bytes(serialiseRows(b.rows)));
    }
    const flat = plan.batches.flatMap((b) => b.rows);
    expect(flat.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(plan.batches.map((b) => b.start)).toEqual(plan.batches.reduce<number[]>((acc, b, i) => { acc.push(i === 0 ? 0 : acc[i - 1] + plan.batches[i - 1].rows.length); return acc; }, []));
    console.log('BATCH_PLAN', JSON.stringify({ rows: rows.length, singleRequestBytes: total, batches: plan.batches.length, maxBatchBytes: Math.max(...plan.batches.map((b) => b.bytes)), minRows: Math.min(...plan.batches.map((b) => b.rows.length)), maxRows: Math.max(...plan.batches.map((b) => b.rows.length)) }));
  });

  it('uses fewer rows per batch when descriptions are long (byte limit, not just a count of 500)', async () => {
    const long = await planBatches('imp-long', makeRows(300, 8000));
    expect(long.batches.some((b) => b.rows.length < 500)).toBe(true);
    expect(Math.max(...long.batches.map((b) => b.bytes))).toBeLessThanOrEqual(MAX_BATCH_BYTES);
  });

  it('is deterministic: the same rows give the same batch ids and checksums', async () => {
    const a = await planBatches('imp-d', makeRows(900));
    const b = await planBatches('imp-d', makeRows(900));
    expect(a.batches.map((x) => x.batchId)).toEqual(b.batches.map((x) => x.batchId));
    expect(a.importChecksum).toBe(b.importChecksum);
  });

  it('reports an individually oversized row explicitly and never truncates it', async () => {
    const rows = makeRows(5);
    rows[2] = { ...rows[2], description: 'y'.repeat(MAX_ROW_BYTES + 10) };
    const plan = await planBatches('imp-big', rows);
    expect(plan.oversized).toHaveLength(1);
    expect(plan.oversized[0]).toMatchObject({ rowId: 'r2', rowNumber: 3 });
    expect(plan.batches.flatMap((b) => b.rows).find((r) => r.id === 'r2')?.description.length).toBe(MAX_ROW_BYTES + 10);
  });

  it('rejects a batch whose contents do not match its checksum', async () => {
    const plan = await planBatches('imp-c', makeRows(10));
    const b = plan.batches[0];
    const tampered = { importId: 'imp-c', batchId: b.batchId, index: b.index, checksum: b.checksum, rows: b.rows.map((r, i) => (i === 0 ? { ...r, description: 'changed' } : r)) };
    expect(await verifyBatch(tampered)).toMatch(/checksum/);
    expect(await verifyBatch({ importId: 'imp-c', batchId: b.batchId, index: b.index, checksum: b.checksum, rows: b.rows })).toBe('');
    expect(await sha256Hex('a')).toHaveLength(64);
  });
});

describe('staged import against the store', () => {
  it('saves a large BOQ in bounded requests, finalises atomically, and reloads with exact rows, quantities and rates', async () => {
    const s = makeServer();
    const rows = makeRows(2400);
    await withFetch(s.fetchImpl as typeof fetch, async () => {
      const a = await store('alice').createCase(newCase('Big', 'AED'));
      const { init, plan } = await initPayload('imp-big', rows);
      const ack0 = await store('alice').initImport(a.id, init);
      expect(ack0).toMatchObject({ status: 'pending', savedRows: 0, expectedRows: 2400 });
      // Not usable while pending.
      expect(await store('alice').listImports(a.id)).toEqual([]);
      const sums = await store('alice').listImportSummaries(a.id);
      expect(sums[0]).toMatchObject({ status: 'pending', savedRows: 0, confirmedAt: null });
      await expect(store('alice').selectImport(a.id, 'imp-big')).rejects.toThrow(/still being saved/);
      for (const b of plan.batches) {
        const ack = await store('alice').saveImportBatch(a.id, { importId: 'imp-big', batchId: b.batchId, index: b.index, checksum: b.checksum, rows: b.rows });
        expect(ack.batch?.state).toBe('saved');
        expect(JSON.stringify(ack).length).toBeLessThan(plan.batches.length * 120 + 600); // small ack, no rows
      }
      const fin = await store('alice').finalizeImport(a.id, 'imp-big', plan.importChecksum);
      expect(fin).toMatchObject({ ok: true, status: 'complete', savedRows: 2400 });
      const c = await store('alice').getCase(a.id);
      expect(c?.selectedImportId).toBe('imp-big');
      const imports = await store('alice').listImports(a.id);
      expect(imports).toHaveLength(1);
      expect(imports[0].rows).toHaveLength(2400);
      expect(selectedImportOf(c, imports)?.id).toBe('imp-big');
      const want = new Map(rows.map((r) => [r.id, r]));
      for (const r of imports[0].rows) {
        const w = want.get(r.id)!;
        expect(r.quantity.value).toBe(w.quantity.value);
        expect(r.rate.value).toBe(w.rate.value);
        expect(r.description).toBe(w.description);
      }
      // Paginated rows cover the complete set.
      const seen: string[] = [];
      let off: number | null = 0;
      while (off !== null) {
        const page: Awaited<ReturnType<SupabaseRestStore['listImportRows']>> = await store('alice').listImportRows(a.id, 'imp-big', off, 500);
        seen.push(...page.rows.map((r) => r.id));
        off = page.nextOffset;
      }
      expect(new Set(seen).size).toBe(2400);
    });
    expect(s.counters.maxBodyBytes).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    console.log('STAGED_SAVE', JSON.stringify({ rows: 2400, maxRequestBytes: s.counters.maxBodyBytes, rowWrites: s.counters.rowInserts }));
  });

  it('a failed middle batch leaves the import pending and unusable; resume sends only the missing batches', async () => {
    let fail = true;
    const s = makeServer({ failBatchWrite: (i) => fail && i === 2 });
    const rows = makeRows(1800);
    await withFetch(s.fetchImpl as typeof fetch, async () => {
      const a = await store('alice').createCase(newCase('Resume', 'AED'));
      const { init, plan } = await initPayload('imp-resume', rows);
      expect(plan.batches.length).toBeGreaterThan(3);
      await store('alice').initImport(a.id, init);
      let failedAt = -1;
      for (const b of plan.batches) {
        try { await store('alice').saveImportBatch(a.id, { importId: 'imp-resume', batchId: b.batchId, index: b.index, checksum: b.checksum, rows: b.rows }); } catch { failedAt = b.index; break; }
      }
      expect(failedAt).toBe(2);
      // Incomplete: cannot finalise, not listed, cannot be selected, case has no selection.
      const early = await store('alice').finalizeImport(a.id, 'imp-resume', plan.importChecksum);
      expect(early.ok).toBe(false);
      expect(early.status).toBe('pending');
      expect(await store('alice').listImports(a.id)).toEqual([]);
      expect((await store('alice').getCase(a.id))?.selectedImportId).toBeNull();
      await expect(store('alice').listImportRows(a.id, 'imp-resume', 0, 10)).rejects.toThrow(/still being saved/);

      // Re-initialise the SAME import: progress is returned, nothing is reset.
      fail = false;
      const status = await store('alice').initImport(a.id, init);
      expect(status.status).toBe('pending');
      expect(status.savedBatchIds.length).toBe(2);
      const rowWritesBefore = s.counters.rowInserts;
      const have = new Set(status.savedBatchIds);
      let sent = 0;
      for (const b of plan.batches) {
        if (have.has(b.batchId)) continue;
        await store('alice').saveImportBatch(a.id, { importId: 'imp-resume', batchId: b.batchId, index: b.index, checksum: b.checksum, rows: b.rows });
        sent += 1;
      }
      expect(sent).toBe(plan.batches.length - 2);
      // Rows written on resume exclude the two batches already stored (the failed one never wrote its ledger row, but rows were upserted).
      expect(s.counters.rowInserts - rowWritesBefore).toBeLessThanOrEqual(rows.length);
      const fin = await store('alice').finalizeImport(a.id, 'imp-resume', plan.importChecksum);
      expect(fin).toMatchObject({ ok: true, status: 'complete' });
      const imports = await store('alice').listImports(a.id);
      expect(imports[0].rows).toHaveLength(1800);
      expect(new Set(imports[0].rows.map((r) => r.id)).size).toBe(1800);
      expect(s.tables.pvr_boq_rows.filter((r) => r.import_id === 'imp-resume')).toHaveLength(1800);
    });
  });

  it('a duplicate batch submission does not duplicate rows or ledger entries', async () => {
    const s = makeServer();
    const rows = makeRows(700);
    await withFetch(s.fetchImpl as typeof fetch, async () => {
      const a = await store('alice').createCase(newCase('Dup', 'AED'));
      const { init, plan } = await initPayload('imp-dup', rows);
      await store('alice').initImport(a.id, init);
      const b0 = plan.batches[0];
      const payload = { importId: 'imp-dup', batchId: b0.batchId, index: b0.index, checksum: b0.checksum, rows: b0.rows };
      const first = await store('alice').saveImportBatch(a.id, payload);
      const writes = s.counters.rowInserts;
      const second = await store('alice').saveImportBatch(a.id, payload);
      expect(first.batch?.state).toBe('saved');
      expect(second.batch?.state).toBe('already_saved');
      expect(s.counters.rowInserts).toBe(writes); // no second write
      expect(s.tables.pvr_boq_import_batches.filter((r) => r.import_id === 'imp-dup')).toHaveLength(1);
      expect(s.tables.pvr_boq_rows.filter((r) => r.import_id === 'imp-dup')).toHaveLength(b0.rows.length);
      for (const b of plan.batches.slice(1)) await store('alice').saveImportBatch(a.id, { importId: 'imp-dup', batchId: b.batchId, index: b.index, checksum: b.checksum, rows: b.rows });
      expect((await store('alice').finalizeImport(a.id, 'imp-dup', plan.importChecksum)).ok).toBe(true);
      // Finalising twice, and submitting a batch after completion, are both harmless.
      expect((await store('alice').finalizeImport(a.id, 'imp-dup', plan.importChecksum)).ok).toBe(true);
      const late = await store('alice').saveImportBatch(a.id, payload);
      expect(late.batch?.state).toBe('already_saved');
      expect(s.tables.pvr_boq_rows.filter((r) => r.import_id === 'imp-dup')).toHaveLength(700);
      expect(s.tables.pvr_boq_imports.filter((r) => r.id === 'imp-dup')).toHaveLength(1); // one import record, no extra revision
    });
  });

  it('re-initialising does not create a duplicate import, and different contents under the same id are refused', async () => {
    const s = makeServer();
    await withFetch(s.fetchImpl as typeof fetch, async () => {
      const a = await store('alice').createCase(newCase('Init', 'AED'));
      const { init } = await initPayload('imp-i', makeRows(100));
      await store('alice').initImport(a.id, init);
      await store('alice').initImport(a.id, init);
      expect(s.tables.pvr_boq_imports.filter((r) => r.id === 'imp-i')).toHaveLength(1);
      const other = await initPayload('imp-i', makeRows(101));
      await expect(store('alice').initImport(a.id, other.init)).rejects.toThrow(/different contents/);
    });
  });

  it('finalise refuses an incomplete import and a bad checksum; the import stays pending and unselected', async () => {
    const s = makeServer();
    await withFetch(s.fetchImpl as typeof fetch, async () => {
      const a = await store('alice').createCase(newCase('Fin', 'AED'));
      const { init, plan } = await initPayload('imp-f', makeRows(800));
      await store('alice').initImport(a.id, init);
      const b0 = plan.batches[0];
      await store('alice').saveImportBatch(a.id, { importId: 'imp-f', batchId: b0.batchId, index: 0, checksum: b0.checksum, rows: b0.rows });
      const r1 = await store('alice').finalizeImport(a.id, 'imp-f', plan.importChecksum);
      expect(r1).toMatchObject({ ok: false, status: 'pending' });
      const r2 = await store('alice').finalizeImport(a.id, 'imp-f', 'f'.repeat(64));
      expect(r2.ok).toBe(false);
      expect(await store('alice').listImports(a.id)).toEqual([]);
      expect((await store('alice').getCase(a.id))?.selectedImportId).toBeNull();
    });
  });

  it('a tampered batch is rejected and nothing is stored for it', async () => {
    const s = makeServer();
    await withFetch(s.fetchImpl as typeof fetch, async () => {
      const a = await store('alice').createCase(newCase('Tamper', 'AED'));
      const { init, plan } = await initPayload('imp-t', makeRows(50));
      await store('alice').initImport(a.id, init);
      const b = plan.batches[0];
      await expect(store('alice').saveImportBatch(a.id, { importId: 'imp-t', batchId: b.batchId, index: 0, checksum: b.checksum, rows: b.rows.slice(1) })).rejects.toThrow(/checksum/);
      expect(s.tables.pvr_boq_rows).toHaveLength(0);
      expect(s.tables.pvr_boq_import_batches).toHaveLength(0);
    });
  });

  it('enforces case ownership on initialise, batch, status and finalise', async () => {
    const s = makeServer();
    await withFetch(s.fetchImpl as typeof fetch, async () => {
      const a = await store('alice').createCase(newCase('Alice', 'AED'));
      const { init, plan } = await initPayload('imp-own', makeRows(60));
      await store('alice').initImport(a.id, init);
      const b = plan.batches[0];
      const before = JSON.stringify(s.tables);
      await expect(store('bob').initImport(a.id, init)).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(store('bob').saveImportBatch(a.id, { importId: 'imp-own', batchId: b.batchId, index: 0, checksum: b.checksum, rows: b.rows })).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(store('bob').getImportStatus(a.id, 'imp-own')).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(store('bob').finalizeImport(a.id, 'imp-own', plan.importChecksum)).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(store('bob').listImportSummaries(a.id)).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(store('bob').listImportRows(a.id, 'imp-own', 0, 10)).rejects.toBeInstanceOf(AccessDeniedError);
      expect(JSON.stringify(s.tables)).toBe(before);
      // Bob's own case cannot adopt Alice's import id either.
      const bc = await store('bob').createCase(newCase('Bob', 'AED'));
      await expect(store('bob').initImport(bc.id, init)).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(store('bob').getImportStatus(bc.id, 'imp-own')).rejects.toBeInstanceOf(AccessDeniedError);
    });
  });

  it('does not delete a working import\'s rows before a replacement is complete (legacy save writes first, prunes after)', async () => {
    const s = makeServer();
    await withFetch(s.fetchImpl as typeof fetch, async () => {
      const a = await store('alice').createCase(newCase('Keep', 'AED'));
      const rows = makeRows(30);
      const { init, plan } = await initPayload('imp-keep', rows);
      await store('alice').initImport(a.id, init);
      for (const b of plan.batches) await store('alice').saveImportBatch(a.id, { importId: 'imp-keep', batchId: b.batchId, index: b.index, checksum: b.checksum, rows: b.rows });
      await store('alice').finalizeImport(a.id, 'imp-keep', plan.importChecksum);
      const before = s.tables.pvr_boq_rows.filter((r) => r.import_id === 'imp-keep').length;
      // The legacy single-request path refuses to touch a pending import and the complete import's rows are untouched by a failed attempt.
      const { init: init2 } = await initPayload('imp-keep2', makeRows(10));
      await store('alice').initImport(a.id, { ...init2, revision: 2 });
      await expect(store('alice').saveImport({ id: 'imp-keep2', caseId: a.id, revision: 2, source: { fileName: 'x', sha256: 'a'.repeat(64), sizeBytes: 1, format: 'csv', currency: 'AED', revisionLabel: '' }, mappings: [], rows: [], confirmedAt: null })).rejects.toThrow(/in stages/);
      expect(s.tables.pvr_boq_rows.filter((r) => r.import_id === 'imp-keep').length).toBe(before);
      expect((await store('alice').listImports(a.id))).toHaveLength(1);
    });
  });

  it('a second revision stays pending and does not change the active selection until finalised and explicitly selected', async () => {
    const s = makeServer();
    await withFetch(s.fetchImpl as typeof fetch, async () => {
      const a = await store('alice').createCase(newCase('Rev', 'AED'));
      const one = await initPayload('imp-r1', makeRows(40));
      await store('alice').initImport(a.id, one.init);
      for (const b of one.plan.batches) await store('alice').saveImportBatch(a.id, { importId: 'imp-r1', batchId: b.batchId, index: b.index, checksum: b.checksum, rows: b.rows });
      await store('alice').finalizeImport(a.id, 'imp-r1', one.plan.importChecksum);
      const two = await initPayload('imp-r2', makeRows(45));
      await store('alice').initImport(a.id, { ...two.init, revision: 2 });
      expect((await store('alice').getCase(a.id))?.selectedImportId).toBe('imp-r1');
      for (const b of two.plan.batches) await store('alice').saveImportBatch(a.id, { importId: 'imp-r2', batchId: b.batchId, index: b.index, checksum: b.checksum, rows: b.rows });
      await store('alice').finalizeImport(a.id, 'imp-r2', two.plan.importChecksum);
      expect((await store('alice').getCase(a.id))?.selectedImportId).toBe('imp-r1'); // unchanged
      const c = await store('alice').selectImport(a.id, 'imp-r2');
      expect(c.selectedImportId).toBe('imp-r2');
    });
  });
});

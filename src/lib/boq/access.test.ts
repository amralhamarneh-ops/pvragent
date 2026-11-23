import { describe, expect, it } from 'vitest';
import { AccessDeniedError, GUEST_USER_ID, SupabaseRestStore, verifyUser, type VerifiedUser } from './supabaseStore';
import { buildImport, confirmImport, stageUpload } from './importFlow';
import { newCase } from './store';

/**
 * These tests drive the REAL SupabaseRestStore and verifyUser code through a fake PostgREST/Auth server.
 * The fake enforces the same rule the migration's RLS does (owner_id = the caller's user id) and counts
 * which credential each request carried. They prove the application code sends the user's token, filters
 * by owner and refuses other users. They do NOT prove the live database policies; that needs the
 * migration applied and a run against the real project.
 */

const URL_ = 'https://fake.supabase.test';
const ANON = 'anon-key';
const enc = (s: string) => new TextEncoder().encode(s);

interface Row { [k: string]: unknown }

function makeServer() {
  const tables: Record<string, Row[]> = { pvr_cases: [], pvr_boq_imports: [], pvr_boq_rows: [] };
  const sessions: Record<string, string> = { 'token-alice': 'alice', 'token-bob': 'bob' };
  const seenAuth: string[] = [];

  const matches = (row: Row, q: URLSearchParams) => {
    for (const [k, v] of q.entries()) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;
      if (v.startsWith('eq.') && String(row[k]) !== decodeURIComponent(v.slice(3))) return false;
    }
    return true;
  };

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization') ?? '';
    seenAuth.push(auth);
    const token = auth.replace(/^Bearer\s+/i, '');
    if (url.pathname === '/auth/v1/user') {
      const uid = sessions[token];
      return uid ? new Response(JSON.stringify({ id: uid, email: `${uid}@example.com` }), { status: 200 }) : new Response('{"msg":"invalid"}', { status: 401 });
    }
    const uid = sessions[token]; // RLS identity. The anon key alone has no identity.
    if (!uid) return new Response('{"code":"42501","message":"row-level security"}', { status: 401 });
    const table = url.pathname.replace('/rest/v1/', '');
    const rows = tables[table];
    const method = init?.method ?? 'GET';
    const q = url.searchParams;
    if (method === 'GET') {
      const out = rows.filter((r) => r.owner_id === uid && matches(r, q));
      return new Response(JSON.stringify(out), { status: 200 });
    }
    if (method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Row | Row[];
      const list = Array.isArray(body) ? body : [body];
      for (const r of list) {
        if (r.owner_id !== uid) return new Response('{"code":"42501","message":"new row violates row-level security policy"}', { status: 403 });
        if (table !== 'pvr_cases') {
          const c = tables.pvr_cases.find((x) => x.id === r.case_id);
          if (!c || c.owner_id !== uid) return new Response('{"code":"42501","message":"Not permitted to write to case"}', { status: 403 });
        }
        const i = rows.findIndex((x) => x.id === r.id);
        if (i >= 0 && q.get('on_conflict') === 'id') rows[i] = { ...rows[i], ...r }; else rows.push(r);
      }
      return new Response(init?.headers && new Headers(init.headers).get('prefer')?.includes('representation') ? JSON.stringify(list) : '', { status: 201 });
    }
    if (method === 'PATCH') {
      const patch = JSON.parse(String(init?.body)) as Row;
      const hit = rows.filter((r) => r.owner_id === uid && matches(r, q));
      hit.forEach((r) => Object.assign(r, patch));
      return new Response(JSON.stringify(hit), { status: 200 });
    }
    if (method === 'DELETE') {
      tables[table] = rows.filter((r) => !(r.owner_id === uid && matches(r, q)));
      return new Response('', { status: 204 });
    }
    return new Response('', { status: 405 });
  };
  return { tables, fetchImpl, seenAuth };
}

async function withFetch<T>(fake: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

const asUser = (id: string): VerifiedUser => ({ id, email: `${id}@example.com`, token: `token-${id}` });
const store = (id: string) => new SupabaseRestStore(URL_, ANON, asUser(id));

const CSV = ['Item,Description,Unit,Qty,Rate,Amount', 'TEST-001,Pavement,m²,0,10,0'].join('\n');
async function confirmedImport(caseId: string) {
  const staged = await stageUpload('boq.csv', enc(CSV));
  const { imp } = buildImport({ caseId, staged, mappings: staged.mappings, currency: 'AED', revisionLabel: 'A', revision: 1 });
  return confirmImport(imp);
}

describe('verifyUser', () => {
  it('falls back to the shared guest when no valid session is sent, and honours a valid one', async () => {
    const s = makeServer();
    await withFetch(s.fetchImpl as typeof fetch, async () => {
      await expect(verifyUser(null, URL_, ANON)).resolves.toMatchObject({ id: GUEST_USER_ID, token: ANON });
      await expect(verifyUser('Basic abc', URL_, ANON)).resolves.toMatchObject({ id: GUEST_USER_ID });
      await expect(verifyUser('Bearer forged', URL_, ANON)).resolves.toMatchObject({ id: GUEST_USER_ID });
      const u = await verifyUser('Bearer token-alice', URL_, ANON);
      expect(u).toMatchObject({ id: 'alice', token: 'token-alice' });
    });
  });
});

describe('owner isolation in SupabaseRestStore', () => {
  it('a user can create, save and read their own case; the user token (not the anon key) is sent', async () => {
    const s = makeServer();
    await withFetch(s.fetchImpl as typeof fetch, async () => {
      const a = await store('alice').createCase(newCase('A case', 'AED'));
      expect(a.ownerId).toBe('alice');
      await store('alice').saveImport(await confirmedImport(a.id));
      const loaded = await store('alice').getCase(a.id);
      expect(loaded?.id).toBe(a.id);
      expect(loaded?.selectedImportId).not.toBeNull();
      const imps = await store('alice').listImports(a.id);
      expect(imps).toHaveLength(1);
      expect(imps[0].rows.some((r) => r.ref === 'TEST-001')).toBe(true);
    });
    expect(s.seenAuth.filter((h) => h.includes('token-alice')).length).toBeGreaterThan(0);
    expect(s.seenAuth.every((h) => !h.includes(ANON))).toBe(true);
  });

  it('knowing another user\'s case id grants no read access', async () => {
    const s = makeServer();
    await withFetch(s.fetchImpl as typeof fetch, async () => {
      const a = await store('alice').createCase(newCase('Alice case', 'AED'));
      await store('alice').saveImport(await confirmedImport(a.id));
      expect(await store('bob').getCase(a.id)).toBeNull();
      await expect(store('bob').listImports(a.id)).rejects.toBeInstanceOf(AccessDeniedError);
    });
  });

  it('another user cannot modify or add imports, or select a revision, on a case they do not own', async () => {
    const s = makeServer();
    await withFetch(s.fetchImpl as typeof fetch, async () => {
      const a = await store('alice').createCase(newCase('Alice case', 'AED'));
      const imp = await confirmedImport(a.id);
      await store('alice').saveImport(imp);
      const before = JSON.stringify(s.tables);
      await expect(store('bob').saveImport({ ...imp, id: 'imp-bob-attack' })).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(store('bob').saveImport(imp)).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(store('bob').selectImport(a.id, imp.id)).rejects.toBeInstanceOf(AccessDeniedError);
      expect(JSON.stringify(s.tables)).toBe(before);
    });
  });

  it('a client-supplied owner is ignored: the case is always owned by the verified user', async () => {
    const s = makeServer();
    await withFetch(s.fetchImpl as typeof fetch, async () => {
      const forged = { ...newCase('Forged', 'AED'), ownerId: 'alice' };
      const created = await store('bob').createCase(forged);
      expect(created.ownerId).toBe('bob');
      expect(await store('alice').getCase(created.id)).toBeNull();
    });
  });

  it('two users with different BOQs never see each other\'s rows', async () => {
    const s = makeServer();
    await withFetch(s.fetchImpl as typeof fetch, async () => {
      const a = await store('alice').createCase(newCase('A', 'AED'));
      const b = await store('bob').createCase(newCase('B', 'AED'));
      await store('alice').saveImport(await confirmedImport(a.id));
      const stagedB = await stageUpload('b.csv', enc(['Item,Description,Unit,Qty,Rate,Amount', 'B-9,Different,m,0,99,0'].join('\n')));
      const { imp: impB } = buildImport({ caseId: b.id, staged: stagedB, mappings: stagedB.mappings, currency: 'AED', revisionLabel: 'A', revision: 1 });
      await store('bob').saveImport(confirmImport(impB));
      const aRows = (await store('alice').listImports(a.id))[0].rows.map((r) => r.ref);
      const bRows = (await store('bob').listImports(b.id))[0].rows.map((r) => r.ref);
      expect(aRows).toContain('TEST-001');
      expect(aRows).not.toContain('B-9');
      expect(bRows).toContain('B-9');
      expect(bRows).not.toContain('TEST-001');
    });
  });

  it('revision selection only accepts a confirmed import of the same case', async () => {
    const s = makeServer();
    await withFetch(s.fetchImpl as typeof fetch, async () => {
      const a = await store('alice').createCase(newCase('A', 'AED'));
      const other = await store('alice').createCase(newCase('Other', 'AED'));
      const imp = await confirmedImport(a.id);
      await store('alice').saveImport(imp);
      const otherImp = await confirmedImport(other.id);
      await store('alice').saveImport(otherImp);
      await expect(store('alice').selectImport(a.id, otherImp.id)).rejects.toThrow(/does not belong/);
      const staged = await stageUpload('d.csv', enc(CSV));
      const { imp: draft } = buildImport({ caseId: a.id, staged, mappings: staged.mappings, currency: 'AED', revisionLabel: 'B', revision: 2 });
      await store('alice').saveImport(draft); // not confirmed
      await expect(store('alice').selectImport(a.id, draft.id)).rejects.toThrow(/confirmed/);
    });
  });
});

/**
 * One shared document registry for every upload path (files, folders, ZIPs, group-specific additions).
 * A document is identified by a stable ID derived from its content hash and path, never by file name alone.
 * Bytes are kept in memory and mirrored to IndexedDB (per case) so a reload in the same browser restores contents.
 * Server storage (authorised, private) is handled by caseDocsClient.ts.
 */

export type DocState = 'uploaded' | 'stored' | 'parsed' | 'needs_clarification' | 'failed';

const DOC_STATE_LABEL: Record<DocState, string> = {
  uploaded: 'Uploaded',
  stored: 'Stored',
  parsed: 'Parsed',
  needs_clarification: 'Needs clarification',
  failed: 'Failed',
};

export interface RoleHistoryEntry { at: string; fromRole: string; fromSubrole: string; toRole: string; toSubrole: string; by: 'user' }

export interface DocRecord {
  /** Stable ID: first 16 hex chars of SHA-256 of (path + content hash). Identical file at a new path is a new document. */
  id: string;
  path: string;
  name: string;
  sha256: string;
  size: number;
  /** 1 for the first time this path was seen, incremented when different content arrives at the same path. */
  version: number;
  role: string;
  /** Finer role: drawings → original | revised | unassigned; schedule → baseline | current | reference. */
  subrole?: string;
  /** Free metadata, e.g. drawingNumber, revision. */
  metadata?: Record<string, string>;
  /** True once the user chose the category; automatic classification must then never overwrite it. */
  roleManual?: boolean;
  /** Audit trail of category corrections. */
  roleHistory?: RoleHistoryEntry[];
  state: DocState;
  stateDetail: string;
  /** Private-bucket path once stored on the server. */
  storagePath?: string;
  uploadedAt: string;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function docIdFor(path: string, sha256: string): Promise<string> {
  const enc = new TextEncoder().encode(`${path}\u0000${sha256}`);
  return (await sha256Hex(enc)).slice(0, 16);
}

/** In-memory registry. Browser-only; created per page instance. */
class DocumentRegistry {
  private docs = new Map<string, DocRecord>();
  private bytes = new Map<string, Uint8Array>();

  list(): DocRecord[] { return Array.from(this.docs.values()); }
  get(id: string): DocRecord | undefined { return this.docs.get(id); }
  byPath(path: string): DocRecord | undefined { return this.list().filter((d) => d.path === path).sort((a, b) => b.version - a.version)[0]; }
  bytesOf(id: string): Uint8Array | null { return this.bytes.get(id) ?? null; }
  bytesByPath(path: string): Uint8Array | null { const d = this.byPath(path); return d ? this.bytesOf(d.id) : null; }
  hasBytes(path: string): boolean { return !!this.bytesByPath(path); }

  /** Register real bytes. Same path + same content is a no-op; same path + new content becomes a new version. */
  async add(path: string, data: Uint8Array, role = 'unused'): Promise<DocRecord> {
    const sha = await sha256Hex(data);
    const existing = this.byPath(path);
    if (existing && existing.sha256 === sha) {
      if (!this.bytes.has(existing.id)) this.bytes.set(existing.id, data);
      // A manual correction is never overwritten by automatic classification.
      if (role !== 'unused' && !existing.roleManual) existing.role = role;
      return existing;
    }
    const doc: DocRecord = {
      id: await docIdFor(path, sha),
      path,
      name: path.split('/').slice(-1)[0],
      sha256: sha,
      size: data.byteLength,
      version: existing ? existing.version + 1 : 1,
      role,
      state: 'uploaded',
      stateDetail: 'Held in this browser. Not stored on the server yet.',
      uploadedAt: new Date().toISOString(),
    };
    this.docs.set(doc.id, doc);
    this.bytes.set(doc.id, data);
    return doc;
  }

  /** Re-attach metadata restored from a draft or the server (no bytes). */
  restoreMeta(d: DocRecord): void { if (!this.docs.has(d.id)) this.docs.set(d.id, d); }
  attachBytes(id: string, data: Uint8Array): void { this.bytes.set(id, data); }

  setRole(path: string, role: string): void { const d = this.byPath(path); if (d && !d.roleManual) d.role = role; }
  setState(id: string, state: DocState, detail: string, storagePath?: string): void {
    const d = this.docs.get(id);
    if (!d) return;
    d.state = state; d.stateDetail = detail;
    if (storagePath) d.storagePath = storagePath;
  }

  /** Manual category correction. Records the previous values in the audit history; the file is NOT claimed to be parsed. */
  reclassify(id: string, role: string, subrole = '', metadata?: Record<string, string>): DocRecord | null {
    const d = this.docs.get(id);
    if (!d) return null;
    const entry: RoleHistoryEntry = { at: new Date().toISOString(), fromRole: d.role, fromSubrole: d.subrole ?? '', toRole: role, toSubrole: subrole, by: 'user' };
    d.roleHistory = [...(d.roleHistory ?? []), entry];
    d.role = role; d.subrole = subrole; d.roleManual = true;
    if (metadata) d.metadata = { ...(d.metadata ?? {}), ...metadata };
    d.state = 'uploaded';
    d.stateDetail = 'Category changed by you. Not yet parsed under the new category.';
    return d;
  }

  /** Remove active documents from this registry. Returns the removed records (the caller decides about stored originals). */
  remove(ids: string[]): DocRecord[] {
    const out: DocRecord[] = [];
    for (const id of ids) { const d = this.docs.get(id); if (d) { out.push(d); this.docs.delete(id); this.bytes.delete(id); } }
    return out;
  }

  clear(): void { this.docs.clear(); this.bytes.clear(); }
}

// ---------- IndexedDB mirror (same browser only; the server copy is authoritative) ----------

const DB_NAME = 'pvr-agent-docs';
const STORE_NAME = 'bytes';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE_NAME); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
  });
}

export async function cachePut(key: string, data: Uint8Array): Promise<boolean> {
  try {
    const db = await openDb();
    return await new Promise<boolean>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(data, key);
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); resolve(false); };
    });
  } catch { return false; }
}

export async function cacheGet(key: string): Promise<Uint8Array | null> {
  try {
    const db = await openDb();
    return await new Promise<Uint8Array | null>((resolve) => {
      const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      req.onsuccess = () => { db.close(); const v = req.result as Uint8Array | undefined; resolve(v ?? null); };
      req.onerror = () => { db.close(); resolve(null); };
    });
  } catch { return null; }
}

export const cacheKey = (sha256: string) => `sha:${sha256}`;

/** Maximum size of one accepted document. */
const MAX_DOC_BYTES = 25 * 1024 * 1024;

export { DOC_STATE_LABEL, MAX_DOC_BYTES, DocumentRegistry };
function DocRecord(...args: any[]): any {
  // eslint-disable-next-line no-console
  console.warn('Placeholder: DocRecord is not implemented yet.', args);
  return null;
}

export { DocRecord };
'use client';

import { mergeMatchSnapshotAnswers } from '@/lib/boq/matchSnapshot';

import { getAccessToken } from '@/lib/supabase/client';
import { cacheGet, cachePut, cacheKey, sha256Hex, DocumentRegistry } from '@/lib/docs/registry';
import type { DocRecord, DocState } from '@/lib/docs/registry';
import type { ChangeHandoff } from '@/lib/drawings/handoff';

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function json<T>(res: Response): Promise<T & { error?: string }> {
  try { return (await res.json()) as T & { error?: string }; } catch { return { error: `HTTP ${res.status}` } as T & { error?: string }; }
}

export interface ServerDoc {
  id: string; path: string; name: string; role: string; sha256: string; size: number; version: number;
  storagePath?: string; stored: boolean; state: string; stateDetail: string; uploadedAt: string;
  subrole?: string; metadata?: Record<string, string>; roleManual?: boolean;
}

export interface StoreOutcome { id: string; path: string; stored: boolean; error: string }

const isSession = (caseId: string) => caseId.startsWith('session-');
const scheduleManifestKey = (caseId: string) => `pvr-case-schedule-preview-manifest:${caseId}`;
const previewManifestKey = (caseId: string) => `pvr-case-drawing-preview-manifest:${caseId}`;
function clearTemporaryPreviewManifest(caseId: string) {
  if (!isSession(caseId)) return;
  try { window.sessionStorage.removeItem(previewManifestKey(caseId)); window.sessionStorage.removeItem(scheduleManifestKey(caseId)); } catch { /* storage may be unavailable */ }
}


/**
 * Store every registered document that has bytes and is not yet stored. Every outcome is reported per document;
 * nothing is marked Stored unless the server confirmed the bytes were written. A temporary case stores nothing.
 */
async function storeAllDocuments(caseId: string, reg: DocumentRegistry): Promise<StoreOutcome[]> {
  const out: StoreOutcome[] = [];
  const localSchedules: ServerDoc[] = [];
  const localDrawings: NonNullable<ChangeHandoff['documents']> = [];
  clearTemporaryPreviewManifest(caseId);
  for (const d of reg.list()) {
    if (d.storagePath && (d.state === 'stored' || d.state === 'parsed')) { out.push({ id: d.id, path: d.path, stored: true, error: '' }); continue; }
    const bytes = reg.bytesOf(d.id);
    if (!bytes) { out.push({ id: d.id, path: d.path, stored: false, error: 'The file contents are not in this browser. Reconnect the file.' }); continue; }
    // Always mirror locally so a reload in this browser restores contents even if the server is unreachable.
    if (isSession(caseId)) {
      if (d.role === 'drawings') {
        if (await cachePut(cacheKey(d.sha256), bytes)) localDrawings.push({id:d.id, name:d.path, sha256:d.sha256, version:d.version, role:d.role});
      } else if (d.role === 'schedule') {
        if (await cachePut(cacheKey(d.sha256), bytes)) localSchedules.push({id:d.id, path:d.path, name:d.name, role:d.role, sha256:d.sha256, size:d.size, version:d.version, subrole:d.subrole, stored:false, state:'uploaded', stateDetail:'Temporary browser preview only', uploadedAt:d.uploadedAt});
      } else { void cachePut(cacheKey(d.sha256), bytes); }
      reg.setState(d.id, 'uploaded', 'Temporary case: held in this browser only, not stored on a server.');
      out.push({ id: d.id, path: d.path, stored: false, error: 'This is a temporary case, so the file was not stored on a server.' });
      continue;
    }
    void cachePut(cacheKey(d.sha256), bytes);
    try {
      const q = new URLSearchParams({ docId: d.id, path: d.path, name: d.name, role: d.role, sha256: d.sha256, version: String(d.version), subrole: d.subrole ?? '', manual: d.roleManual ? '1' : '0', metadata: JSON.stringify(d.metadata ?? {}) });
      const body = new Uint8Array(bytes.byteLength);
      body.set(bytes);
      const res = await fetch(`/api/boq-cases/${encodeURIComponent(caseId)}/documents?${q.toString()}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...(await authHeaders()) }, body });
      const data = await json<{ document: ServerDoc }>(res);
      if (res.ok && data.document) {
        reg.setState(d.id, 'stored', 'Stored privately on the server.', data.document.storagePath);
        out.push({ id: d.id, path: d.path, stored: true, error: '' });
      } else {
        const msg = data.error ?? `HTTP ${res.status}`;
        reg.setState(d.id, 'failed', `Not stored: ${msg}`);
        out.push({ id: d.id, path: d.path, stored: false, error: msg });
      }
    } catch (e) {
      const msg = `Could not reach the server: ${e instanceof Error ? e.message : 'network error'}.`;
      reg.setState(d.id, 'failed', `Not stored: ${msg}`);
      out.push({ id: d.id, path: d.path, stored: false, error: msg });
    }
  }
  if (isSession(caseId) && localDrawings.length) {
    try { window.sessionStorage.setItem(previewManifestKey(caseId), JSON.stringify(localDrawings)); } catch { /* preview stays unavailable */ }
  }
  if (isSession(caseId) && localSchedules.length) {
    try { window.sessionStorage.setItem(scheduleManifestKey(caseId), JSON.stringify(localSchedules)); } catch { /* preview stays unavailable */ }
  }
  return out;
}

/** Metadata only: checks a saved takeoff against the active drawing revisions, without downloading CAD files. */
export async function loadDrawingManifest(caseId: string): Promise<ChangeHandoff['documents']> {
  if (isSession(caseId)) return [];
  try {
    const res = await fetch(`/api/boq-cases/${encodeURIComponent(caseId)}/documents`, { cache: 'no-store', headers: await authHeaders() });
    const data = await json<{ documents: ServerDoc[] }>(res);
    return res.ok ? (data.documents ?? []).filter((d) => d.role === 'drawings').map((d) => ({
      id: d.id, name: d.path, sha256: d.sha256, version: d.version, role: d.role,
    })) : [];
  } catch { return []; }
}

/** Only used for displaying drawings in this tab. Never authorises a cost or schedule decision. */
export async function loadDrawingPreviewManifest(caseId: string): Promise<ChangeHandoff['documents']> {
  if (!isSession(caseId)) return loadDrawingManifest(caseId);
  try {
    const manifest = JSON.parse(window.sessionStorage.getItem(previewManifestKey(caseId)) ?? '[]') as ChangeHandoff['documents'];
    const verified: NonNullable<ChangeHandoff['documents']> = [];
    for (const d of manifest ?? []) {
      if (!d || d.role !== 'drawings' || !/^[a-f0-9]{64}$/.test(d.sha256)) return [];
      const bytes = await cacheGet(cacheKey(d.sha256));
      if (!bytes || (await sha256Hex(bytes)) !== d.sha256) return [];
      verified.push(d);
    }
    return verified;
  } catch { return []; }
}

export interface RestoreOutcome { restored: number; needReconnect: { id: string; path: string; reason: string }[]; error: string }

/**
 * Rebuild the registry for a case: metadata from the server, contents from (1) the local cache, then (2) authorised
 * server storage. Each recovered file is checked against its recorded SHA-256. Anything that cannot be recovered is
 * listed so the UI can offer a targeted "Reconnect this file" action.
 */
async function restoreDocuments(caseId: string, reg: DocumentRegistry): Promise<RestoreOutcome> {
  const needReconnect: RestoreOutcome['needReconnect'] = [];
  let restored = 0;
  let docs: ServerDoc[] = [];
  if (isSession(caseId)) {
    try {
      const local = JSON.parse(window.sessionStorage.getItem(scheduleManifestKey(caseId)) ?? '[]') as ServerDoc[];
      docs = Array.isArray(local) ? local.filter(d => d?.role === 'schedule' && !d.stored && /^[a-f0-9]{64}$/.test(d.sha256) && typeof d.name === 'string' && /\.xer$/i.test(d.name)) : [];
    } catch { /* temporary manifest not available */ }
  } else {
    try {
      const res = await fetch(`/api/boq-cases/${encodeURIComponent(caseId)}/documents`, { cache: 'no-store', headers: await authHeaders() });
      const data = await json<{ documents: ServerDoc[] }>(res);
      if (!res.ok) return { restored: 0, needReconnect, error: data.error ?? `Could not load the document list (HTTP ${res.status}).` };
      docs = data.documents ?? [];
    } catch (e) {
      return { restored: 0, needReconnect, error: `Could not reach the server: ${e instanceof Error ? e.message : 'network error'}.` };
    }
  }
  for (const s of docs) {
    const meta: DocRecord = { id: s.id, path: s.path, name: s.name, sha256: s.sha256, size: s.size, version: s.version, role: s.role, subrole: s.subrole ?? '', metadata: s.metadata ?? {}, roleManual: !!s.roleManual, state: (s.state as DocState) ?? 'stored', stateDetail: s.stateDetail, storagePath: s.storagePath, uploadedAt: s.uploadedAt };
    reg.restoreMeta(meta);
    let bytes = await cacheGet(cacheKey(s.sha256));
    if (!bytes && s.stored) {
      try {
        const res = await fetch(`/api/boq-cases/${encodeURIComponent(caseId)}/documents?docId=${encodeURIComponent(s.id)}`, { cache: 'no-store', headers: await authHeaders() });
        if (res.ok) bytes = new Uint8Array(await res.arrayBuffer());
      } catch { /* reported below */ }
    }
    if (bytes && (await sha256Hex(bytes)) === s.sha256) { reg.attachBytes(s.id, bytes); void cachePut(cacheKey(s.sha256), bytes); restored += 1; }
    else needReconnect.push({ id: s.id, path: s.path, reason: bytes ? 'The recovered contents did not match the recorded hash.' : s.stored ? 'The stored contents could not be retrieved.' : 'The contents were never stored.' });
  }
  return { restored, needReconnect, error: '' };
}

export interface EvidenceState { narrative: string; handoff: ChangeHandoff | null; answers: Record<string, string> }

const EV_PREFIX = 'pvr-case-evidence:';

async function loadEvidence(caseId: string): Promise<{ evidence: EvidenceState | null; persisted: boolean; error: string }> {
  if (isSession(caseId)) {
    try { const raw = window.sessionStorage.getItem(EV_PREFIX + caseId); return { evidence: raw ? (JSON.parse(raw) as EvidenceState) : null, persisted: false, error: '' }; } catch { return { evidence: null, persisted: false, error: '' }; }
  }
  try {
    const res = await fetch(`/api/boq-cases/${encodeURIComponent(caseId)}/evidence`, { cache: 'no-store', headers: await authHeaders() });
    const data = await json<{ evidence: { narrative: string; handoff: ChangeHandoff | null; answers: Record<string, string> } | null }>(res);
    if (!res.ok) return { evidence: null, persisted: true, error: data.error ?? `Could not load the evidence (HTTP ${res.status}).` };
    return { evidence: data.evidence ? { narrative: data.evidence.narrative, handoff: data.evidence.handoff, answers: data.evidence.answers ?? {} } : null, persisted: true, error: '' };
  } catch (e) {
    return { evidence: null, persisted: true, error: `Could not reach the server: ${e instanceof Error ? e.message : 'network error'}.` };
  }
}

/** Persist evidence against the case. Browser storage is used only for a labelled temporary case. */
async function saveEvidence(caseId: string, patch: Partial<EvidenceState> & { matchSnapshot?: string }): Promise<{ saved: boolean; persisted: boolean; error: string }> {
  if (isSession(caseId)) {
    try {
      const raw = window.sessionStorage.getItem(EV_PREFIX + caseId);
      const cur: EvidenceState = raw ? (JSON.parse(raw) as EvidenceState) : { narrative: '', handoff: null, answers: {} };
      const { answers, matchSnapshot, ...rest } = patch;
      window.sessionStorage.setItem(EV_PREFIX + caseId, JSON.stringify({ ...cur, ...rest, answers: mergeMatchSnapshotAnswers(cur.answers, answers, matchSnapshot) }));
      return { saved: true, persisted: false, error: '' };
    } catch { return { saved: false, persisted: false, error: 'This browser could not hold the temporary copy.' }; }
  }
  try {
    const res = await fetch(`/api/boq-cases/${encodeURIComponent(caseId)}/evidence`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify(patch) });
    if (res.ok) return { saved: true, persisted: true, error: '' };
    const data = await json<Record<string, never>>(res);
    return { saved: false, persisted: true, error: data.error ?? `Save failed (HTTP ${res.status}).` };
  } catch (e) {
    return { saved: false, persisted: true, error: `Could not reach the server: ${e instanceof Error ? e.message : 'network error'}. The evidence was NOT saved.` };
  }
}

async function setDocRole(caseId: string, docId: string, role: string): Promise<void> {
  if (isSession(caseId)) return;
  try { await fetch(`/api/boq-cases/${encodeURIComponent(caseId)}/documents`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ docId, role }) }); } catch { /* role is re-sent on the next store */ }
}

export interface ServerResult { ok: boolean; error: string }

/**
 * Persist a manual category correction. For a temporary (browser-only) case nothing is sent and the result is ok.
 * A failure is returned, never swallowed, so the UI can roll back instead of claiming success.
 */
async function reclassifyOnServer(caseId: string, docId: string, role: string, subrole: string, metadata?: Record<string, string>): Promise<ServerResult> {
  if (isSession(caseId)) { clearTemporaryPreviewManifest(caseId); return { ok: true, error: '' }; }
  try {
    const res = await fetch(`/api/boq-cases/${encodeURIComponent(caseId)}/documents`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ docId, role, subrole, metadata, manual: true, markStale: 'A document was reclassified.' }) });
    if (res.ok) return { ok: true, error: '' };
    const data = await json<Record<string, never>>(res);
    return { ok: false, error: data.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: `Could not reach the server: ${e instanceof Error ? e.message : 'network error'}.` };
  }
}

/**
 * Unlink documents from this PVR on the server. Succeeds only if the server confirms every requested id was unlinked
 * (or was already absent). Stored originals are intentionally kept. A temporary case has nothing to unlink remotely.
 */
async function removeOnServer(caseId: string, docIds: string[], reason: string, replacedBy?: string): Promise<ServerResult> {
  if (docIds.length === 0) return { ok: true, error: '' };
  if (isSession(caseId)) { clearTemporaryPreviewManifest(caseId); return { ok: true, error: '' }; }
  try {
    const res = await fetch(`/api/boq-cases/${encodeURIComponent(caseId)}/documents`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ docIds, reason, replacedBy }) });
    if (res.ok) return { ok: true, error: '' };
    const data = await json<Record<string, never>>(res);
    return { ok: false, error: data.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: `Could not reach the server: ${e instanceof Error ? e.message : 'network error'}.` };
  }
}

/** A short-lived signed link to a stored document (view / download). */
async function signedDocLink(caseId: string, docId: string): Promise<{ url: string; error: string }> {
  try {
    const res = await fetch(`/api/boq-cases/${encodeURIComponent(caseId)}/documents?docId=${encodeURIComponent(docId)}&link=1`, { cache: 'no-store', headers: await authHeaders() });
    const data = await json<{ url: string }>(res);
    if (!res.ok || !data.url) return { url: '', error: data.error ?? `HTTP ${res.status}` };
    return { url: data.url, error: '' };
  } catch (e) {
    return { url: '', error: `Could not reach the server: ${e instanceof Error ? e.message : 'network error'}.` };
  }
}

export { storeAllDocuments, restoreDocuments, loadEvidence, saveEvidence, setDocRole, reclassifyOnServer, removeOnServer, signedDocLink };
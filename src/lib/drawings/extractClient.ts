import type { ExtractedDocument } from './types';

export interface ExtractionCapabilities {
  pdfText: boolean; docx: boolean; ocrImages: boolean; ocrScannedPdf: boolean;
  dwg: { configured: true; converter: string } | { configured: false; reason: string; requirement: string };
}

export type ConversionInfo = { converter: string; converterVersion?: string; sourceSha256?: string; dxfSha256?: string; warnings: string[]; validationIssues?: string[] };

export type ExtractOutcome =
  | { kind: 'text'; ok: boolean; doc?: ExtractedDocument; error?: string }
  | { kind: 'dwg'; ok: boolean; dxf?: Uint8Array; converter?: string; error?: string; conversion?: ConversionInfo };

export type Extractor = (name: string, bytes: Uint8Array, onProgress?: (detail: string) => void, signal?: AbortSignal) => Promise<ExtractOutcome>;

export async function loadCapabilities(signal?: AbortSignal): Promise<ExtractionCapabilities | null> {
  try { const r = await fetch('/api/extract', { signal }); return r.ok ? ((await r.json()) as ExtractionCapabilities) : null; } catch { return null; }
}

const b64ToBytes = (s: string): Uint8Array => { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i); return out; };

/** Browser extractor: posts the real file bytes to /api/extract and relays its streamed progress. */
export const serverExtractor: Extractor = async (name, bytes, onProgress, signal) => {
  const form = new FormData();
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  form.append('file', new Blob([copy]), name);
  form.append('name', name);
  let res: Response;
  try { res = await fetch('/api/extract', { method: 'POST', body: form, signal }); }
  catch (e) { return { kind: 'text', ok: false, error: e instanceof Error && e.name === 'AbortError' ? 'Cancelled.' : `The extraction service could not be reached: ${e instanceof Error ? e.message : 'network error'}` }; }
  if (!res.ok || !res.body) { let msg = `The extraction service returned ${res.status}.`; try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* keep */ } return { kind: 'text', ok: false, error: msg }; }
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  let final: ExtractOutcome | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line) as { type: string; detail?: string; kind?: 'text' | 'dwg'; ok?: boolean; doc?: ExtractedDocument; error?: string; dxfBase64?: string; converter?: string; conversion?: ConversionInfo };
        if (m.type === 'progress') onProgress?.(m.detail ?? '');
        else if (m.type === 'result') final = m.kind === 'dwg' ? { kind: 'dwg', ok: !!m.ok, dxf: m.dxfBase64 ? b64ToBytes(m.dxfBase64) : undefined, converter: m.converter, error: m.error, conversion: m.conversion } : { kind: 'text', ok: !!m.ok, doc: m.doc, error: m.error };
      } catch { /* ignore a malformed line */ }
    }
  }
  return final ?? { kind: 'text', ok: false, error: 'The extraction service ended without a result.' };
};

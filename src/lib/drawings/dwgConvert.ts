/**
 * DWG conversion integration. A DWG is a proprietary binary; this app never sends project documents to an
 * unconfigured public converter. Conversion runs ONLY through a converter the deployment owner has installed and
 * configured on the server:
 *
 *   DWG_CONVERTER=oda      → ODA File Converter (https://www.opendesign.com/guestfiles/oda_file_converter).
 *                            Free to download but licensed by the Open Design Alliance (commercial use requires
 *                            membership/licence). Set DWG_CONVERTER_PATH to the ODAFileConverter executable.
 *                            On Linux it needs xvfb-run (set DWG_CONVERTER_XVFB=1).
 *   DWG_CONVERTER=libredwg → GNU LibreDWG `dwg2dxf` (GPLv3, free). Set DWG_CONVERTER_PATH to the dwg2dxf binary.
 *                            Supports a subset of DWG versions; unsupported versions fail with an explicit error.
 *   DWG_CONVERTER_OUTPUT_VERSION (optional, ODA only, default ACAD2018)
 *
 * When nothing is configured the status is 'not_configured' and the exact missing dependency is reported. The
 * supported alternative is to upload an ASCII DXF export.
 */
import { createHash } from 'node:crypto';
import { runFile } from '@/lib/server/execFile';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type DwgStatus =
  | { configured: true; converter: 'oda' | 'libredwg'; path: string }
  | { configured: false; reason: string; requirement: string };

export function dwgStatus(env: Record<string, string | undefined> = process.env): DwgStatus {
  const kind = (env.DWG_CONVERTER ?? '').toLowerCase();
  const path = env.DWG_CONVERTER_PATH ?? '';
  if (!kind || !path) {
    return {
      configured: false,
      reason: 'No DWG converter is configured on this deployment.',
      requirement: 'Install ODA File Converter (ODA licence required for commercial use) or GNU LibreDWG dwg2dxf on the server, then set DWG_CONVERTER=oda|libredwg and DWG_CONVERTER_PATH=/absolute/path/to/executable. Until then, export the drawing as ASCII DXF and upload that.',
    };
  }
  if (kind !== 'oda' && kind !== 'libredwg') {
    return { configured: false, reason: `DWG_CONVERTER="${kind}" is not recognised.`, requirement: 'Use DWG_CONVERTER=oda or DWG_CONVERTER=libredwg.' };
  }
  return { configured: true, converter: kind, path };
}

export interface DwgResult {
  ok: boolean;
  dxf?: Uint8Array;
  error?: string;
  converter?: string;
  /** Converter version string as reported by the executable, when it reports one. */
  converterVersion?: string;
  /** SHA-256 of the original DWG bytes (the original is never modified). */
  sourceSha256?: string;
  /** SHA-256 of the resulting DXF bytes. */
  dxfSha256?: string;
  /** Converter stdout/stderr lines that look like warnings. */
  warnings?: string[];
}

const run = runFile;
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function probeVersion(kind: 'oda' | 'libredwg', exe: string): Promise<string | undefined> {
  if (kind !== 'libredwg') return undefined; // ODA File Converter has no version flag; the configured output version is reported instead.
  try {
    const r = await run(exe, ['--version'], { timeout: 10_000 });
    return String(r.stdout || r.stderr).split('\n')[0]?.trim() || undefined;
  } catch { return undefined; }
}

const warningLines = (...streams: (string | Buffer | undefined)[]): string[] =>
  streams.flatMap((s) => String(s ?? '').split('\n')).map((l) => l.trim()).filter((l) => /warn|error|unsupported|unknown|invalid|skip/i.test(l)).slice(0, 25);

/** Convert DWG bytes to ASCII DXF bytes through the configured local converter. Server-side only. */
export async function convertDwg(bytes: Uint8Array, env: Record<string, string | undefined> = process.env, timeoutMs = 120_000): Promise<DwgResult> {
  const st = dwgStatus(env);
  if (!st.configured) return { ok: false, error: `${st.reason} ${st.requirement}` };
  const sourceSha256 = sha256(bytes);
  const dir = await mkdtemp(join(tmpdir(), 'pvr-dwg-'));
  try {
    const inDir = join(dir, 'in'); const outDir = join(dir, 'out');
    await mkdir(inDir); await mkdir(outDir);
    const inFile = join(inDir, 'drawing.dwg');
    await writeFile(inFile, bytes);
    let out: { stdout: string | Buffer; stderr: string | Buffer };
    let converterVersion: string | undefined;
    if (st.converter === 'oda') {
      const version = env.DWG_CONVERTER_OUTPUT_VERSION || 'ACAD2018';
      converterVersion = `ODA File Converter (output ${version})`;
      const args = [inDir, outDir, version, 'DXF', '0', '1'];
      out = env.DWG_CONVERTER_XVFB === '1' ? await run('xvfb-run', ['-a', st.path, ...args], { timeout: timeoutMs })
        : await run(st.path, args, { timeout: timeoutMs });
    } else {
      converterVersion = await probeVersion('libredwg', st.path);
      out = await run(st.path, ['--as', 'r2018', '-o', join(outDir, 'drawing.dxf'), inFile], { timeout: timeoutMs });
    }
    const warnings = warningLines(out.stdout, out.stderr);
    const produced = (await readdir(outDir)).find((f) => /\.dxf$/i.test(f));
    if (!produced) return { ok: false, error: `The ${st.converter} converter ran but produced no DXF file. The DWG version may not be supported by it.`, converter: st.converter, converterVersion, sourceSha256, warnings };
    const dxf = new Uint8Array(await readFile(join(outDir, produced)));
    if (dxf.byteLength < 100) return { ok: false, error: `The ${st.converter} converter produced an empty DXF.`, converter: st.converter, converterVersion, sourceSha256, warnings };
    return { ok: true, dxf, converter: st.converter, converterVersion, sourceSha256, dxfSha256: sha256(dxf), warnings };
  } catch (err) {
    const e = err as { killed?: boolean; code?: string | number; message?: string; stderr?: string };
    const msg = e.killed ? `timed out after ${Math.round(timeoutMs / 1000)} s` : e.code === 'ENOENT' ? `the converter executable was not found at ${st.path}` : (e.message ?? 'unknown error');
    return { ok: false, error: `DWG conversion failed: ${msg}`, converter: st.converter, sourceSha256, warnings: warningLines(e.stderr) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

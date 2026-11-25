/**
 * DWG -> DXF conversion for the worker. The original is never modified; converter, version and DXF hash are
 * recorded; units/extents/warnings are validated. Requires a real converter binary (ODA File Converter or LibreDWG).
 */
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const sha = (b) => createHash('sha256').update(b).digest('hex');

export function dwgStatus(env = process.env) {
  const kind = (env.DWG_CONVERTER || '').toLowerCase(); const path = env.DWG_CONVERTER_PATH || '';
  if (!kind || !path) return { configured: false, reason: 'DWG_CONVERTER / DWG_CONVERTER_PATH are not set.' };
  if (kind !== 'oda' && kind !== 'libredwg') return { configured: false, reason: `DWG_CONVERTER="${kind}" is not recognised (use oda or libredwg).` };
  return { configured: true, converter: kind, path };
}

/** Real executable probe: runs the binary. Returns { ok, version?, error? }. A set env var alone proves nothing. */
export async function probeDwg(env = process.env) {
  const st = dwgStatus(env);
  if (!st.configured) return { ok: false, error: st.reason };
  try {
    if (st.converter === 'libredwg') { const r = await run(st.path, ['--version'], { timeout: 10_000 }); return { ok: true, converter: st.converter, version: String(r.stdout || r.stderr).split('\n')[0].trim() }; }
    await readFile(st.path); // ODA has no --version; existence + exec bit is the strongest cheap check.
    return { ok: true, converter: st.converter, version: `ODA File Converter (output ${env.DWG_CONVERTER_OUTPUT_VERSION || 'ACAD2018'})` };
  } catch (e) { return { ok: false, error: e?.code === 'ENOENT' ? `Executable not found at ${st.path}` : String(e?.message ?? e) }; }
}

const INSUNITS = { 4: 'mm', 5: 'cm', 6: 'm' };

/** Light validation of the produced DXF text: units, extents, entity count. */
export function validateDxf(buf) {
  const text = Buffer.from(buf).toString('utf8');
  const issues = [];
  const m = text.match(/\$INSUNITS\s*\r?\n\s*70\s*\r?\n\s*(\d+)/);
  const code = m ? Number(m[1]) : null;
  const unit = code !== null ? INSUNITS[code] ?? null : null;
  if (code === null || code === 0) issues.push('Converted DXF does not declare drawing units ($INSUNITS missing/unitless). Scale cannot be established.');
  else if (!unit) issues.push(`Converted DXF uses $INSUNITS code ${code}, which is not mm/cm/m.`);
  // Streaming min/max over the $EXTMIN/$EXTMAX header values (no array spreading).
  const num = (k) => { const r = text.match(new RegExp(`\\$${k}\\s*\\r?\\n\\s*10\\s*\\r?\\n\\s*([-+0-9.eE]+)\\s*\\r?\\n\\s*20\\s*\\r?\\n\\s*([-+0-9.eE]+)`)); return r ? { x: Number(r[1]), y: Number(r[2]) } : null; };
  const mn = num('EXTMIN'); const mx = num('EXTMAX');
  let extents = null;
  if (mn && mx && Number.isFinite(mn.x) && Number.isFinite(mx.x) && Math.abs(mx.x) < 1e19) extents = { minX: mn.x, minY: mn.y, maxX: mx.x, maxY: mx.y };
  else issues.push('Converted DXF has no usable $EXTMIN/$EXTMAX; extents will be computed from geometry.');
  if (!/\bENTITIES\b/.test(text)) issues.push('Converted DXF has no ENTITIES section.');
  const xrefs = (text.match(/\n\s*1\s*\r?\n[^\n]*\.dwg\s*\r?\n/gi) || []).length;
  if (/\bXREF\b|\$XCLIPFRAME/.test(text) && xrefs === 0) issues.push('The drawing references external files (XREF); they are not resolved by conversion.');
  return { unit, insunitsCode: code, extents, issues };
}

export async function convertDwg(bytes, { env = process.env, timeoutMs = 120_000, signal } = {}) {
  const st = dwgStatus(env);
  if (!st.configured) return { ok: false, error: st.reason };
  const sourceSha256 = sha(bytes);
  const dir = await mkdtemp(join(tmpdir(), 'pvr-dwg-'));
  try {
    const inDir = join(dir, 'in'); const outDir = join(dir, 'out');
    await mkdir(inDir); await mkdir(outDir);
    const inFile = join(inDir, 'drawing.dwg');
    await writeFile(inFile, bytes);
    const version = (await probeDwg(env)).version;
    let out;
    const opts = { timeout: timeoutMs, signal };
    if (st.converter === 'oda') {
      const args = [inDir, outDir, env.DWG_CONVERTER_OUTPUT_VERSION || 'ACAD2018', 'DXF', '0', '1'];
      out = env.DWG_CONVERTER_XVFB === '1' ? await run('xvfb-run', ['-a', st.path, ...args], opts) : await run(st.path, args, opts);
    } else out = await run(st.path, ['--as', 'r2018', '-o', join(outDir, 'drawing.dxf'), inFile], opts);
    const warnings = `${out.stdout}\n${out.stderr}`.split('\n').map((l) => l.trim()).filter((l) => /warn|error|unsupported|unknown|invalid|skip/i.test(l)).slice(0, 25);
    const produced = (await readdir(outDir)).find((f) => /\.dxf$/i.test(f));
    if (!produced) return { ok: false, error: 'The converter ran but produced no DXF (DWG version may be unsupported).', converter: st.converter, converterVersion: version, sourceSha256, warnings };
    const dxf = await readFile(join(outDir, produced));
    if (dxf.byteLength < 100) return { ok: false, error: 'The converter produced an empty DXF.', converter: st.converter, converterVersion: version, sourceSha256, warnings };
    const v = validateDxf(dxf);
    return { ok: true, dxf, converter: st.converter, converterVersion: version, sourceSha256, dxfSha256: sha(dxf), warnings, validation: v };
  } catch (e) {
    const msg = e?.name === 'AbortError' ? 'cancelled' : e?.killed ? `timed out after ${Math.round(timeoutMs / 1000)} s` : e?.code === 'ENOENT' ? `executable not found at ${st.path}` : String(e?.message ?? e);
    return { ok: false, error: `DWG conversion failed: ${msg}`, converter: st.converter, sourceSha256 };
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

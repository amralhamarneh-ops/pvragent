/** A diagnostic, never a quantity takeoff. Source files are scanned locally without uploading or rewriting. */
export type CadInventory = {
  bytesRead: number; topLevelRecords: number; blockRecords: number; insertRecords: number;
  unitCode: number | null; externalGeometryFlag: boolean;
};
export type CadScanReply =
  | { type: 'progress'; loaded: number }
  | { type: 'result'; inventory: CadInventory }
  | { type: 'error'; message: string };

const CHUNK = 1024 * 1024;
// Bounds a malformed record, not the total drawing size.
const MAX_LINE = 128 * 1024;
const UNSUPPORTED = 'This is not a supported text DXF. Export an ASCII DXF from the CAD authoring tool.';

export async function inventoryCadFile(file: Blob, progress: (loaded: number) => void = () => {}): Promise<CadInventory> {
  const result: CadInventory = {bytesRead:0, topLevelRecords:0, blockRecords:0, insertRecords:0, unitCode:null, externalGeometryFlag:false};
  const decoder = new TextDecoder('windows-1252');
  let tail = '', code: number | undefined, inUnits = false;
  let section = '', expectSection = false, closed = false, sawSection = false, sawEntities = false;
  let isBlock = false;
  const line = (raw: string) => {
    if (raw.length > MAX_LINE) throw new Error('A DXF record exceeds the supported line length; the drawing was not fully read.');
    const value = raw.trim();
    if (code === undefined) {
      if (closed && !value) return;
      if (!/^-?\d{1,4}$/.test(value)) throw new Error(UNSUPPORTED);
      code = Number(value); return;
    }
    const g = code; code = undefined;
    if (g === 999) return; // comment
    if (closed) throw new Error('Unexpected records after DXF EOF.');
    if (expectSection) {
      if (g !== 2 || !/^[A-Z_]+$/.test(value)) throw new Error('Invalid DXF section header.');
      section = value; expectSection = false; sawSection = true;
      if (section === 'ENTITIES') sawEntities = true;
      return;
    }
    if (g === 0) {
      inUnits = false; isBlock = false;
      if (value === 'SECTION' && !section) { expectSection = true; return; }
      if (value === 'ENDSEC' && section) { section = ''; return; }
      if (value === 'EOF' && !section) { closed = true; return; }
      if (!section || /^(SECTION|ENDSEC|EOF)$/.test(value)) throw new Error('Invalid DXF section boundary.');
      if ((section === 'ENTITIES' || section === 'BLOCKS') && !/^(BLOCK|ENDBLK|VERTEX|SEQEND)$/.test(value)) {
        if (section === 'ENTITIES') result.topLevelRecords++; else result.blockRecords++;
        if (value === 'INSERT' || value === 'MINSERT') result.insertRecords++;
        if (/^(UNDERLAY|PDFUNDERLAY|DGNUNDERLAY|DWFUNDERLAY|IMAGE|ACAD_PROXY_ENTITY)$/.test(value)) result.externalGeometryFlag = true;
      }
      isBlock = section === 'BLOCKS' && value === 'BLOCK';
      return;
    }
    if (section === 'HEADER') {
      if (g === 9) inUnits = value === '$INSUNITS';
      if (g === 70 && inUnits) {
        if (/^\d{1,3}$/.test(value)) result.unitCode = Number(value);
        inUnits = false;
      }
    }
    if (isBlock && ((g === 70 && (Number(value) & 12) !== 0) || (g === 1 && value !== ''))) result.externalGeometryFlag = true;
  };
  if (!file.size) throw new Error('The drawing is empty.');
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    const bytes = new Uint8Array(await file.slice(offset,offset+CHUNK).arrayBuffer());
    if (bytes.includes(0)) throw new Error(UNSUPPORTED);
    const segment = tail + decoder.decode(bytes);
    let p = 0;
    for (let n = segment.indexOf('\n'); n >= 0; n = segment.indexOf('\n', p)) {
      line(segment.slice(p,n)); p = n+1;
    }
    tail = segment.slice(p);
    if (tail.length > MAX_LINE) throw new Error('A DXF record exceeds the supported line length; the drawing was not fully read.');
    result.bytesRead += bytes.length;
    if ((offset/CHUNK)%8===0 || result.bytesRead===file.size) progress(result.bytesRead);
  }
  if (tail) line(tail);
  if (!closed || code !== undefined || !sawSection || !sawEntities)
    throw new Error('Missing DXF entity section or end marker. No complete inventory was recorded.');
  return result;
}

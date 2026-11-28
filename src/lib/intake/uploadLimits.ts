/** The private case bucket and the current readers share this per-document limit. */
export const MAX_DOC_BYTES = 25 * 1024 * 1024;
/** The browser ZIP reader holds the archive in memory; users can instead select an extracted folder. */
export const MAX_ZIP_BYTES = 100 * 1024 * 1024;
export const MAX_EXPANDED_ZIP_BYTES = 150 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 500;

export function documentSizeNotice(path: string, size?: number): string {
  const label = path || 'File';
  const measured = size == null ? '' : ` (${(size / 1048576).toLocaleString('en-US', { maximumFractionDigits: 1 })} MiB)`;
  const next = /\.pdf$/i.test(label)
    ? 'Export the relevant issued sheets to smaller PDFs, retaining the sheet and revision identifiers. PDF text alone is not measured geometry.'
    : /\.(dwg|dxf)$/i.test(label)
      ? 'Export matching original and revised DXFs by area or sheet, retaining model-space coordinates, units and references. Do not use a cropped plot to infer missing quantities.'
      : 'Choose an individual file within the limit.';
  return `${label}${measured} exceeds the 25 MiB per-file limit. ${next}`;
}

type ZipStream = {
  on(event: 'data', cb: (chunk: Uint8Array) => void): ZipStream;
  on(event: 'end', cb: () => void): ZipStream;
  on(event: 'error', cb: (error: Error) => void): ZipStream;
  pause(): ZipStream;
  resume(): ZipStream;
};

/** Stop inflating an oversized ZIP entry; never build a huge blob and reject it afterward. */
export function readBoundedZipEntry(entry: unknown, maxBytes: number): Promise<Blob | null> {
  // JSZip 3.x implements internalStream on entries; its types expose it only on the archive generator.
  const stream = (entry as { internalStream(type: 'uint8array'): ZipStream }).internalStream('uint8array');
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let length = 0;
    stream.on('data', (chunk) => {
      length += chunk.byteLength;
      if (length > maxBytes) {
        stream.pause();
        chunks.length = 0;
        resolve(null);
      } else chunks.push(Uint8Array.from(chunk));
    }).on('end', () => resolve(new Blob(chunks))).on('error', reject).resume();
  });
}

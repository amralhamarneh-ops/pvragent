import JSZip from 'jszip';
import { expect, it } from 'vitest';
import { documentSizeNotice, MAX_DOC_BYTES, readBoundedZipEntry } from './uploadLimits';

it('keeps an entry exactly at the limit and rejects the first chunk above it', async () => {
  const source = new JSZip();
  source.file('small.pdf', new Uint8Array([37, 80, 68, 70, 45]));
  source.file('huge.dxf', new Uint8Array(64 * 1024).fill(7));
  const zip = await JSZip.loadAsync(await source.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
  const small = await readBoundedZipEntry(zip.file('small.pdf'), 5);
  expect(new Uint8Array(await small!.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70, 45]));
  expect(await readBoundedZipEntry(zip.file('huge.dxf'), 500)).toBeNull();
});
it('explains how to replace an oversized drawing without suggesting an unsupported measurement', () => {
  expect(documentSizeNotice('revised.dwg', 2 * MAX_DOC_BYTES)).toMatch(/50 MiB.*matching original and revised DXFs/i);
  expect(documentSizeNotice('revised.pdf')).toMatch(/PDF text alone is not measured geometry/);
});

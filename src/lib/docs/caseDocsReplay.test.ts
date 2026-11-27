import { afterEach, expect, it, vi } from 'vitest';
import { storeAllDocuments } from './caseDocsClient';
import { DocumentRegistry } from './registry';

vi.mock('@/lib/supabase/client', () => ({ getAccessToken: async () => 'token' }));
afterEach(() => vi.unstubAllGlobals());

it('uploads parsed files before claiming they are available for a saved replay', async () => {
  const reg = new DocumentRegistry();
  const doc = await reg.add('Demo Rev A.dxf', new TextEncoder().encode('DXF bytes'), 'drawings');
  reg.setState(doc.id, 'parsed', 'Read in the browser');
  const fetch = vi.fn(async () => Response.json({document:{storagePath:'owner/demo/a.dxf'}}));
  vi.stubGlobal('fetch',fetch);
  const [first] = await storeAllDocuments('demo-persisted-case',reg);
  expect(first.stored).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  await storeAllDocuments('demo-persisted-case',reg);
  expect(fetch).toHaveBeenCalledTimes(1);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dwgStatus,convertDwg} from '../src/dwg.mjs';
test('DWG module loads and reports missing converter without crashing',async()=>{
 assert.equal(dwgStatus({}).configured,false);
 const r=await convertDwg(Buffer.from('AC1032'),{env:{}});
 assert.equal(r.ok,false);assert.match(r.error,/not set/);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dwgStatus,convertDwg,validateDxf} from '../src/dwg.mjs';
test('DWG module loads and reports missing converter without crashing',async()=>{
 assert.equal(dwgStatus({}).configured,false);
 const r=await convertDwg(Buffer.from('AC1032'),{env:{}});
 assert.equal(r.ok,false);assert.match(r.error,/not set/);
});
test('rejects conversion errors even when the tool exited zero and wrote a file',{skip:process.platform==='win32'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mock-dwg-'));const tool=join(dir,'converter');
 try {
  await writeFile(tool,'#!/bin/sh\nif [ "$1" = "--version" ]; then echo fake; exit 0; fi\nprintf "%0120d" 1 > "$4"\nprintf "ERROR: Corrupt DWG section\\n" >&2\nexit 0\n',{mode:0o700});
  const r=await convertDwg(Buffer.from('AC1032 fixture'),{env:{DWG_CONVERTER:'libredwg',DWG_CONVERTER_PATH:tool}});
  assert.equal(r.ok,false);assert.equal(r.dxf,undefined);assert.match(r.error,/reported errors/);
 } finally{await rm(dir,{recursive:true,force:true});}
});
test('flags inverted extents and sentinel coordinate values',()=>{
 const d=validateDxf(Buffer.from('$INSUNITS\n70\n6\n$EXTMIN\n10\n1e20\n20\n1e20\n$EXTMAX\n10\n0\n20\n0\nENTITIES\n'));
 assert.equal(d.extents,null);assert.match(d.issues.join(' '),/no usable/);
});

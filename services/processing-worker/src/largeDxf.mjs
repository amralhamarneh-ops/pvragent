import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile);
/** Bounded-memory inventory fallback. Never substitutes raw block counts for quantities. */
export async function inventoryLargeDxf(bytes) {
 const dir=await mkdtemp(join(tmpdir(),'pvr-cad-'));
 try {
  const input=join(dir,'input.dxf'), output=join(dir,'inventory.json');
  await writeFile(input,bytes);
  await run(process.env.PYTHON_BIN||'python3',[fileURLToPath(new URL('./cad_inventory.py',import.meta.url)),input,output],{timeout:240000,maxBuffer:1048576});
  const inventory=JSON.parse(await readFile(output,'utf8'));
  delete inventory.file;
  return {ok:true,state:'read_with_limits',inventory,texts:inventory.texts.map(x=>x.text),coverage:{complete:false,scope:inventory.limitation,unit:({4:'mm',5:'cm',6:'m'})[inventory.header.insunits]||null,metresPerUnit:({4:.001,5:.01,6:1})[inventory.header.insunits]||null,layers:[],processedTypes:{},skippedTypes:inventory.entityTypes,skippedEntityCount:Object.values(inventory.entityTypes).reduce((a,b)=>a+b,0),geometryEntities:0,textEntities:inventory.texts.length,insertsExpanded:0,unresolvedXrefs:inventory.xrefDefinitions.map(x=>x.name),batches:0,issues:['Large-file inventory only: geometry measurement and block expansion require further processing.']}};
 } catch(e) {return {ok:false,state:'failed',error:`Large DXF inventory failed: ${e.message}`};}
 finally {await rm(dir,{recursive:true,force:true});}
}

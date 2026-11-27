import { describe, expect, it } from 'vitest';
import { inventoryCadFile } from './largeCadIntake';

const header = '0\r\nSECTION\r\n2\r\nHEADER\r\n9\r\n$INSUNITS\r\n70\r\n6\r\n0\r\nENDSEC\r\n';
const blocks = '0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n70\n4\n0\nLINE\n0\nENDBLK\n0\nENDSEC\n';
const entities = '0\nSECTION\n2\nENTITIES\n';
const end = '0\nENDSEC\n0\nEOF';

describe('streaming large ASCII DXF intake', ()=>{
  it('separates model records from definition records and flags dependencies', async ()=>{
    const file = new Blob([header,blocks,entities,'0\nINSERT\n0\nLINE\n',end]);
    expect(await inventoryCadFile(file)).toEqual({bytesRead:file.size, topLevelRecords:2,blockRecords:1,insertRecords:1,unitCode:6,externalGeometryFlag:true});
  });
  it('scans a valid drawing past the old cap in bounded slices', async ()=>{
    const record = '0\nLINE\n8\nDIM\n10\n0\n20\n0\n11\n5\n21\n5\n';
    const chunk = record.repeat(32768);
    const file = new Blob([header,entities,...Array(32).fill(chunk),end]);
    expect(file.size).toBeGreaterThan(25*1024*1024);
    let largest = 0;
    const source = {size:file.size,slice:(a:number,b:number)=>{largest=Math.max(largest,b-a);return file.slice(a,b);}} as Blob;
    const seen:number[]=[];
    const scan=await inventoryCadFile(source,n=>seen.push(n));
    expect(scan.topLevelRecords).toBe(32768*32);
    expect(scan.bytesRead).toBe(file.size);
    expect(seen.at(-1)).toBe(file.size);
    expect(largest).toBe(1024*1024);
  });
  it('fails closed for truncated, binary or pathological input', async ()=>{
    await expect(inventoryCadFile(new Blob([header,entities,'0\nLINE']))).rejects.toThrow('end marker');
    await expect(inventoryCadFile(new Blob(['AutoCAD Binary DXF\0']))).rejects.toThrow('text DXF');
    await expect(inventoryCadFile(new Blob(['999\n','x'.repeat(150000)]))).rejects.toThrow('line length');
  });
});

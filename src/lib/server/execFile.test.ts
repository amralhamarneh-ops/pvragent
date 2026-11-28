import { describe,expect,it } from 'vitest';
import { runFile } from './execFile';

describe('server processor executable',()=>{
  it('launches the executable, preserves arguments without shell interpolation, and settles',async()=>{
    const value='literal text; & $HOME';
    const r=await runFile(process.execPath,['-e','process.stdout.write(process.argv[1]);process.stderr.write("diagnostic")',value],{timeout:2000});
    expect(r).toEqual({stdout:value,stderr:'diagnostic'});
  });
  it('rejects with stderr and exit status instead of leaving an unsettled job',async()=>{
    await expect(runFile(process.execPath,['-e','process.stderr.write("convert failed");process.exit(7)'],{timeout:2000}))
      .rejects.toMatchObject({code:7,stderr:'convert failed'});
  });
  it('preserves raw binary output for the PDF rasterizer', async () => {
    const output = await runFile(process.execPath, ['-e', 'process.stdout.write(Buffer.from([137,80,78,71,0,255]))'], { encoding: 'buffer', timeout: 2000, maxBuffer: 1024 });
    expect(output.stdout).toEqual(Buffer.from([137,80,78,71,0,255]));
    expect(output.stderr).toEqual(Buffer.alloc(0));
  });
  it('settles on timeout',async()=>{
    await expect(runFile(process.execPath,['-e','setInterval(()=>{},100)'],{timeout:150})).rejects.toMatchObject({killed:true});
  });
});

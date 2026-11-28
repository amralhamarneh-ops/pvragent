interface RunResult<T extends string | Buffer> { stdout: T; stderr: T }
type RunOptions = { timeout?: number; maxBuffer?: number; cwd?: string; env?: NodeJS.ProcessEnv };
type ExecFileFn = (file: string, args: string[], options: Record<string, unknown>, cb: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void) => unknown;

let cached: ExecFileFn | null = null;

async function loadExecFile(): Promise<ExecFileFn> {
  if (cached) return cached;
  // Resolve the built-in at call time; preview bundlers need not rewrite or evaluate a top-level native binding.
  const name = ['node:child', 'process'].join('_');
  const mod = (await import(/* webpackIgnore: true */ name)) as { execFile: ExecFileFn };
  cached = mod.execFile;
  return cached;
}

export function runFile(file: string, args: readonly string[], options: RunOptions & { encoding: 'buffer' }): Promise<RunResult<Buffer>>;
export function runFile(file: string, args?: readonly string[], options?: RunOptions & { encoding?: BufferEncoding }): Promise<RunResult<string>>;
export async function runFile(file: string, args: readonly string[] = [], options: RunOptions & { encoding?: BufferEncoding | 'buffer' } = {}) {
  const execFile = await loadExecFile();
  return new Promise<RunResult<string | Buffer>>((resolve, reject) => {
    execFile(file, [...args], { ...options, shell: false, windowsHide: true }, (error, stdout, stderr) => {
      if (error) { reject(Object.assign(error, { stdout, stderr })); return; }
      resolve({ stdout, stderr });
    });
  });
}

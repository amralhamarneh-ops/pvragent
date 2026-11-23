interface RunResult { stdout: string; stderr: string }
type RunFile = (file: string, args?: readonly string[], options?: { timeout?: number; maxBuffer?: number; cwd?: string; env?: NodeJS.ProcessEnv; encoding?: BufferEncoding }) => Promise<RunResult>;

type ExecFileCb = (err: Error | null, stdout: string, stderr: string) => void;
type ExecFileFn = (file: string, args: string[], options: Record<string, unknown>, cb: ExecFileCb) => unknown;

let cached: ExecFileFn | null = null;

async function loadExecFile(): Promise<ExecFileFn> {
  if (cached) return cached;
  // Resolved by Node at runtime (not bundled): the specifier is built dynamically and webpack is told to skip it.
  const name = ['node:child', 'process'].join('_');
  const mod = (await import(/* webpackIgnore: true */ name)) as { execFile: ExecFileFn };
  cached = mod.execFile;
  return cached;
}

export const runFile: RunFile = async (file, args = [], options = {}) => {
  const execFile = await loadExecFile();
  return new Promise<RunResult>((resolve, reject) => {
  });
};

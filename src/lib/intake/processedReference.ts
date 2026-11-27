/** Conservative filename hint; unlabelled benchmark documents must be classified explicitly at upload. */
export function isProcessedPvrFile(path: string): boolean {
  const basename = path.split(/[\\/]/).at(-1) ?? '';
  const label = basename.toLowerCase().replace(/[_.-]+/g, ' ').replace(/\s+/g, ' ');
  return !/\.xer$/i.test(basename) && (
    /\b(?:processed|assessed|benchmark|manual assessment) (?:\w+ ){0,2}(?:pvr|variation)\b|\b(?:pvr|variation) (?:\w+ ){0,2}(?:processed|benchmark|assessment reference|ground truth)\b/.test(label)
    || /^rate comparison\b/.test(label)
  );
}

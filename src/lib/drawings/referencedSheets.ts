import type { AnalysisQuestion, ExtractedDocument } from './types';

const sheetId = '[A-Z0-9]+(?:[_-][A-Z0-9]+){2,}';
const explicitReference = new RegExp(
  '\\b(?:refer(?:ence)?\\s+to|see|in\\s+accordance\\s+with)\\s+' +
  '(?:(?:the\\s+)?(?:drawing|dwg)\\.?(?:\\s*(?:no|number)\\.?)?\\s*[:#]?\\s*)?' +
  '(' + sheetId + '\\.(?:dwg|dxf|pdf))\\b', 'gi',
);
const normalise = (s: string) => s.toLowerCase().replace(/_/g, '-');
const cadStem = (s: string) => normalise((s.split(/[\\/]/).at(-1) ?? '').replace(/\.(?:dwg|dxf)$/i, ''));

export function missingReferencedSheets(
  drawingTexts: readonly ExtractedDocument[],
  uploaded: readonly { name: string; available: boolean }[],
): AnalysisQuestion[] {
  const available = new Set(uploaded.filter((f) => f.available && /\.(?:dwg|dxf)$/i.test(f.name)).map((f) => cadStem(f.name)));
  const missing = new Map<string, { file: string; references: Set<string> }>();
  for (const doc of drawingTexts) {
    if (!/\.pdf$/i.test(doc.name) || doc.unitKind === 'section') continue;
    for (const page of doc.pages) {
      for (const match of page.text.matchAll(explicitReference)) {
        const file = match[1];
        const id = normalise(file.replace(/\.(?:dwg|dxf|pdf)$/i, ''));
        if (available.has(id)) continue;
        const record = missing.get(id) ?? { file, references: new Set<string>() };
        record.references.add(`${doc.name}, page ${page.page}`);
        missing.set(id, record);
      }
    }
  }
  return [...missing.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => {
    const refs = [...entry.references];
    return {
      id: `referenced-drawing-${id}`, kind: 'unsupported_format', blocksComparison: false,
      title: 'A referenced drawing is missing',
      issue: `${refs[0]} refers to ${entry.file}, but its CAD file is not available in this run.`,
      evidence: refs, proposal: 'Add the original CAD sheet or a matching DXF export. Check the affected scope before relying on the takeoff.',
      options: [],
    };
  });
}

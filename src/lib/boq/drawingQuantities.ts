import { recordsFromChanges, type ChangeHandoff } from '../drawings/handoff';
import type { ChangeScope, ScopeComponent } from './scope';

export type DrawingDocument = ChangeHandoff['documents'][number];

const basename = (p: string) => p.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
const fingerprint = (d: DrawingDocument) => `${d.id}|${d.name}|${d.sha256.toLowerCase()}|${d.version}`;

export function matchesCurrentDrawings(saved: readonly DrawingDocument[], active: readonly DrawingDocument[]): boolean {
  const drawings = (files: readonly DrawingDocument[]) => files.filter((d) => d.role === 'drawings');
  const a = drawings(saved);
  const b = drawings(active);
  const current = new Set(b.map(fingerprint));
  return a.length > 0 && a.length === b.length && current.size === b.length && new Set(a.map(fingerprint)).size === a.length
    && a.every((d) => /^[a-f0-9]{64}$/i.test(d.sha256) && current.has(fingerprint(d)));
}

const UNKNOWN = 'No verified drawing quantity is available for this scope.';
const normalized = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const validValue = (s: string) => /^\d+(?:\.\d+)?$/.test(s) && Number.isFinite(Number(s)) && Number(s) > 0;

/** Neither a narrative/model claim nor an alternative benchmark quantity is a takeoff. The drawing handoff is the only source. */
export function withDrawingQuantities(scope: ChangeScope, handoff: ChangeHandoff | null, active: readonly DrawingDocument[]): ChangeScope {
  const components = scope.components.map((c): ScopeComponent => ({ ...c, quantity: null }));
  const current = !!handoff && matchesCurrentDrawings(handoff.documents, active);
  const eligible = (current ? handoff?.changes ?? [] : []).filter((c) => !c.acceptedFrom || c.acceptedFrom === 'measured' || c.acceptedFrom === 'derived');
  const records = recordsFromChanges(eligible);
  // Match only a unique exact object/action to preserve its descriptive metadata, never to transfer a guessed quantity.
  const measurements: ScopeComponent[] = [];
  for (const [i, r] of records.entries()) {
    const change = eligible[i];
    const drawingDocuments = active.filter((d) => d.role === 'drawings' && /\.(?:dxf|dwg)$/i.test(d.name));
    const identify = (source: string) => {
      const file = source.split(' · layer ')[0];
      const exact = drawingDocuments.filter((d) => d.name === file);
      const matches = exact.length ? exact : drawingDocuments.filter((d) => basename(d.name) === basename(file));
      return matches.length === 1 ? matches[0].id : '';
    };
    const sourceIds = change.sources.map(identify);
    if (sourceIds.length !== 2 || !sourceIds[0] || !sourceIds[1] || sourceIds[0] === sourceIds[1]) continue;
    const refs = r.entityRefs;
    if (r.needsReview || !r.formula || !refs?.drawingNumber || !refs.originalRevision || !refs.revisedRevision || !r.drawingRevision
      || !['m', 'm2', 'nr'].includes(r.unit) || (r.basis !== 'measured' && r.basis !== 'derived')) continue;
    const validEntities = (entities: typeof refs.revised) => entities?.length > 0 && entities.every((e) => !!e.handle?.trim());
    // A confirmed relocation is measured rework, not a negative contractual omission of an existing asset.
    const directions = r.change === 'modified' && r.relocationEvidence && validEntities(refs.original) && validEntities(refs.revised)
      ? [['rework', r.revisedQty, refs.revised]] as const
      : [['add', r.addedQty, refs.revised], ['omit', r.omittedQty, refs.original]] as const;
    for (const [action, value, entities] of directions) {
      if (!validValue(value) || !validEntities(entities)) continue;
      const source = `${change.sources.join(' → ') || refs.drawingNumber} (${r.drawingRevision})`;
      measurements.push({
        id: `drawing:${sourceIds.map(encodeURIComponent).join(':')}:${r.id}:${action}`, name: r.component, action, discipline: '', workType: '',
        material: '', specification: '', location: change.location, searchTerms: [r.component, change.description].filter(Boolean),
        expectedUnit: r.unit, quantity: { value, unit: r.unit, origin: 'measured_from_geometry', source, quote: r.formula },
        missingInputs: [], potential: false, potentialReason: '', evidence: [source, r.measurementBasis],
      });
    }
  }
  const scopeKey = (c: ScopeComponent) => `${normalized(c.name)}|${c.action}`;
  const adopted = new Set<string>();
  for (const m of measurements) {
    const key = scopeKey(m);
    const exact = components.filter((c) => scopeKey(c) === key && (!c.location || !m.location || m.location.startsWith('near (') || normalized(m.location) === normalized(c.location)));
    if (exact.length !== 1 || measurements.filter((other) => scopeKey(other) === key).length !== 1) continue;
    const c = exact[0];
    adopted.add(c.id);
    m.searchTerms = [...new Set([...m.searchTerms, ...c.searchTerms])];
    m.discipline = c.discipline;
    m.workType = c.workType;
    m.material = c.material;
    m.specification = c.specification;
    m.location ||= c.location;
  }
  return {
    ...scope,
    components: [...measurements, ...components.filter((c) => !adopted.has(c.id))],
    limitations: [...scope.limitations, ...(measurements.length ? [] : [UNKNOWN]), ...(handoff && !current ? ['The drawing set differs from the saved takeoff or could not be verified. Rerun drawing analysis before valuation.'] : [])],
  };
}

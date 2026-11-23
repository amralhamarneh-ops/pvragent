import type { AnalysisQuestion, AnalysisResult } from './types';

/**
 * Typed resolution of an answered question. An answer is not just "hide the question": each kind changes an input
 * to the analysis, and the analysis is re-run so the result actually differs. Both the alternatives on offer and the
 * recorded choice are kept (see handoff.appliedAnswers).
 */
export interface Resolutions {
  /** Drawing number or pair key → "<originalFile>|<revisedFile>" chosen by the user. */
  pairOverride: Record<string, string>;
  /** File name → unit the user confirmed for that drawing. */
  unitOverride: Record<string, 'm' | 'mm' | 'cm'>;
  /** Change id → which source the accepted quantity comes from: 'measured' or 'alt-<n>'. */
  quantitySource: Record<string, string>;
  /** Question ids the user chose to hold for review. They stay unresolved. */
  held: string[];
  /** Date the user chose among conflicting event dates (ISO). */
  eventDate: string;
}

export const EMPTY_RESOLUTIONS: Resolutions = { pairOverride: {}, unitOverride: {}, quantitySource: {}, held: [], eventDate: '' };

/** Translate raw answers (question id → option id) into typed resolutions using the questions that were asked. */
export function resolutionsFrom(questions: AnalysisQuestion[], answers: Record<string, string>): Resolutions {
  const r: Resolutions = { pairOverride: {}, unitOverride: {}, quantitySource: {}, held: [], eventDate: '' };
  for (const q of questions) {
    const a = answers[q.id];
    if (!a) continue;
    if (a === 'review') { r.held.push(q.id); continue; }
    switch (q.kind) {
      case 'pairing': case'revision_order':
        if (a.includes('|')) r.pairOverride[q.id] = a;
        break;
      case 'unit':
        if (a === 'm' || a === 'mm' || a === 'cm') {
          // The unit question lists both drawing file names as evidence; the confirmed unit applies to each.
          for (const e of q.evidence) r.unitOverride[e] = a;
        } else if (a === 'later') r.held.push(q.id);
        break;
      case 'conflict':
        r.quantitySource[q.id.replace(/^conf-/, '')] = a;
        break;
      case 'correspondence':
        if (a === 'review') r.held.push(q.id);
        break;
      case 'date':
        if (/^\d{4}-\d{2}-\d{2}$/.test(a)) r.eventDate = a;
        break;
      default:
        break;
    }
  }
  return r;
}

/** Questions that are still open after the answers: held, "later", or unanswered. */
export function stillOpen(questions: AnalysisQuestion[], answers: Record<string, string>): AnalysisQuestion[] {
  return questions.filter((q) => !answers[q.id] || answers[q.id] === 'review' || answers[q.id] === 'later');
}

/** Apply the accepted quantity source to each reconciled change. The other values stay in `alternatives`. */
export function applyQuantitySources(result: AnalysisResult, res: Resolutions): AnalysisResult {
  const changes = result.changes.map((c) => {
    const pick = res.quantitySource[c.id];
    if (!pick || pick === 'measured' || !c.conflict) return c.conflict && pick === 'measured' ? { ...c, conflict: false, conflictNote: `Measured value accepted by the user. Other values kept: ${c.alternatives.map((a) => `${a.source} ${a.value} ${a.unit}`).join('; ')}.` } : c;
    const idx = Number(pick.replace('alt-', ''));
    const alt = c.alternatives[idx];
    if (!alt) return c;
    const others = [{ basis: c.basis, value: c.changeQty, unit: c.unit, source: 'Previously proposed', quote: c.measurementBasis }, ...c.alternatives.filter((_, i) => i !== idx)];
    return { ...c, changeQty: alt.value, unit: alt.unit, basis: alt.basis, acceptedFrom: alt.basis, measurementBasis: `Accepted by the user from ${alt.source}: “${alt.quote}”`, alternatives: others, conflict: false, conflictNote: `User accepted ${alt.source}. Alternatives retained.` };
  });
  return { ...result, changes };
}

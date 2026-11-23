import type { BoqItemRecord } from './types';

/**
 * Change scope model. The model proposes a scope; code validates it. Quantities carry their provenance so a
 * document-stated number is never presented as a measured one.
 */

export type QuantityOrigin = 'stated_in_document' | 'user_entered' | 'derived_from_stated' | 'measured_from_geometry';

export interface ScopeQuantity {
  value: string;
  unit: string;
  origin: QuantityOrigin;
  /** Where in the evidence it came from (file name, clause, or narrative). */
  source: string;
  /** Verbatim text the number was read from. Checked against the evidence. */
  quote: string;
}

export type ScopeAction = 'add' | 'omit' | 'replace' | 'rework';

export interface ScopeComponent {
  id: string;
  /** Short name, e.g. "Asphalt wearing course". */
  name: string;
  action: ScopeAction;
  discipline: string;
  workType: string;
  material: string;
  specification: string;
  location: string;
  /** Terms and synonyms useful for finding BOQ lines. */
  searchTerms: string[];
  /** Unit the BOQ line is expected to be measured in, when it can be told from the work type. */
  expectedUnit: string;
  quantity: ScopeQuantity | null;
  /** Dimensions needed to turn the quantity into the BOQ unit that the evidence does not give. */
  missingInputs: string[];
  /** True when the component is plausible but the evidence does not establish it. */
  potential: boolean;
  potentialReason: string;
  evidence: string[];
}

export interface ChangeScope {
  summary: string;
  location: string;
  packageName: string;
  components: ScopeComponent[];
  contradictions: string[];
  missingInformation: string[];
  /** Evidence limitations stated honestly, e.g. "drawings not analysed". */
  limitations: string[];
}

export interface EvidenceDoc {
  name: string;
  kind: 'pvr' | 'narrative' | 'specification' | 'drawing' | 'other';
  /** Extracted text. Empty when no extraction capability exists for this file type. */
  text: string;
  extracted: boolean;
  /** Why no text is available, when extracted is false. */
  note: string;
}

export interface CandidateBrief {
  rowId: string;
  ref: string;
  description: string;
  unit: string;
  bill: string;
  section: string;
  file: string;
  hasRate: boolean;
}

export type MatchStatus = 'applies' | 'potential' | 'alternative' | 'excluded';

export interface ProposedLine {
  componentId: string;
  rowId: string;
  /** Different work component that all apply vs an alternative for the same component. */
  role: 'primary' | 'alternative';
  why: string;
  /** Preamble / measurement rule that bears on this line. */
  preambleNote: string;
  coveredByCompositeOf?: string;
}

export interface ModelMatchResult {
  lines: ProposedLine[];
  potentiallyAffected: { componentId: string; reason: string }[];
  unmatched: { componentId: string; reason: string }[];
  overlaps: { rowIds: string[]; reason: string }[];
}

export function briefOf(item: BoqItemRecord, section: string): CandidateBrief {
  return { rowId: item.id, ref: item.ref, description: item.description, unit: item.unit, bill: item.bill, section, file: item.sourceFile, hasRate: item.rate.state === 'value' };
}

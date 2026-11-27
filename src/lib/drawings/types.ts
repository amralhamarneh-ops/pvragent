/**
 * Types for the automatic document and drawing analysis. Every value carries its provenance so a measured number is
 * never confused with a document-stated one, and every limitation is reported rather than hidden.
 */

export type ReadState = 'uploaded' | 'read' | 'validated' | 'unsupported' | 'failed';

export type QuantityBasis = 'measured' | 'derived' | 'document_stated' | 'narrative_stated' | 'user_entered';

export const BASIS_LABEL: Record<QuantityBasis, string> = {
  measured: 'Measured',
  derived: 'Derived',
  document_stated: 'Document-stated',
  narrative_stated: 'Narrative-stated',
  user_entered: 'User-entered',
};

export type DateMeaning =
  | 'drawing_revision' |'drawing_issue' |'instruction' |'event_reported' |'pvr_submission' |'schedule_data_date' |'unclassified';

export const DATE_LABEL: Record<DateMeaning, string> = {
  drawing_revision: 'Drawing revision date',
  drawing_issue: 'Drawing issue / transmittal date',
  instruction: 'Instruction date',
  event_reported: 'Reported event date',
  pvr_submission: 'PVR submission date',
  schedule_data_date: 'Schedule data date',
  unclassified: 'Date with unclear meaning',
};

export interface FoundDate {
  /** ISO yyyy-mm-dd. */
  iso: string;
  /** The text exactly as found. */
  raw: string;
  meaning: DateMeaning;
  source: string;
  /** The words around the date that justify the label. */
  context: string;
}

export interface TitleBlock {
  drawingNumber: string;
  revision: string;
  title: string;
  /** Dates found in the drawing text, already classified. */
  dates: FoundDate[];
  /** Where each field came from, e.g. "DXF text 'DWG NO: R4-001'" or "file name". */
  provenance: { drawingNumber: string; revision: string; title: string };
}

export type DrawingFormat = 'dxf' | 'dwg' | 'pdf' | 'image' | 'other';

/** One drawn piece of a path. Arcs keep their true parameters; they are never reduced to chords. */
export type PathSegment =
  | { type: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { type: 'arc'; cx: number; cy: number; r: number; startAngle: number; endAngle: number; ccw: boolean };

export interface DrawingEntity {
  kind: string;
  layer: string;
  handle: string;
  /** Vertices in drawing units. */
  vertices: { x: number; y: number }[];
  closed: boolean;
  /** Pre-computed length in drawing units (0 for points and closed areas). Includes true arc length. */
  length: number;
  /** Area in square drawing units (closed shapes only). Includes bulge segments. */
  area: number;
  /** Block name for INSERT entities (counts). */
  blockName?: string;
  /** Exact drawn path: lines plus arcs from bulges, ARC and CIRCLE. Used for rendering and measuring. */
  segments?: PathSegment[];
  /** Circle radius / arc radius, kept so curves are never treated as straight lines. */
  radius?: number;
  /** Set for geometry that came from expanding a block definition. */
  fromBlock?: string;
  /** True when a bulge/arc was present and measured as a curve. */
  curved?: boolean;
}

export interface DrawingFile {
  fileName: string;
  format: DrawingFormat;
  state: ReadState;
  /** Exact reason when state is unsupported or failed. */
  limitation: string;
  titleBlock: TitleBlock | null;
  /** Annotation / attribute text found in model space (title block text included). Used for specification comparison. */
  texts: string[];
  /** Drawing unit declared in the file ($INSUNITS), or null when absent. */
  unit: 'mm' | 'cm' | 'm' | null;
  unitSource: string;
  entities: DrawingEntity[];
  layers: string[];
  extents: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** Problems found while validating (missing unit, no entities, etc.). */
  validationIssues: string[];
  /** Metres per drawing unit once validated. */
  metresPerUnit: number | null;
  /** Per-layer entity counts, for the live preview and layer controls. */
  layerCounts?: Record<string, number>;
  /** Entities whose type was not measured, by DXF type name, so the limitation is explicit. */
  skippedTypes?: Record<string, number>;
  /** How many INSERTs were expanded into real geometry (with rotation/scale/translation). */
  expandedBlocks?: number;
  /** A same-stem plotted sheet identified this file as a typical detail, not an installed alignment. */
  detailOnlyEvidence?: string;
  /** SHA-256 of the original bytes, so a viewer result is tied to the exact file. */
  sha256?: string;
  /** True when external references or unsupported geometry mean quantities may be understated. */
  coverageLimited?: boolean;
  /** XREF blocks whose geometry is not in this file. */
  unresolvedXrefs?: string[];
  /** Present when this DXF was produced from a DWG: converter, version, and hashes of both files. */
  conversion?: { converter: string; converterVersion?: string; sourceSha256?: string; dxfSha256?: string; warnings: string[] };
}

/** Real processing events, emitted by the parser/comparison as each stage genuinely completes. */
export type AnalysisStage = 'loading' | 'parsing' | 'geometry' | 'alignment' | 'comparison' | 'measurement' | 'reconciliation';

/**
 * One batch of real parsed geometry. Carried by a `geometry` event so the viewer draws what the parser has actually
 * produced so far. `entities` hold only what the viewer needs to draw and select; measurements stay in the analysis.
 */
export interface GeometryBatch {
  caseId: string;
  runId: string;
  /** Registry document id when known, otherwise the file name. */
  documentId: string;
  fileName: string;
  /** Position of the batch within this layer, 0-based, and the number of batches for the layer. */
  batchIndex: number;
  layer: string;
  entityIds: string[];
  /** Drawable entities in drawing units. */
  entities: DrawingEntity[];
  /** Metres per drawing unit once the units are established, otherwise null. */
  metresPerUnit: number | null;
  unit: 'mm' | 'cm' | 'm' | null;
  /** Extent of this batch in drawing units. */
  extents: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** Entities delivered so far for the file, and the total once known. */
  delivered: number;
  total: number;
}

export interface ProcessingEvent {
  /** Increments for each event of a run. */
  seq: number;
  runId: string;
  caseId: string;
  stage: AnalysisStage;
  status: 'started' | 'progress' | 'done' | 'failed' | 'skipped';
  fileName?: string;
  layer?: string;
  /** Entity count for a layer, or total entities for the file. */
  count?: number;
  detail: string;
  at: number;
  /** Present on geometry events that carry real parsed entities. */
  batch?: GeometryBatch;
}

/** A text document read by PDF/DOCX/OCR/plain extraction, with the page/sheet it came from. */
export interface ExtractedDocument {
  name: string;
  method: 'plain' | 'pdf-text' | 'docx' | 'ocr' | 'xer';
  /** Text per page (PDF/OCR), per section (DOCX) or single block (plain). Page numbers are 1-based. */
  pages: { page: number; text: string; confidence?: number }[];
  truncated: boolean;
  limitation: string;
  /** 'section' for DOCX: `page` is then a text-section index and must never be shown as a physical page number. */
  unitKind?: 'page' | 'section';
}

export interface DrawingPair {
  original: DrawingFile;
  revised: DrawingFile;
  /** Why these two were paired, from contents. */
  basis: string[];
  validated: boolean;
  blockers: string[];
  /** Translation (metres) that maps the revised drawing onto the original's frame, when the origin moved. */
  originShift?: { dx: number; dy: number; matched: number; of: number } | null;
}

export interface MeasuredChange {
  id: string;
  /** Drawing layer or entity group that changed. */
  component: string;
  description: string;
  location: string;
  change: 'added' | 'removed' | 'modified';
  unit: 'm' | 'm2' | 'nr';
  originalQty: string;
  revisedQty: string;
  changeQty: string;
  /** Separate valuation records: the quantity added, the quantity omitted, and the net change. Absent values are '0'. */
  addedQty?: string;
  omittedQty?: string;
  netQty?: string;
  basis: QuantityBasis;
  /** How it was measured, in words. */
  measurementBasis: string;
  /** Structured basis for traceability. */
  trace?: QuantityTrace;
  sources: string[];
  /** Exact entities behind this change, so the viewer can focus them and an entity can open its change. */
  entityRefs?: ChangeEntityRefs;
  /** Set when the correspondence between original and revised elements is not certain. */
  ambiguity?: { reason: string; candidates: number };
  /** Evidence that ties this change to a stated relocation, naming the object or location. */
  relocationEvidence?: RelocationEvidence | null;
}

/** How a quantity was obtained. `formula` is the exact calculation; nothing is estimated from a missing dimension. */
export interface QuantityTrace {
  formula: string;
  measurementBasis: 'length' | 'area' | 'count';
  units: string;
  drawingRevision: string;
  originalFile: string;
  revisedFile: string;
  entityCount: { original: number; revised: number };
  /** Tolerance used to match elements, in metres. */
  toleranceM: number;
  /** Dimensions that would be needed to derive a volume or area from this and are not evidenced. */
  missingForDerivation?: string[];
}

/** A statement in the PVR or narrative that names the specific object/location that moved. */
export interface RelocationEvidence {
  source: string;
  sentence: string;
  /** The words in the sentence that tied it to this layer or location. */
  matchedOn: string[];
}

export interface ChangeEntityRefs {
  layer: string;
  original: { handle: string; kind: string; layer: string; fromBlock?: string }[];
  revised: { handle: string; kind: string; layer: string; fromBlock?: string }[];
  drawingNumber: string;
  originalRevision: string;
  revisedRevision: string;
  /** Offset applied to the revised drawing (metres) before comparison, when an origin shift was found. */
  originShift?: { dx: number; dy: number } | null;
}

export interface ReconciledChange {
  id: string;
  component: string;
  description: string;
  location: string;
  unit: string;
  originalQty: string;
  revisedQty: string;
  changeQty: string;
  addedQty?: string;
  omittedQty?: string;
  netQty?: string;
  basis: QuantityBasis;
  measurementBasis: string;
  trace?: QuantityTrace;
  sources: string[];
  /** Other values for the same component from other sources, kept visible and never overwritten. */
  alternatives: { basis: QuantityBasis; value: string; unit: string; source: string; quote: string }[];
  conflict: boolean;
  conflictNote: string;
  /** Present when the quantity was measured from drawings. */
  entityRefs?: ChangeEntityRefs;
  /** Change type from the drawing comparison. */
  change?: 'added' | 'removed' | 'modified';
  ambiguity?: { reason: string; candidates: number };
  relocationEvidence?: RelocationEvidence | null;
  /** Set when the user accepted a value other than the measured one. */
  acceptedFrom?: QuantityBasis;
}

export interface StatedQuantity {
  value: string;
  unit: string;
  basis: Extract<QuantityBasis, 'document_stated' | 'narrative_stated'>;
  source: string;
  quote: string;
  /** Words near the number that name what it measures. */
  subject: string;
}

export interface AnalysisQuestion {
  id: string;
  kind: 'pairing' | 'revision_order' | 'scale' | 'unit' | 'dimension' | 'conflict' | 'date' | 'unsupported_format' | 'correspondence' | 'origin_shift';
  title: string;
  issue: string;
  evidence: string[];
  proposal: string;
  options: { id: string; label: string }[];
  /** Questions that do not block comparison, quantities or BOQ matching. */
  blocksComparison: boolean;
}

export interface CapabilityReport {
  /** Formats the current backend can really process. */
  supportedFormats: string[];
  /** Operations actually implemented. */
  operations: string[];
  /** Formats seen in this upload that cannot be processed, with the reason. */
  unsupported: { fileName: string; reason: string }[];
}

export interface FileReadiness {
  fileName: string;
  role: string;
  state: ReadState;
  stateLabel: 'Uploaded' | 'Read successfully' | 'Partially read' | 'Validated' | 'Not supported' | 'Read failed';
  detail: string;
}

export interface AnalysisResult {
  startedAt: string;
  files: FileReadiness[];
  pairs: DrawingPair[];
  changes: ReconciledChange[];
  dates: FoundDate[];
  /** Proposed event / instruction date with evidence, or null → "Date unresolved". */
  proposedEventDate: { iso: string; meaning: DateMeaning; source: string; context: string } | null;
  questions: AnalysisQuestion[];
  capability: CapabilityReport;
  /** Plain-language events that really happened, in order. */
  events: { step: string; detail: string }[];
  /** Text handed to the BOQ matching agent: only confirmed, evidence-linked changes. */
  agentNarrative: string;
}

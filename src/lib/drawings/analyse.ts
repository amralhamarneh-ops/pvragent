import { readDxf } from './dxfRead';
import { pairDrawings, measurePair, validatePair, hasRelocationEvidence, relocationSentences, evidenceForObject, isDetailOnlyTitle, type RelocationInput } from './compare';
import { classifyDates, proposeEventDate, hasConflictingEventDates } from './dates';
import { extractStatedQuantities, narrativeFromChanges, reconcile } from './reconcile';
import { applyQuantitySources, EMPTY_RESOLUTIONS, type Resolutions } from './resolve';
import type { Extractor } from './extractClient';
import { parseXer } from '@/lib/mapping/xerParser';
import type { ScheduleModel } from '@/lib/mapping/types';
import type { AnalysisQuestion, AnalysisResult, AnalysisStage, CapabilityReport, DrawingFile, DrawingPair, ExtractedDocument, FileReadiness, FoundDate, MeasuredChange, ProcessingEvent, StatedQuantity } from './types';

export interface InputFile {
  name: string;
  /** Raw bytes of the file the user actually uploaded. Absent when only metadata survived (e.g. restored draft). */
  bytes: Uint8Array | null;
  role: 'drawings' | 'pvr' | 'correspondence' | 'schedule' | 'boq' | 'contract' | 'site' | 'reference' | 'unused';
  /** Registry document id, so results can be tied to the exact stored version. */
  docId?: string;
}

export interface AnalyseArgs {
  files: InputFile[];
  narrative: string;
  /** Optional user entries (override only; never required). */
  manual?: { quantity?: { componentId: string; value: string; unit: string }[] };
  /** Typed resolutions of earlier questions. Each one changes an input and the analysis is re-run. */
  resolutions?: Resolutions;
  /** Real processing events, emitted as each stage genuinely happens. */
  onEvent?: (e: ProcessingEvent) => void;
  runId?: string;
  caseId?: string;
  /** Cancels the run. A cancelled run resolves with `cancelled: true` and emits nothing further. */
  signal?: AbortSignal;
  /** PDF/DOCX/OCR/DWG extraction. Without it those formats are reported as not read, never skipped silently. */
  extractor?: Extractor;
  /** Server capabilities, so unavailable processors are named exactly. */
  capabilities?: { ocrScannedPdf: boolean; dwg: { configured: boolean; requirement?: string } } | null;
}

export const CAPABILITY: Omit<CapabilityReport, 'unsupported'> = {
  supportedFormats: [
    'DXF (ASCII) drawings, including polyline bulges, arcs, circles and block inserts with rotation/scale',
    'DWG through a configured server-side converter (ODA File Converter or LibreDWG); otherwise upload ASCII DXF',
    'PDF text (per page), scanned PDF pages and images through OCR',
    'Word (.docx) text',
    'Plain text (.txt, .md, .csv, .eml, .log)',
    'Primavera XER programmes',
    'CSV / XLSX BOQ workbooks (multiple files and sheets, read by the BOQ importer)',
  ],
  operations: [
    'Read drawing number, revision, title and dates from DXF text',
    'Read drawing units from $INSUNITS (mm, cm, m)',
    'Pair original and revised drawings by drawing number and revision order',
    'Validate units, alignment and shared layers before measuring',
    'Entity-level comparison: additions, removals and (only with correspondence evidence) relocations; annotation/specification text changes',
    'Measure line/polyline/arc/circle length (true curve length), closed-path area including bulges, and block counts',
    'Extract stated quantities and dates from text and classify date meaning',
    'Reconcile drawing, PVR and narrative quantities and flag conflicts',
  ],
};

const TEXT_EXT = /\.(txt|md|csv|eml|log)$/i;
const MAX_TEXT = 400_000;
const DOC_EXT = /\.(pdf|docx|png|jpe?g|tiff?|bmp|webp)$/i;

function ext(name: string): string { return (name.match(/\.([a-z0-9]+)$/i) ?? [])[1]?.toLowerCase() ?? ''; }

function unsupportedReason(name: string): string {
  const e = ext(name);
  if (e === 'dwg') return 'DWG is a proprietary binary format. No DWG converter is configured on this deployment (set DWG_CONVERTER and DWG_CONVERTER_PATH for ODA File Converter or LibreDWG), so this file was not read. Export the drawing as ASCII DXF and upload that instead.';
  if (['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp'].includes(e)) return 'A scanned or raster drawing can be OCR-read for text, but no scale or alignment has been established, so no geometry is measured from it.';
  if (e === 'doc') return 'Legacy Word (.doc) files are not supported. Save as .docx.';
  if (['xls', 'xlsx', 'xlsm'].includes(e)) return 'Spreadsheets are read by the BOQ importer, not by the change analysis.';
  return `The .${e || 'unknown'} format cannot be processed by this backend.`;
}

const textOfDoc = (d: ExtractedDocument) => d.pages.map((p) => p.text).join('\n\n');

/**
 * A document is only "fully read" when nothing was skipped. Truncation, a limitation that names pages that were NOT
 * read / OCR'd / could not be read, or any page with no recovered text all make it partial.
 */
const isPartialRead = (d: ExtractedDocument): boolean =>
  d.truncated || /NOT (read|OCR)|could not be read|could not run|OCR failed|recognised no text/i.test(d.limitation) ||
  (d.method !== 'plain' && d.pages.length > 0 && d.pages.some((p) => !p.text.trim()));

export interface AnalysisOutput extends AnalysisResult {
  extracted: { name: string; text: string }[];
  /** Full extraction with page references. */
  documents: ExtractedDocument[];
  /** Parsed programmes, with the file they came from. */
  schedules: { fileName: string; model: ScheduleModel }[];
  /** The parsed drawing geometry, kept so the viewer draws exactly what was analysed. */
  drawings: DrawingFile[];
  /** Whether correspondence/PVR wording confirmed relocation; the viewer must use the same value as the measurement. */
  relocationEvidence: boolean;
  /** Relocation statements found; the viewer resolves evidence per object from these, exactly as the measurement did. */
  relocationSentences: { source: string; sentence: string }[];
  cancelled: boolean;
}

/**
 * Run the real analysis on the files the user uploaded. Every step that happens is recorded in `events` and emitted
 * through `onEvent`; a format that cannot be processed is reported as a limitation and produces no data.
 */
export async function analyseDocuments(args: AnalyseArgs): Promise<AnalysisOutput> {
  const res = args.resolutions ?? EMPTY_RESOLUTIONS;
  const startedAt = new Date().toISOString();
  const events: AnalysisResult['events'] = [];
  const readiness: FileReadiness[] = [];
  const unsupported: CapabilityReport['unsupported'] = [];
  const questions: AnalysisQuestion[] = [];
  const dates: FoundDate[] = [];
  const stated: StatedQuantity[] = [];
  const drawings: DrawingFile[] = [];
  const extracted: { name: string; text: string }[] = [];
  const detailCompanions = new Map<string, string[]>();
  const stemOf = (n: string) => (n.split(/[\\/]/).at(-1) ?? n).replace(/\.[^.]+$/, '').toLowerCase();
  const documents: ExtractedDocument[] = [];
  const schedules: { fileName: string; model: ScheduleModel }[] = [];
  const runId = args.runId ?? 'run';
  const caseId = args.caseId ?? '';
  let seq = 0;
  const parsedAnnounced = new Set<string>();
  const cancelled = () => !!args.signal?.aborted;
  const emit = (stage: AnalysisStage, status: ProcessingEvent['status'], detail: string, more: Partial<ProcessingEvent> = {}) => {
    if (cancelled()) return;
    args.onEvent?.({ seq: (seq += 1), runId, caseId, stage, status, detail, at: Date.now(), ...more });
  };
  let relocationFlag = false;
  let sentencesFound: { source: string; sentence: string }[] = [];
  const finish = (r: AnalysisResult): AnalysisOutput => ({ ...r, extracted, documents, schedules, drawings, relocationEvidence: relocationFlag, relocationSentences: sentencesFound, cancelled: cancelled() });
  const log = (step: string, detail: string) => events.push({ step, detail });

  if (args.narrative.trim()) {
    stated.push(...extractStatedQuantities(args.narrative, 'Narrative', 'narrative_stated'));
    dates.push(...classifyDates(args.narrative, { source: 'Narrative', documentKind: 'narrative' }));
    log('Read narrative', `${args.narrative.trim().length} characters, ${stated.filter((s) => s.source === 'Narrative').length} quantity(ies) and ${dates.length} date(s) found.`);
  }

  for (const f of args.files) {
    if (cancelled()) break;
    const e = ext(f.name);
    emit('loading', 'started', `Loading ${f.name}`, { fileName: f.name });

    // Programmes: parse XER for the activity stage.
    if (f.role === 'schedule' || e === 'xer') {
      if (e === 'xer' && f.bytes) {
        emit('parsing', 'started', `Parsing programme ${f.name}`, { fileName: f.name });
        try {
          const model = parseXer(new TextDecoder('utf-8').decode(f.bytes), f.name);
          schedules.push({ fileName: f.name, model });
          readiness.push({ fileName: f.name, role: 'Schedule', state: 'read', stateLabel: 'Read successfully', detail: `${model.activityCount} activities and ${model.relationships.length} relationships read${model.dataDate ? `; data date ${model.dataDate}` : '; no data date found'}.` });
          log('Read programme', `${f.name}: ${model.activityCount} activities, ${model.relationships.length} relationships.`);
          emit('parsing', 'done', `${f.name}: ${model.activityCount} activities, ${model.relationships.length} relationships`, { fileName: f.name, count: model.activityCount });
        } catch (err) {
          const m = `The programme could not be parsed: ${err instanceof Error ? err.message : 'unknown error'}`;
          readiness.push({ fileName: f.name, role: 'Schedule', state: 'failed', stateLabel: 'Read failed', detail: m });
          emit('parsing', 'failed', m, { fileName: f.name });
        }
      } else readiness.push({ fileName: f.name, role: 'Schedule', state: 'uploaded', stateLabel: 'Uploaded', detail: f.bytes ? 'Only Primavera .xer programmes are parsed.' : 'The file contents are not available in this session. Use "Reconnect this file" to read it.' });
      continue;
    }

    if (f.role === 'drawings') {
      if (!f.bytes) {
        readiness.push({ fileName: f.name, role: 'Drawing', state: 'uploaded', stateLabel: 'Uploaded', detail: 'The file contents are not available in this session. Use "Reconnect this file" to read it.' });
        unsupported.push({ fileName: f.name, reason: 'File contents are not available in this session.' });
        continue;
      }
      let dxfName = f.name; let dxfBytes: Uint8Array | null = null; let convertedBy = '';
      let conversion: import('./extractClient').ConversionInfo | undefined;
      if (e === 'dxf') dxfBytes = f.bytes;
      else if (e === 'dwg' && args.extractor) {
        emit('loading', 'progress', `Converting ${f.name} from DWG to DXF`, { fileName: f.name });
        const out = await args.extractor(f.name, f.bytes, undefined, args.signal);
        if (out.kind === 'dwg' && out.ok && out.dxf) { dxfBytes = out.dxf; convertedBy = out.converter ?? ''; conversion = out.conversion; dxfName = f.name; log('Convert DWG', `${f.name}: converted to DXF with ${convertedBy}${conversion?.converterVersion ? ` (${conversion.converterVersion})` : ''}; DXF sha256 ${conversion?.dxfSha256?.slice(0, 12) ?? 'not recorded'}. ${conversion?.warnings?.length ? `${conversion.warnings.length} converter warning(s).` : ''}`.trim()); }
        else {
          const reason = (out.kind === 'dwg' || out.kind === 'text') && out.error ? out.error : unsupportedReason(f.name);
          unsupported.push({ fileName: f.name, reason });
          readiness.push({ fileName: f.name, role: 'Drawing', state: 'unsupported', stateLabel: 'Not supported', detail: reason });
          log('Check drawing format', `${f.name}: ${reason}`);
          emit('loading', 'failed', `${f.name}: ${reason}`, { fileName: f.name });
          questions.push({ id: `fmt-${f.name}`, kind: 'unsupported_format', blocksComparison: false, title: `${f.name} could not be converted`, issue: reason, evidence: [f.name], proposal: 'Upload an ASCII DXF export of this drawing, or configure the server DWG converter.', options: [{ id: 'dxf', label: 'I will upload a DXF export' }, { id: 'stated', label: 'Use stated quantities only' }] });
          continue;
        }
      }
      if (dxfBytes) {
        emit('parsing', 'started', `Parsing ${f.name} (the DXF text is parsed as a whole; geometry is delivered after parsing completes)`, { fileName: f.name });
        const docId = f.docId ?? f.name;
        let d = await readDxf(dxfName, dxfBytes, (stage, info) => {
          if (stage === 'layer') emit('geometry', 'progress', info.detail, { fileName: f.name, layer: info.layer, count: info.count });
          else if (stage === 'geometry') emit('geometry', 'done', info.detail, { fileName: f.name, count: info.count });
          else emit('parsing', 'progress', info.detail, { fileName: f.name });
        }, {
          signal: args.signal,
          onBatch: (b) => {
            if (cancelled()) return;
            // First batch means parsing has really finished and geometry is being produced.
            if (!parsedAnnounced.has(f.name)) { parsedAnnounced.add(f.name); emit('parsing', 'done', `${f.name}: parsed; delivering geometry`, { fileName: f.name }); }
            emit('geometry', 'progress', `${f.name} · ${b.layer}: batch ${b.batchIndex + 1} (${b.delivered} of ${b.total} entities)`, {
              fileName: f.name, layer: b.layer, count: b.delivered,
              batch: { caseId, runId, documentId: docId, fileName: f.name, batchIndex: b.batchIndex, layer: b.layer, entityIds: b.entityIds, entities: b.entities, metresPerUnit: b.metresPerUnit, unit: b.unit, extents: b.extents, delivered: b.delivered, total: b.total },
            });
          },
        });
        if (cancelled()) break;
        if (convertedBy) {
          const extra = [`Converted from DWG by ${convertedBy}${conversion?.converterVersion ? ` (${conversion.converterVersion})` : ''}; verify units and extents against the source.`, ...(conversion?.warnings ?? []).slice(0, 5).map((w) => `Converter warning: ${w}`), ...(conversion?.validationIssues ?? []).map((w) => `Converted DXF: ${w}`)];
          d = { ...d, validationIssues: [...d.validationIssues, ...extra], conversion: { converter: convertedBy, converterVersion: conversion?.converterVersion, sourceSha256: conversion?.sourceSha256, dxfSha256: conversion?.dxfSha256, warnings: conversion?.warnings ?? [] }, coverageLimited: d.coverageLimited || (conversion?.warnings?.length ?? 0) > 0 };
        }
        const confirmed = res.unitOverride[f.name];
        if (confirmed && d.metresPerUnit === null && d.state === 'read') {
          d = { ...d, unit: confirmed, metresPerUnit: confirmed === 'm' ? 1 : confirmed === 'cm' ? 0.01 : 0.001, unitSource: `Confirmed by the user as ${confirmed} (the file does not declare units)`, validationIssues: d.validationIssues.filter((i) => !/units/i.test(i)) };
          log('Apply answer', `${f.name}: units set to ${confirmed} from your answer; comparison re-run.`);
        }
        drawings.push(d);
        log('Read drawing', `${f.name}: ${d.state === 'read' ? `${d.entities.length} measurable entities on ${d.layers.length} layer(s); drawing ${d.titleBlock?.drawingNumber || 'number not found'} revision ${d.titleBlock?.revision || 'not found'}` : d.limitation}`);
        if (d.titleBlock) dates.push(...d.titleBlock.dates);
        if (d.state === 'failed' || d.state === 'unsupported') { unsupported.push({ fileName: f.name, reason: d.limitation }); readiness.push({ fileName: f.name, role: 'Drawing', state: d.state, stateLabel: d.state === 'unsupported' ? 'Not supported' : 'Read failed', detail: d.limitation }); emit('parsing', 'failed', d.limitation, { fileName: f.name }); }
        else { readiness.push({ fileName: f.name, role: 'Drawing', state: 'read', stateLabel: d.coverageLimited ? 'Partially read' : 'Read successfully', detail: `${d.entities.length} entities, ${d.layers.length} layers. ${d.coverageLimited ? 'COVERAGE IS LIMITED: ' + d.validationIssues.filter((i) => /external reference|Coverage is limited/.test(i)).join(' ') + ' ' : ''}Not yet validated for measurement.` }); if (d.coverageLimited) unsupported.push({ fileName: f.name, reason: `Coverage limited - ${d.validationIssues.filter((i) => /external reference|Coverage is limited/.test(i)).join(' ')}` }); emit('parsing', 'done', `${f.name}: ${d.entities.length} entities on ${d.layers.length} layer(s)`, { fileName: f.name, count: d.entities.length }); }
      } else if (DOC_EXT.test(f.name) && args.extractor) {
        // Flattened drawing (PDF/scan): text only. Analysed regions are pages; no layers exist and nothing is measured.
        emit('parsing', 'started', `Reading flattened drawing ${f.name} (text only)`, { fileName: f.name });
        const out = await args.extractor(f.name, f.bytes, (d) => emit('parsing', 'progress', d, { fileName: f.name }), args.signal);
        if (cancelled()) break;
        const reason = unsupportedReason(f.name.replace(/\.pdf$/i, '.png'));
        if (out.kind === 'text' && out.ok && out.doc) {
          documents.push(out.doc);
          const txt = textOfDoc(out.doc);
          // A labelled typical detail may state component dimensions without any installed quantity.
          // Check only its title block (not every occurrence of “typical detail” in notes).
          const detail = out.doc.pages.length === 1 && out.doc.pages.some(({ text }) => {
            const lines = text.split(/\r?\n/);
            const label = /\bdrawing\s+title\b[ \t:]*/i;
            for (const [i, line] of lines.entries()) {
              if (!label.test(line)) continue;
              const rows = [line.split(label)[1] ?? '', ...lines.slice(i + 1, i + 6)];
              // Extractors can interleave an adjacent notes column immediately after the title.
              const title = rows.slice(0, rows.findIndex((row) => /\btypical (?:details?|sections?|assembl(?:y|ies))\b/i.test(row)) + 1).join(' ') || rows.join(' ');
              if (isDetailOnlyTitle(title)) return true;
            }
            return false;
          });
          if (detail) {
            const stem = stemOf(f.name);
            detailCompanions.set(stem, [...(detailCompanions.get(stem) ?? []), f.name]);
          }
          else stated.push(...extractStatedQuantities(txt, f.name, 'document_stated'));
          dates.push(...classifyDates(txt, { source: f.name, documentKind: 'other' }));
          extracted.push({ name: f.name, text: txt });
          unsupported.push({ fileName: f.name, reason: 'Flattened PDF/scan: text was read, but no scale or alignment is established, so no geometry is measured. Upload a DXF for measurement.' });
          readiness.push({ fileName: f.name, role: 'Drawing', state: 'unsupported', stateLabel: 'Not supported', detail: `Text read from ${out.doc.pages.length} page(s) (${out.doc.method}); not measurable as geometry. ${out.doc.limitation}`.trim() });
          emit('parsing', 'done', `${f.name}: text read from ${out.doc.pages.length} page(s); no geometry`, { fileName: f.name, count: out.doc.pages.length });
        } else {
          const why = out.error ?? reason;
          unsupported.push({ fileName: f.name, reason: why });
          readiness.push({ fileName: f.name, role: 'Drawing', state: 'unsupported', stateLabel: 'Not supported', detail: why });
          emit('parsing', 'failed', why, { fileName: f.name });
        }
      } else {
        const reason = unsupportedReason(f.name);
        unsupported.push({ fileName: f.name, reason });
        readiness.push({ fileName: f.name, role: 'Drawing', state: 'unsupported', stateLabel: 'Not supported', detail: reason });
        log('Check drawing format', `${f.name}: ${reason}`);
        questions.push({ id: `fmt-${f.name}`, kind: 'unsupported_format', blocksComparison: false, title: `${f.name} cannot be measured`, issue: reason, evidence: [f.name], proposal: 'Quantities for this drawing will come from stated values only, or from a DXF export.', options: [{ id: 'dxf', label: 'I will upload a DXF export' }, { id: 'stated', label: 'Use stated quantities only' }] });
      }
      continue;
    }

    const textual = f.role === 'pvr' || f.role === 'correspondence' || f.role === 'contract' || f.role === 'reference' || f.role === 'site';
    if (TEXT_EXT.test(f.name) && f.bytes) {
      const text = new TextDecoder('utf-8').decode(f.bytes.slice(0, MAX_TEXT));
      const kind = f.role === 'pvr' ? 'pvr' : f.role === 'correspondence' ? 'correspondence' : 'other';
      const q = extractStatedQuantities(text, f.name, 'document_stated');
      const dts = classifyDates(text, { source: f.name, documentKind: kind });
      stated.push(...q); dates.push(...dts);
      documents.push({ name: f.name, method: 'plain', pages: [{ page: 1, text }], truncated: f.bytes.byteLength > MAX_TEXT, limitation: f.bytes.byteLength > MAX_TEXT ? `Only the first ${MAX_TEXT} bytes were read.` : '' });
      if (textual) extracted.push({ name: f.name, text });
      log('Read document', `${f.name}: ${text.length} characters read (${f.bytes.byteLength > MAX_TEXT ? 'first 400,000 bytes only' : 'complete'}); ${q.length} quantity(ies), ${dts.length} date(s).`);
      readiness.push({ fileName: f.name, role: f.role === 'pvr' ? 'PVR' : f.role, state: 'read', stateLabel: 'Read successfully', detail: `${q.length} quantities and ${dts.length} dates found${f.bytes.byteLength > MAX_TEXT ? '; only the first 400,000 bytes were read' : ''}.` });
      emit('parsing', 'done', `${f.name}: ${text.length} characters`, { fileName: f.name, count: text.length });
    } else if (textual && DOC_EXT.test(f.name) && f.bytes && args.extractor) {
      emit('parsing', 'started', `Extracting text from ${f.name}`, { fileName: f.name });
      const out = await args.extractor(f.name, f.bytes, (d) => emit('parsing', 'progress', d, { fileName: f.name }), args.signal);
      if (cancelled()) break;
      if (out.kind === 'text' && out.ok && out.doc) {
        const doc = out.doc; documents.push(doc);
        const txt = textOfDoc(doc);
        const kind = f.role === 'pvr' ? 'pvr' : f.role === 'correspondence' ? 'correspondence' : 'other';
        const q = extractStatedQuantities(txt, f.name, 'document_stated'); const dts = classifyDates(txt, { source: f.name, documentKind: kind });
        stated.push(...q); dates.push(...dts); extracted.push({ name: f.name, text: txt });
        const unitWord = doc.unitKind === 'section' ? 'text section(s) (not physical pages)' : 'page(s)';
        const partial = isPartialRead(doc);
        log('Read document', `${f.name}: ${txt.length} characters from ${doc.pages.length} ${unitWord} by ${doc.method}; ${q.length} quantity(ies), ${dts.length} date(s). ${doc.limitation}`.trim());
        readiness.push({ fileName: f.name, role: f.role === 'pvr' ? 'PVR' : f.role, state: 'read', stateLabel: partial ? 'Partially read' : 'Read successfully', detail: `${doc.pages.length} ${unitWord} read by ${doc.method}${partial ? ' - COVERAGE IS INCOMPLETE' : ''}; ${q.length} quantities and ${dts.length} dates found. ${doc.limitation}`.trim() });
        if (partial) unsupported.push({ fileName: f.name, reason: `Partially read - ${doc.limitation}` });
        emit('parsing', 'done', `${f.name}: ${doc.pages.length} page(s) by ${doc.method}`, { fileName: f.name, count: doc.pages.length });
      } else {
        const why = out.error ?? `${f.name} could not be read.`;
        unsupported.push({ fileName: f.name, reason: why });
        readiness.push({ fileName: f.name, role: f.role === 'pvr' ? 'PVR' : f.role, state: 'failed', stateLabel: 'Read failed', detail: why });
        log('Read document', `${f.name}: ${why}`);
        emit('parsing', 'failed', why, { fileName: f.name });
      }
    } else if (textual) {
      const reason = f.bytes ? unsupportedReason(f.name) : 'The file contents are not available in this session. Use "Reconnect this file" to read it.';
      unsupported.push({ fileName: f.name, reason });
      readiness.push({ fileName: f.name, role: f.role === 'pvr' ? 'PVR' : f.role, state: f.bytes ? 'unsupported' : 'uploaded', stateLabel: f.bytes ? 'Not supported' : 'Uploaded', detail: reason });
      log('Check document format', `${f.name}: ${reason}`);
    } else if (f.role === 'boq') {
      readiness.push({ fileName: f.name, role: 'BOQ', state: 'uploaded', stateLabel: 'Uploaded', detail: 'BOQ files (CSV and every sheet of XLSX workbooks) are read and interpreted automatically by the BOQ importer.' });
    }
  }
  if (cancelled()) return finish({ startedAt, files: readiness, pairs: [], changes: [], dates, proposedEventDate: null, questions, capability: { ...CAPABILITY, unsupported }, events, agentNarrative: '' });

  // Pair, honouring the user's pairing/order answers, then validate and measure.
  emit('alignment', 'started', `Pairing ${drawings.length} drawing(s) and checking units and alignment`);
  for (const d of drawings) {
    const companion = detailCompanions.get(stemOf(d.fileName));
    if (companion?.length === 1 && drawings.filter((file) => stemOf(file.fileName) === stemOf(d.fileName)).length === 1) d.detailOnlyEvidence = companion[0];
  }
  const pairing = pairDrawings(drawings);
  const pairs: DrawingPair[] = [...pairing.pairs];
  for (const q of pairing.questions) {
    const chosen = res.pairOverride[q.id];
    if (!chosen) { questions.push(q); continue; }
    const [oName, rName] = chosen.split('|');
    const o = drawings.find((d) => d.fileName === oName); const r = drawings.find((d) => d.fileName === rName);
    if (o && r && o !== r) {
      pairs.push(validatePair({ original: o, revised: r, basis: [`Paired by your answer: original ${o.fileName}, revised ${r.fileName}.`], validated: false, blockers: [] }));
      log('Apply answer', `Pairing set from your answer: ${o.fileName} → ${r.fileName}; comparison re-run.`);
    } else questions.push(q);
  }
  pairing.unpaired.filter((u) => !pairs.some((p) => p.original.fileName === u.fileName || p.revised.fileName === u.fileName)).forEach((u) => log('Pair drawings', `${u.fileName}: ${u.reason}`));
  const corpusDocs = [{ source: 'Narrative', text: args.narrative }, ...extracted.map((x) => ({ source: x.name, text: x.text }))];
  const corpus = corpusDocs.map((c) => c.text);
  // Relocation is confirmed object by object: a sentence must name the layer's subject. A relocation word that
  // appears elsewhere in the narrative confirms nothing.
  const sentences = relocationSentences(corpusDocs);
  sentencesFound = sentences;
  const relocationEvidence = hasRelocationEvidence(corpus);
  relocationFlag = relocationEvidence;
  const resolver: RelocationInput = (layer) => evidenceForObject(layer, [], sentences);
  const measured: MeasuredChange[] = [];
  for (const p of pairs) {
    log('Validate pair', `${p.original.fileName} → ${p.revised.fileName}: ${p.validated ? `units, alignment and shared layers pass${p.originShift ? `; origin shift (${p.originShift.dx.toFixed(3)} m, ${p.originShift.dy.toFixed(3)} m) detected and applied` : ''}` : p.blockers.join(' ')}`);
    emit('alignment', p.validated ? 'done' : 'failed', `${p.original.fileName} → ${p.revised.fileName}: ${p.validated ? (p.originShift ? `aligned after an origin shift of (${p.originShift.dx.toFixed(3)} m, ${p.originShift.dy.toFixed(3)} m)` : 'aligned') : p.blockers.join(' ')}`);
    if (p.validated && p.originShift) questions.push({ id: `shift-${p.revised.fileName}`, kind: 'origin_shift', blocksComparison: false, title: 'The drawing origin moved between revisions', issue: `The revised drawing is the original translated by (${p.originShift.dx.toFixed(3)} m, ${p.originShift.dy.toFixed(3)} m): ${p.originShift.matched} of ${p.originShift.of} sampled elements coincide after the shift.`, evidence: [p.original.fileName, p.revised.fileName], proposal: 'The shift was applied before comparison so the whole drawing is not reported as changed.', options: [{ id: 'keep', label: 'Keep the shift correction' }] });
    if (!p.validated) {
      for (const b of p.blockers) {
        // An answer for one missing unit must never overwrite the partner drawing's independently declared unit.
        const unknown = [p.original, p.revised].find((f) => f.metresPerUnit === null && b.startsWith(`${f.fileName}:`));
        questions.push({ id: `val-${p.revised.fileName}-${questions.length}`, kind: unknown ? 'unit' : 'scale', blocksComparison: true, title: unknown ? `Confirm the units for ${unknown.fileName}` : 'The drawings cannot be compared yet', issue: b, evidence: unknown ? [unknown.fileName] : [p.original.fileName, p.revised.fileName], proposal: unknown ? 'No measurement was taken. Confirm this file’s model units, or export it again with units set.' : 'Nothing was measured. Review both files and confirm they describe the same comparable scope.', options: unknown ? [{ id: 'm', label: 'Units are metres' }, { id: 'cm', label: 'Units are centimetres' }, { id: 'mm', label: 'Units are millimetres' }, { id: 'later', label: 'I will re-export the DXF' }] : [{ id: 'later', label: 'I will fix and re-upload' }] });
      }
      continue;
    }
    emit('comparison', 'started', `Comparing ${p.original.fileName} with ${p.revised.fileName}`);
    const out = measurePair(p, 0.01, resolver);
    emit('comparison', 'done', `${out.changes.length} change(s) found`, { count: out.changes.length });
    emit('measurement', 'done', `${out.changes.length} change(s) measured from geometry`, { count: out.changes.length });
    measured.push(...out.changes);
    log('Measure changes', `${p.revised.fileName}: ${out.changes.length} change(s). ${out.notes.join(' ')}`.trim());
    p.revised.validationIssues.concat(p.original.validationIssues).filter((i) => /not measured/.test(i)).forEach((i) => log('Measurement limit', i));
    for (const n of out.notes.filter((x) => /not evidence of relocation/.test(x))) questions.push({ id: `reloc-${questions.length}`, kind: 'conflict', blocksComparison: false, title: 'Possible relocation needs confirmation', issue: n, evidence: [p.original.fileName, p.revised.fileName], proposal: 'Kept as an omission plus an addition until a statement names this object.', options: [{ id: 'keep', label: 'Keep as omission and addition' }] });
    for (const n of out.notes.filter((x) => /ambiguous correspondence/.test(x))) questions.push({ id: `amb-${questions.length}`, kind: 'correspondence', blocksComparison: false, title: 'Ambiguous correspondence between revisions', issue: n, evidence: [p.original.fileName, p.revised.fileName], proposal: 'Kept as separate omission and addition records until a person decides which elements correspond.', options: [{ id: 'keep', label: 'Keep as omission and addition' }, { id: 'review', label: 'Hold for review' }] });
  }
  for (let d of drawings) {
    const row = readiness.find((r) => r.fileName === d.fileName);
    if (!row) continue;
    const pair = pairs.find((p) => p.original === d || p.revised === d);
    if (pair?.validated) { row.state = 'validated'; row.stateLabel = 'Validated'; row.detail = `Paired with ${pair.original === d ? pair.revised.fileName : pair.original.fileName}; units, alignment and layers validated.`; }
    else if (pair) row.detail = `Read, but the pair failed validation: ${pair.blockers.join(' ')}`;
    else if (row.state === 'read') row.detail = `Read, but not paired for measurement. ${pairing.unpaired.find((u) => u.fileName === d.fileName)?.reason ?? ''}`.trim();
  }

  emit('reconciliation', 'started', 'Reconciling measured quantities with the PVR and narrative');
  const changes = reconcile({ measured, stated, userEntered: args.manual?.quantity });
  for (const c of changes.filter((x) => x.conflict)) {
    questions.push({ id: `conf-${c.id}`, kind: 'conflict', blocksComparison: false, title: `${c.component}: sources disagree`, issue: c.conflictNote, evidence: [c.measurementBasis, ...c.alternatives.map((a) => `${a.source}: “${a.quote}”`)], proposal: 'Measured value is shown; the other values are kept beside it.', options: [{ id: 'measured', label: `Use the measured ${c.changeQty} ${c.unit}` }, ...c.alternatives.map((a, i) => ({ id: `alt-${i}`, label: `Use ${a.source}: ${a.value} ${a.unit}` })), { id: 'review', label: 'Hold for review' }] });
  }
  log('Reconcile quantities', `${changes.length} change(s): ${changes.filter((c) => c.basis === 'measured').length} measured, ${changes.filter((c) => c.basis === 'document_stated' || c.basis === 'narrative_stated').length} stated only, ${changes.filter((c) => c.conflict).length} in conflict.`);

  const proposed = proposeEventDate(dates);
  const conflictDates = hasConflictingEventDates(dates);
  if (conflictDates.length && !res.eventDate) questions.push({ id: 'date-conflict', kind: 'date', blocksComparison: false, title: 'Different event dates were found', issue: `The documents give ${conflictDates.join(' and ')} as event dates.`, evidence: dates.filter((d) => d.meaning === 'event_reported').map((d) => `${d.source}: ${d.context}`), proposal: 'None proposed. Needed only when the schedule is assessed.', options: conflictDates.map((d) => ({ id: d, label: d })) });
  log('Classify dates', `${dates.length} date(s) found; event date ${proposed ? `proposed as ${proposed.iso} from ${proposed.source}` : 'unresolved (no explicit event or instruction label)'}.`);

  const report: CapabilityReport = { ...CAPABILITY, unsupported };
  let result: AnalysisResult = { startedAt, files: readiness, pairs, changes, dates, proposedEventDate: conflictDates.length && !res.eventDate ? null : res.eventDate ? { iso: res.eventDate, meaning: 'event_reported', source: 'Your answer', context: 'Chosen among conflicting event dates' } : proposed, questions, capability: report, events, agentNarrative: '' };
  result = applyQuantitySources(result, res);
  result.agentNarrative = narrativeFromChanges(result.changes);
  emit('reconciliation', 'done', `${result.changes.length} change(s) reconciled with evidence`, { count: result.changes.length });
  return finish(result);
}

'use client';

import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, FileSpreadsheet, Loader2, Upload } from 'lucide-react';
import { buildImport, confirmImport, needsNoQuestion, stageUpload, type StagedImport } from '@/lib/boq/importFlow';
import { applyAmbiguityChoice } from '@/lib/boq/autoInterpret';
import { classifyUpload, uploadIdentity } from '@/lib/boq/documents';
import { FIELD_LABEL, MAPPED_FIELDS, type BoqImport, type MappedField, type ParsedRow, type RowClass, type SheetMapping } from '@/lib/boq/types';

interface BoqImportPanelProps {
  caseId: string | null;
  currency: string;
  nextRevision: number;
  /** Complete imports already on the case. Used to detect duplicates BEFORE anything is written. */
  existingImports?: BoqImport[];
  /** Receives the confirmed import plus the exact original bytes, so the caller can store the file. */
  onConfirmed: (imp: BoqImport, originalBytes: Uint8Array) => void | Promise<void>;
  /** Called when the user uploads, so the parent can create the real case lazily. */
  ensureCase: () => Promise<string>;
  /**
   * BOQ files already uploaded through the main evidence upload. They are interpreted automatically; the user never
   * uploads them again. Each entry is keyed by document ID so a file is processed once per content version.
   */
  autoFiles?: { key: string; name: string; bytes: Uint8Array }[];
  /** Keys already processed (by the parent), so a reload does not re-import the same content. */
  processedKeys?: Set<string>;
  onProcessedKey?: (key: string) => void;
}

const CLASS_LABEL: Record<RowClass, string> = {
  item: 'Priced item', unpriced_item: 'Unpriced item', title: 'Title', blank: 'Blank', repeated_heading: 'Repeated heading', subtotal: 'Subtotal', bill_heading: 'Bill heading', note: 'Note',
};
const CLASS_TONE: Record<RowClass, string> = {
  item: 'bg-accent/10 text-accent', unpriced_item: 'bg-warning/15 text-warning', title: 'bg-muted text-muted-foreground', blank: 'bg-muted text-muted-foreground', repeated_heading: 'bg-muted text-muted-foreground', subtotal: 'bg-muted text-muted-foreground', bill_heading: 'bg-secondary text-secondary-foreground', note: 'bg-muted text-muted-foreground',
};

/** A file waiting for a human answer because its structure could not be read reliably. `id` is the persistent upload identity. */
interface Pending { id: string; staged: StagedImport; bytes: Uint8Array; mappings: SheetMapping[]; overrides: Record<string, boolean>; advanced: boolean; activeSheet: string }

/** `id` is the persistent upload identity (document + content hash), so the same upload always maps to the same entry. */
interface FileOutcome { id: string; name: string; state: 'confirmed' | 'question' | 'failed' | 'duplicate'; detail: string }

interface WorkItem { key: string; name: string; bytes: Uint8Array }

export default function BoqImportPanel({ caseId, currency, nextRevision, existingImports, onConfirmed, ensureCase, autoFiles, processedKeys, onProcessedKey }: BoqImportPanelProps) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [outcomes, setOutcomes] = useState<FileOutcome[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);

  /** Upload identities handled or in flight during this page life. This closes the race between the auto effect and a manual upload. */
  const handled = useRef<Set<string>>(new Set());
  /** Latest imports, read at processing time so a long-running loop never uses a stale snapshot. */
  const existingRef = useRef<BoqImport[]>(existingImports ?? []);
  existingRef.current = existingImports ?? [];
  const revRef = useRef(nextRevision);
  revRef.current = Math.max(revRef.current, nextRevision);

  /** Replace-or-insert by persistent id: the same upload can never produce two list entries. */
  const upsertOutcome = (list: FileOutcome[], next: FileOutcome): FileOutcome[] => (list.some((o) => o.id === next.id) ? list.map((o) => (o.id === next.id ? next : o)) : [...list, next]);

  const onFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const items = await Promise.all(Array.from(list).map(async (f) => ({ key: '', name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    await processItems(items);
  };

  /** Interpret BOQ workbooks that arrive from the shared evidence upload, once per content version. */
  const autoSig = (autoFiles ?? []).map((a) => a.key).join('|');
  useEffect(() => {
    const fresh = (autoFiles ?? []).filter((a) => !(processedKeys?.has(a.key)));
    if (fresh.length === 0 || busy) return;
    void processItems(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSig, busy]);

  const processItems = async (items: WorkItem[]) => {
    if (items.length === 0) return;
    setBusy(true);
    setError('');
    const results: FileOutcome[] = [];
    const waiting: Pending[] = [];
    try {
      const id = caseId ?? (await ensureCase());
      for (const item of items) {
        const file = { name: item.name };
        let identity = '';
        try {
          const bytes = item.bytes;
          const staged = await stageUpload(file.name, bytes);
          identity = uploadIdentity(file.name, staged.workbook.sha256);

          // Idempotence 1: identical content for this document already handled or in flight in this page life.
          if (handled.current.has(identity)) { if (item.key) onProcessedKey?.(item.key); continue; }

          // Idempotence 2: identical content already stored on the case. Reuse it; create nothing.
          const decision = classifyUpload(file.name, staged.workbook.sha256, existingRef.current);
          if (decision.kind === 'duplicate') {
            handled.current.add(identity);
            if (item.key) onProcessedKey?.(item.key);
            results.push({ id: identity, name: file.name, state: 'duplicate', detail: `Identical to revision ${decision.existing.revision} already on this case. The existing import is reused; nothing was added and nothing will be valued twice.` });
            continue;
          }

          handled.current.add(identity);
          const rev = revRef.current;
          const label = decision.kind === 'new_revision' ? `Revision ${rev} of ${decision.previous.source.fileName}` : `Revision ${rev}`;
          if (needsNoQuestion(staged)) {
            const { imp } = buildImport({ caseId: id, staged, mappings: staged.mappings, currency, revisionLabel: label, revision: rev });
            const n = imp.rows.filter((r) => r.included).length;
            if (n === 0) { handled.current.delete(identity); results.push({ id: identity, name: file.name, state: 'failed', detail: 'No priced item rows were found.' }); if (item.key) onProcessedKey?.(item.key); continue; }
            try {
              await onConfirmed(confirmImport({ ...imp, caseId: id }), bytes);
            } catch (e) {
              // The save did not complete: allow a deliberate retry of this exact upload, but do not loop automatically.
              handled.current.delete(identity);
              if (item.key) onProcessedKey?.(item.key);
              results.push({ id: identity, name: file.name, state: 'failed', detail: e instanceof Error ? e.message : 'The import could not be saved.' });
              continue;
            }
            revRef.current = rev + 1;
            if (item.key) onProcessedKey?.(item.key);
            results.push({ id: identity, name: file.name, state: 'confirmed', detail: `${decision.kind === 'new_revision' ? 'New revision of an existing document. ' : ''}${n} item(s) read automatically from ${staged.interpretation.sheets.filter((s) => s.mapping.included).length} sheet(s).` });
          } else {
            waiting.push({ id: identity, staged, bytes, mappings: staged.mappings, overrides: {}, advanced: false, activeSheet: staged.mappings.find((m) => m.included)?.sheet ?? staged.mappings[0]?.sheet ?? '' });
            if (item.key) onProcessedKey?.(item.key);
            results.push({ id: identity, name: file.name, state: 'question', detail: staged.interpretation.ambiguities.length ? 'A short question is needed.' : 'The structure could not be read reliably. Check the preview below.' });
          }
        } catch (e) {
          if (identity) handled.current.delete(identity);
          if (item.key) onProcessedKey?.(item.key);
          results.push({ id: identity || `${file.name}#unreadable`, name: file.name, state: 'failed', detail: e instanceof Error ? e.message : 'The file could not be read.' });
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the import.');
    } finally {
      setOutcomes((cur) => results.reduce(upsertOutcome, cur));
      setPending((cur) => {
        const ids = new Set(cur.map((p) => p.id));
        return [...cur, ...waiting.filter((w) => !ids.has(w.id))];
      });
      setBusy(false);
    }
  };

  const update = (pid: string, patch: Partial<Pending>) => setPending((l) => l.map((p) => (p.id === pid ? { ...p, ...patch } : p)));

  const confirmPending = async (p: Pending) => {
    setBusy(true);
    setError('');
    try {
      const id = caseId ?? (await ensureCase());
      const rev = revRef.current;
      const { imp } = buildImport({ caseId: id, staged: p.staged, mappings: p.mappings, currency, revisionLabel: `Revision ${rev}`, revision: rev, rowOverrides: p.overrides });
      await onConfirmed(confirmImport({ ...imp, caseId: id }), p.bytes);
      revRef.current = rev + 1;
      setPending((l) => l.filter((x) => x.id !== p.id));
      setOutcomes((o) => upsertOutcome(o, { id: p.id, name: p.staged.workbook.fileName, state: 'confirmed', detail: 'Confirmed after your answer.' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not confirm the import.');
    } finally {
      setBusy(false);
    }
  };

  const discard = (p: Pending) => {
    handled.current.delete(p.id);
    setPending((l) => l.filter((x) => x.id !== p.id));
    setOutcomes((o) => o.filter((x) => x.id !== p.id));
  };

  return (
    <section className="rounded-lg border border-border bg-card p-5 shadow-sm" aria-labelledby="boq-import-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <FileSpreadsheet size={22} className="mt-1 text-primary" aria-hidden />
          <div>
            <h2 id="boq-import-title" className="text-xl font-semibold text-foreground">BOQs for this case</h2>
            <p className="text-muted-foreground">BOQ workbooks you upload above are read here automatically; you do not upload them again. Different bills are all included together. Uploading a changed version of a bill you already have adds a new revision of that bill only. Uploading identical content again is recognised and reused.</p>
          </div>
        </div>
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-input bg-card px-3.5 py-2 font-medium text-foreground hover:bg-muted focus-within:outline focus-within:outline-2 focus-within:outline-ring">
          {busy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Upload size={16} aria-hidden />}
          Add another BOQ or revision
          <input type="file" multiple accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" disabled={busy} onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }} aria-label="Choose BOQ files" />
        </label>
      </div>

      {busy && outcomes.length === 0 ? <p role="status" className="mt-3 text-muted-foreground">Reading and interpreting the files…</p> : null}
      {error ? <p role="alert" className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-destructive">{error}</p> : null}

      {outcomes.length > 0 ? (
        <ul className="mt-3 divide-y divide-border rounded-md border border-border" aria-label="Upload results">
          {outcomes.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <span className={`rounded px-2 py-0.5 text-xs font-medium ${o.state === 'confirmed' ? 'bg-secondary text-secondary-foreground' : o.state === 'question' ? 'bg-warning/20 text-foreground' : o.state === 'duplicate' ? 'bg-muted text-muted-foreground' : 'bg-destructive/10 text-destructive'}`}>{o.state === 'confirmed' ? 'Read' : o.state === 'question' ? 'Question' : o.state === 'duplicate' ? 'Duplicate upload' : 'Failed'}</span>
              <span className="text-foreground">{o.name}</span>
              <span className="text-muted-foreground">· {o.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {pending.map((p) => {
        const interp = p.staged.interpretation;
        const built = buildImport({ caseId: caseId ?? 'pending', staged: p.staged, mappings: p.mappings, currency, revisionLabel: '', revision: nextRevision, rowOverrides: p.overrides });
        const rows: ParsedRow[] = built.imp.rows;
        const included = rows.filter((r) => r.included);
        const sheet = p.staged.workbook.sheets.find((s) => s.name === p.activeSheet);
        const mapping = p.mappings.find((m) => m.sheet === p.activeSheet);
        const notes = interp.sheets.flatMap((s) => (s.mapping.included ? s.validation.notes.map((n) => `${s.sheet}: ${n}`) : []));
        const noSheets = !p.mappings.some((m) => m.included);
        return (
          <div key={p.id} className="mt-4 space-y-3 rounded-md border border-warning/40 bg-warning/5 p-4">
            <p className="flex items-center gap-2 font-semibold text-foreground"><AlertTriangle size={16} className="text-warning" aria-hidden />{p.staged.workbook.fileName}</p>

            {interp.ambiguities.map((a) => {
              const chosen = p.mappings.find((m) => m.sheet === a.sheet)?.columns[a.field];
              const header = interp.sheets.find((s) => s.sheet === a.sheet)?.headerPreview;
              return (
                <fieldset key={`${p.id}-${a.sheet}-${a.field}`} className="rounded-md border border-border bg-card p-3">
                  <legend className="px-1 text-sm font-semibold text-foreground">{a.message}</legend>
                  {header ? (
                    <div className="mb-2 overflow-x-auto"><table className="text-sm"><tbody><tr>{header.cells.slice(0, 12).map((c, i) => <td key={`${p.id}-${a.sheet}-${c.address}`} className={`whitespace-nowrap border border-border px-2 py-1 ${a.candidates.some((x) => x.index === i) ? 'bg-warning/30 font-semibold text-foreground' : 'text-muted-foreground'}`} title={c.address}>{c.text || '·'}</td>)}</tr></tbody></table></div>
                  ) : null}
                  <div className="space-y-1">
                    {a.candidates.map((c) => (
                      <label key={`${a.sheet}-${a.field}-${c.index}`} className="flex cursor-pointer items-start gap-2 text-sm">
                        <input type="radio" name={`${p.id}-${a.sheet}-${a.field}`} checked={chosen === c.index} onChange={() => update(p.id, { mappings: applyAmbiguityChoice(p.mappings, a.sheet, a.field, c.index) })} className="mt-1 h-4 w-4 accent-[var(--accent)]" />
                        <span className="text-foreground">Column {c.letter}{c.header ? ` “${c.header}”` : ''}<span className="block text-xs text-muted-foreground">Values: {c.sample.join(', ') || 'none'}</span></span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              );
            })}

            {interp.ambiguities.length === 0 ? (
              <div className="text-sm text-foreground">
                {noSheets ? <p>No sheet looked like a priced bill, so nothing was read. Open the advanced editor to choose a sheet and header row.</p> : <p>The structure was read, but a check failed:</p>}
                {notes.length > 0 ? <ul className="mt-1 list-disc pl-5 text-muted-foreground">{notes.map((n, i) => <li key={`${p.id}-note-${i}-${n}`}>{n}</li>)}</ul> : null}
                {interp.sheets.filter((s) => !s.mapping.included).length > 0 ? <ul className="mt-1 list-disc pl-5 text-muted-foreground">{interp.sheets.filter((s) => !s.mapping.included).map((s) => <li key={`${p.id}-skip-${s.sheet}`}>{s.sheet}: {s.reason}</li>)}</ul> : null}
              </div>
            ) : null}

            <p className="text-sm text-muted-foreground tabular">Reading with the current choices: {included.filter((r) => r.rowClass === 'item').length} priced · {included.filter((r) => r.rowClass === 'unpriced_item').length} unpriced item(s).</p>

            <div className="flex flex-wrap items-center gap-3">
              <button type="button" disabled={busy || included.length === 0} onClick={() => void confirmPending(p)} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"><Check size={16} aria-hidden />Use this reading</button>
              <button type="button" onClick={() => update(p.id, { advanced: !p.advanced })} aria-expanded={p.advanced} className="text-sm text-accent hover:underline">{p.advanced ? 'Hide advanced mapping' : 'Advanced: edit the column mapping'}</button>
              <button type="button" onClick={() => discard(p)} className="text-sm text-muted-foreground hover:underline">Discard this file</button>
            </div>

            {p.advanced ? (
              <div className="rounded-md border border-border bg-card p-3">
                <p className="text-sm font-semibold text-foreground">Advanced mapping (optional correction)</p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {p.staged.workbook.sheets.map((s) => {
                    const m = p.mappings.find((x) => x.sheet === s.name);
                    return (
                      <li key={`${p.id}-sheet-${s.name}`} className={`flex items-center gap-2 rounded-md border px-3 py-1.5 ${p.activeSheet === s.name ? 'border-accent bg-accent/5' : 'border-border bg-card'}`}>
                        <input id={`${p.id}-sheet-${s.name}`} type="checkbox" checked={!!m?.included} onChange={(e) => update(p.id, { mappings: p.mappings.map((x) => (x.sheet === s.name ? { ...x, included: e.target.checked } : x)) })} className="h-4 w-4 accent-[var(--accent)]" />
                        <label htmlFor={`${p.id}-sheet-${s.name}`} className="cursor-pointer text-foreground">{s.name}</label>
                        <button type="button" onClick={() => update(p.id, { activeSheet: s.name })} className="text-sm text-accent hover:underline">Map columns</button>
                      </li>
                    );
                  })}
                </ul>
                {sheet && mapping ? (
                  <div className="mt-3">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <div>
                        <label htmlFor={`${p.id}-hr`} className="text-sm text-muted-foreground">Header row number</label>
                        <input id={`${p.id}-hr`} type="number" min={0} value={mapping.headerRow ?? 0} onChange={(e) => update(p.id, { mappings: p.mappings.map((x) => (x.sheet === sheet.name ? { ...x, headerRow: Number(e.target.value) > 0 ? Number(e.target.value) : null } : x)) })} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground" />
                      </div>
                      {MAPPED_FIELDS.map((f: MappedField) => (
                        <div key={`${p.id}-field-${f}`}>
                          <label htmlFor={`${p.id}-map-${f}`} className="text-sm text-muted-foreground">{FIELD_LABEL[f]}</label>
                          <select id={`${p.id}-map-${f}`} value={mapping.columns[f] ?? ''} onChange={(e) => update(p.id, { mappings: p.mappings.map((x) => (x.sheet === sheet.name ? { ...x, columns: { ...x.columns, [f]: e.target.value === '' ? null : Number(e.target.value) } } : x)) })} className="mt-0.5 w-full rounded-md border border-input bg-card px-2 py-1.5 text-foreground">
                            <option value="">Not mapped</option>
                            {Array.from({ length: sheet.columnCount }, (_, i) => {
                              const hc = sheet.rows.find((r) => r.rowNumber === mapping.headerRow)?.cells[i];
                              const letter = (hc?.address ?? '').replace(/\d+/g, '') || String.fromCharCode(65 + i);
                              return <option key={`${p.id}-${f}-col-${i}`} value={i}>{letter}{hc && hc.text ? ` · ${hc.text.slice(0, 24)}` : ''}</option>;
                            })}
                          </select>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 overflow-x-auto rounded-md border border-border">
                      <table className="w-full text-sm"><caption className="sr-only">First rows of the sheet</caption><tbody>
                        {sheet.rows.slice(0, 8).map((r) => (
                          <tr key={`${p.id}-${sheet.name}-r${r.rowNumber}`} className="border-b border-border last:border-b-0"><th scope="row" className="w-12 bg-muted px-2 py-1 text-right font-data text-muted-foreground">{r.rowNumber}</th>{r.cells.slice(0, 8).map((c) => <td key={`${p.id}-${sheet.name}-${c.address}`} className="whitespace-nowrap px-2 py-1 text-foreground" title={c.address}>{c.text || <span className="text-muted-foreground">·</span>}</td>)}</tr>
                        ))}
                      </tbody></table>
                    </div>
                  </div>
                ) : null}
                <div className="mt-3 flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-foreground">Parsed rows</h4>
                  <label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />Show non-item rows</label>
                </div>
                <div className="mt-1 max-h-[320px] overflow-auto rounded-md border border-border">
                  <table className="w-full min-w-[700px] text-sm">
                    <thead className="sticky top-0 bg-muted text-left text-muted-foreground"><tr><th className="px-2 py-2">Use</th><th className="px-2 py-2">Source</th><th className="px-2 py-2">Type</th><th className="px-2 py-2">Ref</th><th className="px-2 py-2">Description</th><th className="px-2 py-2">Unit</th><th className="px-2 py-2 text-right">Rate</th></tr></thead>
                    <tbody>
                      {(showAll ? rows : rows.filter((r) => r.rowClass === 'item' || r.rowClass === 'unpriced_item')).map((r) => (
                        <tr key={`${p.id}-${r.id}`} className="border-t border-border align-top">
                          <td className="px-2 py-1.5"><input type="checkbox" aria-label={`Use row ${r.rowNumber}`} checked={r.included} onChange={(e) => update(p.id, { overrides: { ...p.overrides, [r.id]: e.target.checked } })} className="h-4 w-4 accent-[var(--accent)]" /></td>
                          <td className="whitespace-nowrap px-2 py-1.5 font-data text-muted-foreground">{r.sheet}!{r.rowNumber}</td>
                          <td className="px-2 py-1.5"><span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ${CLASS_TONE[r.rowClass]}`}>{CLASS_LABEL[r.rowClass]}</span></td>
                          <td className="px-2 py-1.5 font-data text-foreground">{r.ref}</td>
                          <td className="px-2 py-1.5 text-foreground">{r.description}</td>
                          <td className="px-2 py-1.5 text-foreground">{r.unit}</td>
                          <td className="px-2 py-1.5 text-right tabular text-foreground">{r.rate.state === 'value' ? r.rate.value : r.rate.state === 'missing' ? <span className="text-warning">No rate</span> : <span className="text-destructive">Invalid</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}

      <p className="mt-3 text-sm text-muted-foreground">Each confirmed file is stored privately with its hash and revision. Different bills are included together; a changed version of one bill only competes with that bill’s other revisions. Missing rates stay unpriced, never zero.</p>
    </section>
  );
}

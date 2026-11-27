# PVR file reading and validation

## Reader boundaries

- Native DXF can support measurement if original and revised drawings are aligned, measurement units are established and relevant model-space geometry is complete. Keep unread geometry and unresolved model references as explicit holds. Plot or detail sheets are not proof of installed extents.
- DWG needs a configured converter. Validate version support, unit and transform fidelity, object coverage and references against a matching CAD export before accepting quantities. Do not silently substitute the sum of whatever geometry the converter happens to read.
- A searchable PDF supplies text evidence. A scan needs the OCR rasterizer and English language data. OCR confidence is a review aid and never authorizes a geometric takeoff. Preserve native text when scan extraction fails.
- XER can be read and compared without running Primavera. Do not report stored date differences as calculated PVR delay. Compare data dates, progress, calendars, relationship lags and scheduler options before attempting a like-for-like assessment. A P6-compatible run must first reproduce the unchanged baseline and then rerun with documented scope, durations and ties.
- Contract BOQ rates take precedence. Processed PVR quantities and schedules are held out of calculation. The only fallback from a processed PVR is a cited comparable unit rate when no applicable BOQ rate is available.

## Deployment checks

The worker image installs Poppler and the English Tesseract model. In-process PDF scan OCR needs `pdftoppm` on PATH (or `PDF_RASTERIZER_PATH`) and the packaged `eng.traineddata` (or an explicit `OCR_LANG_PATH`). If the web runtime cannot install Poppler, configure the worker and test a synthetic scanned drawing through the app before any real use. A successful health check or environment variable alone is not a file-processing acceptance test.

Use a synthetic DXF pair with known differences, a DWG plus an independently issued matching DXF for converter validation, a text PDF, a scanned and a mixed PDF, a BOQ with an explicit zero and missing rate, and an XER set with an independently checked time-impact result. Record build/runtime version, input hashes and measured vs expected results. Keep original project files and outputs in the authorised private workspace; no project documents belong in public repository fixtures.

## Evaluation and reviewed examples

Keep benchmark quantities, rates and P6 outputs in a separate reference partition. Run the tool against source files first, save the output, and then compare quantity by scope/unit; applied unit rate with source; activity and tie coverage; and recalculated finish only where the unchanged programme reproduced. Report unverified coverage separately from accuracy. Report per-reader failures as well as scores.

Use reviewed examples only in a separate learning partition with a named reviewer and independent scope and source checks. A held-out case is not a training example. Parser and prompt improvements and passing synthetic tests are not a model fine-tune or proof of live accuracy.

## Drawing performance without a faster-but-weaker answer

- Normal intake no longer builds live viewer batches that nobody is subscribed to. In the drawing panel, turn **Animate geometry while processing** off for a large file. The selected valid pair still opens in the full viewer when completed, and the takeoff and evidence gates do not change. Comparison viewer models are built only for the selected pair.
- Repeat runs in a case reuse successful reads for the same in-memory file bytes and name. Replacing the file, switching cases or failing/partially reading a document does not produce a stale result. The comparison, quantity gates and evidence reconciliation are recalculated on every run.
- Unchanged entities still match by the same full geometry signature. Relocation candidates are now found by an indexed range query using the same size predicate, original order and count. Ambiguity and evidence requirements are unchanged.
- To reproduce a speed test, run once on a cold pair and again without changing the inputs. Compare all measured quantities, source handles, ambiguity flags and limitations. Separate upload/storage time, native CAD conversion or OCR, geometry comparison and viewer rendering when timing. A synthetic stress test isolates comparison; it does not measure end-to-end hosted processing.

### Reopening drawing-to-BOQ matches

When a signed-in user runs BOQ analysis in a saved case, the workspace keeps a bounded, display-only preview of the primary matches with measured drawing quantities. Reopen the case in a second tab to confirm that the previews, quantity sources and BOQ references are visible without rerunning the model. A changed or unverifiable drawing set or BOQ revision is labelled historical. The snapshot does not restore the editable agent run, live drawing animation, a confirmed assessment, or a formal cost or time impact. No database migration is needed for this preview; it uses the existing owned case evidence record.

For smaller validated drawing pairs, the case also stores a display-only comparison so the saved case can replay the drawing layers without reparsing the CAD files or calling the model. **Replay completed processing** supports 1×, 2×, 5×, 10×, 20× and 40×, plus pause, replay again and skip. The app checks the saved case's active drawing identities before showing the replay. Replays are bounded; oversized drawings still get the normal quantity analysis and can be replayed in the original completed intake session. Older results saved before this feature cannot replay unless their comparison is run and saved once using the updated app.

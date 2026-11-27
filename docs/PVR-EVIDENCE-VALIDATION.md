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

import { checkLeakage } from './lifecycle';
import { EVAL_STAGES, type Discrepancy, type EvalStage, type EvaluationRun, type PipelineOutput, type ReferenceCase, type StageResult } from './types';

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const QTY_TOLERANCE = 0.005;

function stage(stage: EvalStage, compared: number, matched: number, note: string): StageResult {
  // A rate exists only when something was actually compared.
  return { stage, compared, matched, rate: compared > 0 ? matched / compared : null, note: compared === 0 ? `Nothing to compare. ${note}`.trim() : note };
}

/**
 * Compare REAL pipeline output with the reviewed expected record, stage by stage. This function never produces
 * the "actual" side. If a case has no pipeline output it is skipped and listed; no score is invented for it.
 * Only evaluation-partition cases are scored, and the learning/evaluation partitions must be leak-free.
 */
export function runEvaluation(cases: ReferenceCase[], outputs: PipelineOutput[], actualSource: string, now: string, id: string): EvaluationRun {
  const leakage = checkLeakage(cases);
  const evalCases = cases.filter((c) => c.partition === 'evaluation' && c.status !== 'retired');
  const skipped: EvaluationRun['skipped'] = [];
  const disc: Discrepancy[] = [];
  const acc: Record<EvalStage, { c: number; m: number }> = Object.fromEntries(EVAL_STAGES.map((s) => [s.key, { c: 0, m: 0 }])) as Record<EvalStage, { c: number; m: number }>;
  const ran: string[] = [];

  if (!leakage.ok) {
    return { id, runAt: now, caseIds: [], skipped: evalCases.map((c) => ({ caseId: c.id, reason: 'Evaluation blocked: learning and evaluation sets overlap.' })), stages: EVAL_STAGES.map((s) => stage(s.key, 0, 0, 'Blocked by leakage check.')), discrepancies: [], actualSource, leakage };
  }

  for (const c of evalCases) {
    const out = outputs.find((o) => o.caseId === c.id);
    if (!out) { skipped.push({ caseId: c.id, reason: 'No pipeline output was supplied for this case. The full pipeline has not been run on it.' }); continue; }
    ran.push(c.id);
    const r = c.record;

    // Document coverage: every uploaded source should be reported as read.
    for (const s of c.sources) {
      acc.documentCoverage.c += 1;
      if (out.documentsRead.some((d) => norm(d) === norm(s.fileName))) acc.documentCoverage.m += 1;
      else disc.push({ stage: 'documentCoverage', caseId: c.id, field: s.fileName, expected: 'read', actual: 'not read' });
    }
    // Change detection: the reviewed change type / work type should be detected.
    for (const exp of [r.changeType, r.workType].filter(Boolean)) {
      acc.changeDetection.c += 1;
      if (out.changesDetected.some((d) => norm(d).includes(norm(exp)) || norm(exp).includes(norm(d)))) acc.changeDetection.m += 1;
      else disc.push({ stage: 'changeDetection', caseId: c.id, field: 'change', expected: exp, actual: out.changesDetected.join('; ') || 'none detected' });
    }
    // Quantity accuracy: revised quantity within tolerance, same unit.
    for (const q of r.quantities.filter((x) => x.revised !== null)) {
      acc.quantityAccuracy.c += 1;
      const a = out.quantities.find((x) => norm(x.item) === norm(q.item));
      const ok = !!a && a.unit.toLowerCase() === q.unit.toLowerCase() && Math.abs(a.value - (q.revised as number)) <= Math.abs(q.revised as number) * QTY_TOLERANCE;
      if (ok) acc.quantityAccuracy.m += 1;
      else disc.push({ stage: 'quantityAccuracy', caseId: c.id, field: q.item, expected: `${q.revised} ${q.unit}`, actual: a ? `${a.value} ${a.unit}` : 'not measured' });
    }
    // BOQ mapping and valuation: same BOQ reference and rate.
    for (const m of r.boqMappings) {
      acc.boqMapping.c += 1;
      const a = out.boqMappings.find((x) => norm(x.item) === norm(m.item));
      const ok = !!a && norm(a.boqRef) === norm(m.boqRef) && (m.rate === null || a.rate === m.rate);
      if (ok) acc.boqMapping.m += 1;
      else disc.push({ stage: 'boqMapping', caseId: c.id, field: m.item, expected: `${m.boqRef} @ ${m.rate ?? 'n/a'}`, actual: a ? `${a.boqRef} @ ${a.rate ?? 'n/a'}` : 'not mapped' });
    }
    // Activity mapping.
    for (const m of r.activityMappings) {
      acc.activityMapping.c += 1;
      if (out.activityIds.includes(m.activityId)) acc.activityMapping.m += 1;
      else disc.push({ stage: 'activityMapping', caseId: c.id, field: m.activityId, expected: m.name, actual: 'not mapped' });
    }
    // Programme impact: compared against the reviewed SIMULATED figure, never the observed actual.
    if (r.schedule.simulatedDelayDays !== null) {
      acc.programmeImpact.c += 1;
      if (out.simulatedDelayDays === r.schedule.simulatedDelayDays) acc.programmeImpact.m += 1;
      else disc.push({ stage: 'programmeImpact', caseId: c.id, field: 'simulated delay (days)', expected: String(r.schedule.simulatedDelayDays), actual: out.simulatedDelayDays === null ? 'not simulated' : String(out.simulatedDelayDays) });
    }
    // Evidence and exceptions: each reviewer correction topic or missing-evidence item should be flagged.
    for (const gap of c.missingEvidence) {
      acc.evidenceQuality.c += 1;
      if (out.exceptionsFlagged.some((e) => norm(e).includes(norm(gap).slice(0, 12)))) acc.evidenceQuality.m += 1;
      else disc.push({ stage: 'evidenceQuality', caseId: c.id, field: gap, expected: 'flagged as missing', actual: 'not flagged' });
    }
  }

  return {
    id, runAt: now, caseIds: ran, skipped, actualSource, leakage,
    stages: EVAL_STAGES.map((s) => stage(s.key, acc[s.key].c, acc[s.key].m, '')),
    discrepancies: disc,
  };
}

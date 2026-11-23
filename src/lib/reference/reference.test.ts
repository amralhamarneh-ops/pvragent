import { describe, expect, it } from 'vitest';
import { DEMO_CASES, DEMO_QUERY_SUITABLE } from './demo';
import { retrieveReferences, precedentPromptBlock, validateCitations, NOT_REPLACED } from './retrieve';
import { canTransition, checkLeakage, missingEvidence, transition, withdraw, isRetrievable, partitionMoveBlock } from './lifecycle';
import { runEvaluation } from './evaluate';
import type { PipelineOutput, ReferenceCase } from './types';

const clone = (): ReferenceCase[] => JSON.parse(JSON.stringify(DEMO_CASES)) as ReferenceCase[];
const NOW = '2026-02-01T00:00:00.000Z';

describe('retrieval', () => {
  it('retrieves and cites the approved slab case; rejects the unsuitable pipe precedent', () => {
    const r = retrieveReferences(clone(), DEMO_QUERY_SUITABLE, { includeIneligible: true });
    expect(r.used.map((u) => u.referenceId)).toEqual(['ref-demo-slab-001']);
    expect(r.used[0].citations.length).toBeGreaterThan(0);
    const pipe = r.rejected.find((x) => x.referenceId === 'ref-demo-pipe-001');
    expect(pipe?.decision).toBe('rejected');
    expect(pipe?.reason).toMatch(/mismatch/i);
  });
  it('never uses draft, retired or evaluation cases', () => {
    const r = retrieveReferences(clone(), DEMO_QUERY_SUITABLE, { includeIneligible: true });
    const ids = r.used.map((u) => u.referenceId);
    expect(ids).not.toContain('ref-demo-draft-001');
    expect(ids).not.toContain('ref-demo-eval-001');
  });
  it('says so when nothing suitable exists', () => {
    const r = retrieveReferences(clone(), { ...DEMO_QUERY_SUITABLE, workType: 'curtain wall glazing', unit: 'm2', changeType: 'addition' });
    expect(r.noSuitableReference).toBe(true);
    expect(r.statement).toMatch(/No suitable approved reference/);
    expect(precedentPromptBlock(r)).toMatch(/Do not invent/);
  });
  it('prompt block forbids replacing current inputs and carries no rates', () => {
    const block = precedentPromptBlock(retrieveReferences(clone(), DEMO_QUERY_SUITABLE));
    NOT_REPLACED.forEach((n) => expect(block).toContain(n));
    expect(block).not.toMatch(/\b612\b/);
    expect(block).toMatch(/\[R1\]/);
  });
  it('drops citations that were not retrieved', () => {
    const r = retrieveReferences(clone(), DEMO_QUERY_SUITABLE);
    expect(validateCitations(['R1', 'R9'], r)).toEqual({ valid: ['R1'], invalid: ['R9'] });
  });
});

describe('lifecycle', () => {
  it('follows Draft > Under review > Approved > Retired only', () => {
    expect(canTransition('draft', 'approved')).toBe(false);
    expect(canTransition('retired', 'approved')).toBe(false);
    expect(canTransition('approved', 'retired')).toBe(true);
  });
  it('approval needs reviewer, reason and evidence; reviewed history is kept', () => {
    const d = clone().find((c) => c.id === 'ref-demo-draft-001') as ReferenceCase;
    const sub = transition(d, { to: 'under_review', reviewer: 'R', note: 'ready', evidence: [], at: NOW });
    expect(sub.ok).toBe(true);
    const bad = transition(sub.next as ReferenceCase, { to: 'approved', reviewer: 'R', note: 'ok', evidence: [], at: NOW });
    expect(bad.ok).toBe(false);
    const good = transition(sub.next as ReferenceCase, { to: 'approved', reviewer: 'R', note: 'ok', evidence: ['s1'], at: NOW });
    expect(good.ok).toBe(true);
    expect(good.next?.reviewHistory.at(-1)).toMatchObject({ action: 'approved', reviewer: 'R', version: 1 });
  });
  it('withdrawn precedent stops being retrievable and can link a replacement', () => {
    const slab = clone().find((c) => c.id === 'ref-demo-slab-001') as ReferenceCase;
    const w = withdraw(slab, 'R', 'Quantity basis found wrong', NOW, 'ref-demo-slab-002');
    expect(w.ok).toBe(true);
    expect(isRetrievable(w.next as ReferenceCase)).toBe(false);
  });
  it('lists missing evidence for incomplete cases', () => {
    expect(missingEvidence([{ role: 'pvr_narrative' }])).toContain('BOQ not provided');
  });
});

describe('evaluation set', () => {
  it('detects leakage across partitions and blocks moves that cause it', () => {
    const all = clone();
    expect(checkLeakage(all).ok).toBe(true);
    all.push({ ...all[0], id: 'ref-demo-slab-002', version: 2, partition: 'evaluation' });
    expect(checkLeakage(all).ok).toBe(false);
    expect(partitionMoveBlock(clone(), 'ref-demo-slab-001', 'evaluation')).toBeNull();
  });
  it('invents no score without pipeline output', () => {
    const run = runEvaluation(clone(), [], 'none', NOW, 'e1');
    expect(run.caseIds).toEqual([]);
    expect(run.skipped[0].reason).toMatch(/not been run/);
    run.stages.forEach((s) => expect(s.rate).toBeNull());
  });
  it('scores each stage from real output and keeps discrepancies', () => {
    const out: PipelineOutput = { caseId: 'ref-demo-eval-001', documentsRead: ['PVR-044-narrative.docx', 'S-050-revB.dxf'], changesDetected: ['thickness increase'], quantities: [{ item: 'Basement slab concrete', unit: 'm3', value: 350 }], boqMappings: [{ item: 'Basement slab concrete', boqRef: '2.1.4', rate: 580 }], activityIds: [], simulatedDelayDays: 3, exceptionsFlagged: [] };
    const run = runEvaluation(clone(), [out], 'test fixture', NOW, 'e2');
    const by = Object.fromEntries(run.stages.map((s) => [s.stage, s]));
    expect(by.documentCoverage).toMatchObject({ compared: 3, matched: 2 });
    expect(by.quantityAccuracy.matched).toBe(0);
    expect(by.boqMapping.rate).toBe(1);
    expect(by.programmeImpact.rate).toBe(1);
    expect(run.discrepancies.some((d) => d.stage === 'quantityAccuracy')).toBe(true);
  });
});

describe('fine-tuning separation', () => {
  it('no case is ever marked used in fine-tuning', () => {
    clone().forEach((c) => expect(c.usedInFineTuning).toBe(false));
  });
});

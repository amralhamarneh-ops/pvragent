import { describe, expect, it } from 'vitest';
import { D, Dec, formatMoney } from './decimal';
import { calculateCost, checkUnits, detectOverlaps } from './costEngine';
import { computeBuildUp, DEFAULT_RATE_POLICY, syntheticRates, validateRate } from './rates';
import { computeDuration } from './productivity';
import { combineComponents, modelRemainingWork } from './workModel';
import { calculateCpm, CalendarIndex, findCycle, validateNetwork, type CpmNetwork } from './cpmEngine';
import {
  buildHandoff, compareScenarios, EmbeddedEngine, ExternalP6Engine, HandoffEngine, increaseRemaining, insertFragnet, reconcileImport, validateFragnet, validateUnchangedCopy,
} from './schedulingEngine';
import { DEFAULT_SETTINGS, freezeRun, isRunStale, syntheticFragnet, syntheticNetwork } from './fixtures';
import type { Adjustment, RateRecord, ScopeComponent } from './types';

const rates = syntheticRates();
const comp = (p: Partial<ScopeComponent> & { id: string }): ScopeComponent => ({ workKey: p.id, boqRef: p.id, description: p.id, kind: 'addition', quantity: '1', unit: 'm2', rateId: 'RT-01', changeIds: ['CH-1'], basis: 'derived', ...p });
const cost = (components: ScopeComponent[], adjustments: Adjustment[] = [], r: RateRecord[] = rates, settings = DEFAULT_SETTINGS) => calculateCost({ components, rates: r, adjustments, policy: DEFAULT_RATE_POLICY, settings });

describe('decimal arithmetic', () => {
  it('avoids binary float error', () => {
    expect(D('0.1').add('0.2').toString()).toBe('0.3');
    expect(D('1.005').round(2, 'half_up').toString()).toBe('1.01');
    expect(D('2.5').round(0, 'half_even').toString()).toBe('2');
    expect(D('3.5').round(0, 'half_even').toString()).toBe('4');
    expect(D('-1.005').round(2, 'half_up').toString()).toBe('-1.01');
  });
  it('preserves source precision and formats money', () => {
    expect(D('86.5000').mul('3').toString()).toBe('259.5');
    expect(formatMoney(D('1234567.8'), 'AED')).toBe('AED 1,234,567.80');
  });
});

describe('cost engine: additions, omissions, replacements', () => {
  it('net = additions − omissions + abortive, with hand-calculated totals', () => {
    const r = cost([
      comp({ id: 'A', kind: 'addition', quantity: '14000', unit: 'm2', rateId: 'RT-01' }),
      comp({ id: 'O', kind: 'omission', quantity: '300', unit: 'm2', rateId: 'RT-02' }),
      comp({ id: 'W', kind: 'abortive', quantity: '50', unit: 'm2', rateId: 'RT-02' }),
    ]);
    expect(r.additions).toBe('1211000'); // 14000 × 86.50
    expect(r.omissions).toBe('12360'); // 300 × 41.20
    expect(r.abortive).toBe('2060'); // 50 × 41.20
    expect(r.netAssessed).toBe('1200700'); // 1211000 − 12360 + 2060
    expect(r.isComplete).toBe(true);
  });
  it('shows a replacement as omitted + added with net effect', () => {
    const r = cost([
      comp({ id: 'R1', kind: 'omission', quantity: '5', unit: 'm2', rateId: 'RT-01', replacementGroup: 'wall', workKey: 'wall-old' }),
      comp({ id: 'R2', kind: 'addition', quantity: '5', unit: 'm2', rateId: 'RT-02', replacementGroup: 'wall', workKey: 'wall-new' }),
    ]);
    expect(r.replacements).toEqual([{ group: 'wall', omitted: '432.5', added: '206', net: '-226.5', complete: true }]);
    expect(r.netAssessed).toBe('-226.5');
  });
  it('holds out lines that charge the same work as addition and abortive', () => {
    const comps = [comp({ id: 'X1', kind: 'addition', workKey: 'k' }), comp({ id: 'X2', kind: 'abortive', workKey: 'k' })];
    expect(detectOverlaps(comps).size).toBe(2);
    const r = cost(comps);
    expect(r.netAssessed).toBe('0');
    expect(r.blockers.length).toBeGreaterThan(0);
    expect(r.isComplete).toBe(false);
  });
  it('flags a rate that bundles work also charged separately', () => {
    const comps = [comp({ id: 'P', bundledWorkKeys: ['tack-coat'], workKey: 'asphalt' }), comp({ id: 'T', workKey: 'tack-coat' })];
    expect(detectOverlaps(comps).get('T')?.[0]).toContain('already bundled');
  });
});

describe('units and dimensional inputs', () => {
  it('converts length units exactly and rejects m2 to m3', () => {
    expect(checkUnits('km', 'm').factor?.toString()).toBe('1000');
    expect(checkUnits('m2', 'm3').ok).toBe(false);
    expect(checkUnits('m2', 'm3').reason).toContain('thickness');
  });
  it('does not let a bare factor bridge different dimensions (demo engine)', () => {
    // Previously a factor plus a note made m2 -> m3 "ok". Dimensional derivations now belong to src/lib/boq/units.ts.
    expect(checkUnits('m2', 'm3', '0.2', '').ok).toBe(false);
    const withNote = checkUnits('m2', 'm3', '0.2', '200 mm binder thickness');
    expect(withNote.ok).toBe(false);
    expect(withNote.reason).toContain('cannot bridge dimensions');
    const r = cost([comp({ id: 'V', quantity: '100', unit: 'm2', rateId: 'RT-V', conversionFactor: '0.2', conversionNote: '200 mm thickness' })], [], [...rates, { ...rates[0], id: 'RT-V', unit: 'm3', value: '300' }]);
    expect(r.lines[0].amount).toBeNull();
    expect(r.unpricedLines).toHaveLength(1);
  });
  it('leaves a unit-mismatched line unpriced rather than zero', () => {
    const r = cost([comp({ id: 'M', unit: 'm3', rateId: 'RT-01' })]);
    expect(r.lines[0].amount).toBeNull();
    expect(r.unpricedLines).toHaveLength(1);
  });
});

describe('missing rates and partial valuation', () => {
  it('reports a priced subtotal plus unpriced scope, never a complete total', () => {
    const r = cost([comp({ id: 'P', quantity: '10', rateId: 'RT-01' }), comp({ id: 'N', rateId: null, description: 'New culvert extension' })]);
    expect(r.netAssessed).toBe('865');
    expect(r.isComplete).toBe(false);
    expect(r.unpricedLines[0].issues.join(' ')).toContain('No rate selected');
    expect(r.warnings.join(' ')).toContain('priced subtotal');
  });
  it('rejects a historical rate without comparability review', () => {
    const hist = rates.find((x) => x.source === 'historical_benchmark') as RateRecord;
    expect(validateRate(hist, DEFAULT_RATE_POLICY).ok).toBe(false);
    const r = cost([comp({ id: 'H', unit: 'nr', rateId: hist.id })]);
    expect(r.lines[0].amount).toBeNull();
    const reviewed = { ...hist, comparability: { specification: true, location: true, timing: true, note: 'Same spec, same island, 20 months earlier' } };
    expect(validateRate(reviewed, DEFAULT_RATE_POLICY).ok).toBe(true);
  });
  it('requires a currency conversion assumption for foreign rates', () => {
    const usd: RateRecord = { ...rates[0], id: 'RT-USD', currency: 'USD', value: '10' };
    expect(cost([comp({ id: 'F', quantity: '2', rateId: 'RT-USD' })], [], [usd]).lines[0].amount).toBeNull();
    const withFx = { ...usd, fxAssumption: { from: 'USD', to: 'AED', rate: '3.6725', date: '2026-10-01' } };
    expect(cost([comp({ id: 'F', quantity: '2', rateId: 'RT-USD' })], [], [withFx]).netAssessed).toBe('73.45');
  });
  it('builds a first-principles rate with waste and explicit mark-ups only', () => {
    const b = computeBuildUp([
      { id: '1', component: 'materials', description: 'Asphalt', quantity: '2', unit: 't', unitCost: '100', wastePct: '5' },
      { id: '2', component: 'labour', description: 'Gang', quantity: '4', unit: 'h', unitCost: '25', wastePct: '0' },
    ], { overheadsPct: '10', profitPct: '5' }, '10');
    expect(b.subtotal.toString()).toBe('310'); // 210 + 100
    expect(b.overheads.toString()).toBe('31');
    expect(b.profit.toString()).toBe('17.05');
    expect(b.unitRate.toString()).toBe('35.805');
    expect(computeBuildUp([{ id: '1', component: 'labour', description: 'x', quantity: '1', unit: 'h', unitCost: '10', wastePct: '0' }], undefined, '1').unitRate.toString()).toBe('10');
  });
});

describe('adjustments and tax are explicit', () => {
  const adj = (p: Partial<Adjustment>): Adjustment => ({ id: 'ADJ', label: 'Overheads', type: 'overheads', mode: 'percent_of_base', value: '10', evidence: '', justification: '', enabled: true, approval: 'proposed', ...p });
  it('does not apply overheads or tax automatically', () => {
    const r = cost([comp({ id: 'A', quantity: '100' })]);
    expect(r.adjustmentsTotal).toBe('0');
    expect(r.tax).toBeNull();
  });
  it('ignores an enabled adjustment that has no evidence', () => {
    const r = cost([comp({ id: 'A', quantity: '100' })], [adj({})]);
    expect(r.adjustmentsTotal).toBe('0');
    expect(r.warnings.join(' ')).toContain('no evidence');
  });
  it('applies a justified adjustment and keeps tax separate', () => {
    const r = cost([comp({ id: 'A', quantity: '100' })], [adj({ evidence: 'Cl 14.2', justification: 'Contract allows 10%' })], rates, { ...DEFAULT_SETTINGS, taxRatePct: '5' });
    expect(r.netAssessed).toBe('9515'); // 8650 + 865
    expect(r.tax?.amount).toBe('475.75');
    expect(r.tax?.grossIncludingTax).toBe('9990.75');
  });
  it('separates proposed, assessed and approved values', () => {
    const r = cost([comp({ id: 'A', quantity: '10', rateId: 'RT-01' })]);
    expect(r.approvalSummary.approved).toBe('865');
    expect(r.approvalSummary.proposed).toBe('0');
  });
});

describe('productivity is not elapsed time', () => {
  const base = { quantity: '100', unit: 'm2', source: 'Synthetic test', calendarId: 'CAL5' };
  it('labour-hours: 100 m2 × 10 h/m2 at 10 people × 8 h = 12.5 working days', () => {
    const r = computeDuration({ ...base, basis: 'labour_hours_per_unit', hoursPerUnit: '10', resourceCount: '10', effectiveHoursPerResourcePerDay: '8', roundingMode: 'none' });
    expect(r.requiredHours).toBe('1000');
    expect(r.capacityPerDay).toBe('80');
    expect(r.workingDays).toBe('12.5');
    expect(computeDuration({ ...base, basis: 'labour_hours_per_unit', hoursPerUnit: '10', resourceCount: '10', effectiveHoursPerResourcePerDay: '8', roundingMode: 'up' }).roundedWorkingDays).toBe(13);
  });
  it('crew output: 14,000 m2 at 700 m2/day = 20 days', () => {
    const r = computeDuration({ ...base, quantity: '14000', basis: 'crew_output', outputPerDay: '700' });
    expect(r.workingDays).toBe('20');
  });
  it('refuses to guess missing capacity or calendar', () => {
    const r = computeDuration({ ...base, calendarId: '', basis: 'labour_hours_per_unit', hoursPerUnit: '10' });
    expect(r.ok).toBe(false);
    expect(r.workingDays).toBeNull();
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
  it('requires justification for planner duration', () => {
    expect(computeDuration({ ...base, basis: 'planner_duration', plannerDurationDays: '10' }).ok).toBe(false);
    expect(computeDuration({ ...base, basis: 'planner_duration', plannerDurationDays: '10', plannerJustification: 'Similar to Zone A' }).roundedWorkingDays).toBe(10);
  });
});

describe('work modelling', () => {
  const w = { activityId: 'C4060', unit: 'm2', originalPlanned: '35000', actualCompleted: '14000', remainingBefore: '21000', added: '14000', omitted: '0', progressBasis: 'measured' as const };
  it('adds scope only to remaining work', () => {
    expect(modelRemainingWork(w).remainingAfter).toBe('35000');
  });
  it('blocks omission of executed work', () => {
    const r = modelRemainingWork({ ...w, added: '0', omitted: '25000' });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('already executed');
  });
  it('does not derive physical progress from percent complete', () => {
    expect(modelRemainingWork({ ...w, actualCompleted: null, progressBasis: 'none' }).ok).toBe(false);
  });
  it('requires a new activity for added scope on a completed activity', () => {
    const r = modelRemainingWork({ ...w, actualCompleted: '35000', remainingBefore: '0' });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('new activity');
  });
  it('does not blindly sum or max component durations', () => {
    const c = [{ id: '1', name: 'a', days: 10 }, { id: '2', name: 'b', days: 6 }];
    expect(combineComponents(c, null).ok).toBe(false);
    expect(combineComponents(c, 'sequential').days).toBe(16);
    expect(combineComponents(c, 'parallel').days).toBe(10);
    expect(combineComponents([{ id: '1', name: 'a', days: 10, resourceGroup: 'g' }, { id: '2', name: 'b', days: 6, resourceGroup: 'g' }], 'shared_resource').days).toBe(16);
  });
});

// ---------- CPM: hand-derived oracles (Mon-Fri, data date Mon 2026-10-12) ----------
const cal5 = { id: 'C', name: 'Mon-Fri', workDays: [1, 2, 3, 4, 5], holidays: [] as string[] };
const act = (id: string, dur: number, extra: Partial<CpmNetwork['activities'][number]> = {}) => ({ id, name: id, type: 'task' as const, calendarId: 'C', originalDuration: dur, remainingDuration: dur, ...extra });
const net = (activities: CpmNetwork['activities'], relationships: CpmNetwork['relationships'], extra: Partial<CpmNetwork> = {}): CpmNetwork => ({
  activities, relationships, calendars: [cal5], dataDate: '2026-10-12', projectCalendarId: 'C', settings: { progressMode: 'retained_logic', resourceLevelling: false, criticalDefinition: 'total_float_lte_zero' }, ...extra,
});

describe('CPM relationship types, lags and calendars', () => {
  it('FS: 5d then 3d', () => {
    const r = calculateCpm(net([act('A', 5), act('B', 3)], [{ from: 'A', to: 'B', type: 'FS', lag: 0 }]));
    expect(r.activities.A.earlyFinish).toBe('2026-10-16');
    expect(r.activities.B.earlyStart).toBe('2026-10-19');
    expect(r.activities.B.earlyFinish).toBe('2026-10-21');
    expect(r.projectFinish).toBe('2026-10-21');
    expect(r.activities.A.critical && r.activities.B.critical).toBe(true);
  });
  it('SS with lag 2', () => {
    const r = calculateCpm(net([act('A', 5), act('B', 2)], [{ from: 'A', to: 'B', type: 'SS', lag: 2 }]));
    expect(r.activities.B.earlyStart).toBe('2026-10-14');
    expect(r.activities.B.earlyFinish).toBe('2026-10-15');
    expect(r.activities.B.totalFloat).toBe(1); // project finish Fri 16 Oct
  });
  it('FF with lag 0 pulls the successor finish to the predecessor finish', () => {
    const r = calculateCpm(net([act('A', 5), act('C', 2)], [{ from: 'A', to: 'C', type: 'FF', lag: 0 }]));
    expect(r.activities.C.earlyFinish).toBe('2026-10-16');
    expect(r.activities.C.earlyStart).toBe('2026-10-15');
  });
  it('negative lag on FS overlaps work', () => {
    const r = calculateCpm(net([act('A', 5), act('B', 2)], [{ from: 'A', to: 'B', type: 'FS', lag: -1 }]));
    expect(r.activities.B.earlyStart).toBe('2026-10-16');
  });
  it('skips nonworking holidays', () => {
    const c = { ...cal5, holidays: ['2026-12-02', '2026-12-03'] };
    const r = calculateCpm(net([act('A', 5)], [], { calendars: [c], dataDate: '2026-11-30' }));
    expect(r.activities.A.earlyFinish).toBe('2026-12-08');
  });
  it('uses each activity calendar', () => {
    const six = { id: 'S', name: 'Mon-Sat', workDays: [1, 2, 3, 4, 5, 6], holidays: [] as string[] };
    const r = calculateCpm(net([act('A', 6, { calendarId: 'S' })], [], { calendars: [cal5, six] }));
    expect(r.activities.A.earlyFinish).toBe('2026-10-17'); // Mon..Sat
  });
  it('calendar index counts working days', () => {
    const idx = new CalendarIndex(cal5);
    expect(idx.workDiff('2026-10-12', '2026-10-19')).toBe(5);
    expect(idx.shift('2026-10-16', 1)).toBe('2026-10-19');
  });
});

describe('CPM float, parallel paths and noncritical changes', () => {
  const parallel = () => net([act('S', 1), act('LONG', 10), act('SHORT', 4), act('E', 1)], [
    { from: 'S', to: 'LONG', type: 'FS', lag: 0 }, { from: 'S', to: 'SHORT', type: 'FS', lag: 0 }, { from: 'LONG', to: 'E', type: 'FS', lag: 0 }, { from: 'SHORT', to: 'E', type: 'FS', lag: 0 },
  ]);
  it('computes total float on the short path', () => {
    const r = calculateCpm(parallel());
    expect(r.activities.LONG.totalFloat).toBe(0);
    expect(r.activities.SHORT.totalFloat).toBe(6);
    expect(r.criticalPath).toEqual(expect.arrayContaining(['S', 'LONG', 'E']));
    expect(r.activities.SHORT.critical).toBe(false);
  });
  it('noncritical change within float does not move completion, but a full recalculation proves it', () => {
    const before = calculateCpm(parallel());
    const n2 = increaseRemaining(parallel(), 'SHORT', 5).network;
    const after = calculateCpm(n2);
    expect(after.projectFinish).toBe(before.projectFinish);
    expect(after.activities.SHORT.totalFloat).toBe(1);
  });
  it('a change beyond float moves completion by the excess', () => {
    const before = calculateCpm(parallel());
    const after = calculateCpm(increaseRemaining(parallel(), 'SHORT', 9).network); // 13d vs 10d long path => +3
    expect(after.activities.SHORT.critical).toBe(true);
    const cmp = compareScenarios(parallel(), before, increaseRemaining(parallel(), 'SHORT', 9).network, after, ['SHORT'], ['E']);
    expect(cmp.workingDaysMoved).toBe(3);
    expect(cmp.newlyCritical).toContain('SHORT');
  });
  it('the 50-day example: absorbed by float vs moving completion', () => {
    const n = net([act('S', 1), act('MAIN', 100), act('SIDE', 30), act('E', 1)], [
      { from: 'S', to: 'MAIN', type: 'FS', lag: 0 }, { from: 'S', to: 'SIDE', type: 'FS', lag: 0 }, { from: 'MAIN', to: 'E', type: 'FS', lag: 0 }, { from: 'SIDE', to: 'E', type: 'FS', lag: 0 },
    ]);
    const base = calculateCpm(n);
    expect(base.activities.SIDE.totalFloat).toBe(70);
    const absorbed = calculateCpm(increaseRemaining(n, 'SIDE', 50).network);
    expect(absorbed.projectFinish).toBe(base.projectFinish);
    expect(absorbed.activities.SIDE.totalFloat).toBe(20);
    const moved = calculateCpm(increaseRemaining(n, 'MAIN', 50).network);
    expect(new CalendarIndex(cal5).workDiff(base.projectFinish as string, moved.projectFinish as string)).toBe(50);
  });
});

describe('constraints, milestones and progress', () => {
  it('SNET delays a start', () => {
    const r = calculateCpm(net([act('A', 2, { constraint: { type: 'SNET', date: '2026-10-20' } })], []));
    expect(r.activities.A.earlyStart).toBe('2026-10-20');
  });
  it('FNLT creates negative float when logic exceeds it', () => {
    const r = calculateCpm(net([act('A', 5, { constraint: { type: 'FNLT', date: '2026-10-14' } })], []));
    expect(r.activities.A.totalFloat).toBe(-2);
    expect(r.activities.A.critical).toBe(true);
  });
  it('MSO fixes the start date', () => {
    const r = calculateCpm(net([act('A', 2, { constraint: { type: 'MSO', date: '2026-10-22' } })], []));
    expect(r.activities.A.earlyStart).toBe('2026-10-22');
  });
  it('milestone has zero duration and sits at predecessor finish', () => {
    const r = calculateCpm(net([act('A', 3), act('M', 0, { type: 'milestone_finish' })], [{ from: 'A', to: 'M', type: 'FS', lag: 0 }]));
    expect(r.activities.M.earlyStart).toBe('2026-10-19');
    expect(r.activities.M.earlyFinish).toBe('2026-10-19');
  });
  it('in-progress work uses remaining duration from the data date; completed work keeps actuals', () => {
    const r = calculateCpm(net([act('D', 10, { remainingDuration: 0, actualStart: '2026-09-01', actualFinish: '2026-09-25' }), act('P', 10, { remainingDuration: 4, actualStart: '2026-10-05' }), act('N', 2)], [{ from: 'D', to: 'P', type: 'FS', lag: 0 }, { from: 'P', to: 'N', type: 'FS', lag: 0 }]));
    expect(r.activities.D.earlyFinish).toBe('2026-09-25');
    expect(r.activities.D.critical).toBe(false);
    expect(r.activities.P.earlyStart).toBe('2026-10-05');
    expect(r.activities.P.earlyFinish).toBe('2026-10-15'); // 4 remaining from Mon 12 Oct
    expect(r.activities.N.earlyStart).toBe('2026-10-16');
  });
  it('out-of-sequence progress: successor started before predecessor finished keeps its actual start (retained logic limits remaining work)', () => {
    const r = calculateCpm(net([act('A', 5), act('B', 6, { remainingDuration: 3, actualStart: '2026-10-08' })], [{ from: 'A', to: 'B', type: 'FS', lag: 0 }]));
    expect(r.activities.B.earlyStart).toBe('2026-10-08');
    expect(r.activities.B.earlyFinish).toBe('2026-10-21'); // retained logic: remaining work waits for A finish (16 Oct) then 3d => starts 19, finishes 21
  });
});

describe('cycle detection and missing external dependencies', () => {
  it('detects circular logic and refuses to calculate', () => {
    const n = net([act('A', 1), act('B', 1), act('C', 1)], [{ from: 'A', to: 'B', type: 'FS', lag: 0 }, { from: 'B', to: 'C', type: 'FS', lag: 0 }, { from: 'C', to: 'A', type: 'FS', lag: 0 }]);
    expect(findCycle(n)).not.toBeNull();
    const r = calculateCpm(n);
    expect(r.ok).toBe(false);
    expect(r.projectFinish).toBeNull();
    expect(r.issues.some((i) => i.code === 'CYCLE')).toBe(true);
  });
  it('flags a relationship to a missing external activity', () => {
    const v = validateNetwork(net([act('A', 1)], [{ from: 'EXT1', to: 'A', type: 'FS', lag: 0 }]));
    expect(v.hasErrors).toBe(true);
    expect(v.issues.find((i) => i.code === 'MISSING_EXTERNAL')?.message).toContain('boundary assumption');
  });
  it('reports open ends and always states the levelling limitation', () => {
    const v = validateNetwork(net([act('A', 1), act('B', 1)], [{ from: 'A', to: 'B', type: 'FS', lag: 0 }]));
    expect(v.issues.some((i) => i.code === 'OPEN_END' && i.activityId === 'B')).toBe(true);
    expect(v.issues.some((i) => i.code === 'NO_LEVELLING')).toBe(true);
  });
});

describe('unchanged schedule reproduction', () => {
  const n = syntheticNetwork();
  const res = calculateCpm(n);
  const source = Object.values(res.activities).map((a) => ({ id: a.id, start: a.earlyStart, finish: a.earlyFinish, totalFloat: a.totalFloat }));
  it('reproduces dates and float of its own output with zero mismatches', () => {
    const v = validateUnchangedCopy(n, source);
    expect(v.verdict).toBe('reproduced');
    expect(v.compared).toBe(n.activities.length);
    expect(v.mismatches).toHaveLength(0);
  });
  it('reports a mismatch and requires acceptance when source dates differ', () => {
    const tampered = source.map((s) => (s.id === 'C4090' ? { ...s, finish: '2026-12-01' } : s));
    const v = validateUnchangedCopy(n, tampered);
    expect(v.verdict).toBe('not_reproduced');
    expect(v.needsAcceptance).toBe(true);
    expect(v.milestoneMismatches[0].id).toBe('C4090');
    expect(validateUnchangedCopy(n, tampered, { dates: 400, float: 0 }).verdict).toBe('differences_within_tolerance');
  });
  it('lists required scheduling settings and does not assert P6 equivalence', () => {
    const v = validateUnchangedCopy(n, source);
    expect(v.requiredSettings.some((s) => s.key === 'Resource levelling' && !s.present)).toBe(true);
    expect(new EmbeddedEngine().info().capabilities.notes.join(' ')).toContain('Not asserted equal to P6');
  });
});

describe('fragnet insertion, validation and combined changes', () => {
  const base = syntheticNetwork();
  const un = calculateCpm(base);
  it('the unchanged fixture has no errors', () => {
    expect(un.ok).toBe(true);
    expect(un.projectFinish).not.toBeNull();
  });
  it('a valid fragnet recalculates the full network and moves completion', () => {
    const f = syntheticFragnet();
    const issues = validateFragnet(f, base).filter((i) => i.severity === 'error');
    expect(issues).toEqual([]);
    const imp = insertFragnet(base, f);
    const ir = calculateCpm(imp);
    const cmp = compareScenarios(base, un, imp, ir, [], ['C4090']);
    expect(cmp.sameBasis).toBe(true);
    expect(cmp.workingDaysMoved).toBeGreaterThanOrEqual(0);
    expect(cmp.milestones[0].id).toBe('C4090');
    expect(cmp.direct).toEqual(expect.arrayContaining(['N1000', 'N1010', 'N1020']));
  });
  it('rejects duplicate IDs, cycles and unconnected fragnets', () => {
    const f = syntheticFragnet();
    const dup = { ...f, activities: [...f.activities, { ...f.activities[0] }] };
    expect(validateFragnet(dup, base).some((i) => i.code === 'DUP_ID')).toBe(true);
    const cyc = { ...f, links: [...f.links, { from: 'N1020', to: 'N1000', type: 'FS' as const, lag: 0 }] };
    expect(validateFragnet(cyc, base).some((i) => i.code === 'CYCLE')).toBe(true);
    const floating = { ...f, links: f.links.filter((l) => l.from !== 'C4050') };
    expect(validateFragnet(floating, base).some((i) => i.code === 'NOT_CONNECTED_IN')).toBe(true);
    const hard = { ...f, activities: f.activities.map((a, i) => (i === 0 ? { ...a, constraint: { type: 'MSO' as const, date: '2026-12-01' } } : a)) };
    expect(validateFragnet(hard, base).some((i) => i.code === 'HARD_CONSTRAINT')).toBe(true);
  });
  it('requires an explicit basis for retrospective assessments', () => {
    const f = { ...syntheticFragnet(), assessmentMode: 'retrospective' as const };
    expect(validateFragnet(f, base).some((i) => i.code === 'RETRO_BASIS')).toBe(true);
    const ok = { ...f, retrospective: { updateId: 'UPD-2026-08', method: 'Time impact analysis', basis: 'Event occurred 20 Aug 2026' } };
    expect(validateFragnet(ok, base).some((i) => i.code === 'RETRO_BASIS')).toBe(false);
  });
  it('does not reopen completed activities', () => {
    expect(increaseRemaining(base, 'C4010', 5).error).toContain('not reopened');
  });
  it('combined changes are modelled together, not summed from standalone delays', () => {
    // Two changes on parallel paths that share float: standalone 8d each, together only the longer drives.
    const n = net([act('S', 1), act('MAIN', 20), act('P1', 10), act('P2', 10), act('E', 1)], [
      { from: 'S', to: 'MAIN', type: 'FS', lag: 0 }, { from: 'S', to: 'P1', type: 'FS', lag: 0 }, { from: 'S', to: 'P2', type: 'FS', lag: 0 },
      { from: 'MAIN', to: 'E', type: 'FS', lag: 0 }, { from: 'P1', to: 'E', type: 'FS', lag: 0 }, { from: 'P2', to: 'E', type: 'FS', lag: 0 },
    ]);
    const idx = new CalendarIndex(cal5);
    const b = calculateCpm(n);
    const d1 = idx.workDiff(b.projectFinish as string, calculateCpm(increaseRemaining(n, 'P1', 15).network).projectFinish as string);
    const d2 = idx.workDiff(b.projectFinish as string, calculateCpm(increaseRemaining(n, 'P2', 17).network).projectFinish as string);
    const both = increaseRemaining(increaseRemaining(n, 'P1', 15).network, 'P2', 17).network;
    const dBoth = idx.workDiff(b.projectFinish as string, calculateCpm(both).projectFinish as string);
    expect([d1, d2]).toEqual([5, 7]);
    expect(dBoth).toBe(7);
    expect(dBoth).not.toBe(d1 + d2);
  });
  it('recalculates after an upstream edit', () => {
    const before = calculateCpm(increaseRemaining(base, 'C4060', 5).network);
    const after = calculateCpm(increaseRemaining(base, 'C4060', 15).network);
    expect(after.activities.C4060.earlyFinish > before.activities.C4060.earlyFinish).toBe(true);
  });
});

describe('scheduling engines and handoff', () => {
  it('missing engine returns unavailable, not zero dates', async () => {
    const out = await new ExternalP6Engine(false).schedule({ caseId: 'c', scenarioId: 's', assessmentVersion: 1, network: syntheticNetwork() });
    expect(out.status).toBe('unavailable');
    expect('result' in out).toBe(false);
    expect(new ExternalP6Engine(true, false).info().available).toBe(false);
  });
  it('embedded engine refuses to return results for invalid logic', async () => {
    const bad = net([act('A', 1), act('B', 1)], [{ from: 'A', to: 'B', type: 'FS', lag: 0 }, { from: 'B', to: 'A', type: 'FS', lag: 0 }]);
    const out = await new EmbeddedEngine().schedule({ caseId: 'c', scenarioId: 's', assessmentVersion: 1, network: bad });
    expect(out.status).toBe('unavailable');
  });
  it('handoff exports, then reconciles a returned file against case, version and changes', async () => {
    const n = syntheticNetwork();
    const req = { caseId: 'PVR-0418', scenarioId: 'SC1', assessmentVersion: 2, network: n };
    const out = await new HandoffEngine().schedule(req);
    expect(out.status).toBe('awaiting_import');
    const pkg = buildHandoff(req, null, [], ['XER user fields not exported']);
    expect(pkg.handoffId).toBe('HO-PVR-0418-SC1-v2');
    expect(pkg.omittedFromExport).toContain('XER user fields not exported');
    const r = calculateCpm(n);
    const good = [pkg.handoffId, 'id,earlyStart,earlyFinish,lateStart,lateFinish,totalFloat', ...Object.values(r.activities).map((a) => [a.id, a.earlyStart, a.earlyFinish, a.lateStart, a.lateFinish, a.totalFloat].join(','))].join('\n');
    const ids = n.activities.map((a) => a.id);
    expect(reconcileImport(good, pkg, ids, false).report.ok).toBe(true);
    const wrongCase = good.replace(pkg.handoffId, 'HO-OTHER');
    expect(reconcileImport(wrongCase, pkg, ids, false).report.handoffMatches).toBe(false);
    const dropped = good.split('\n').filter((l) => !l.startsWith('C4130')).join('\n');
    expect(reconcileImport(dropped, pkg, ids, false).report.missingActivities).toEqual(['C4130']);
    const rewritten = good.replace(/^C4010,[^\n]*/m, 'C4010,2026-03-02,2026-07-20,2026-03-02,2026-07-20,0');
    expect(reconcileImport(rewritten, pkg, ids, false).report.changedHistory).toEqual(['C4010']);
    expect(reconcileImport(good, pkg, ids, null).report.ok).toBe(false);
  });
});

describe('frozen runs', () => {
  const args = { caseId: 'PVR-0418', assessmentVersion: 1, mappingVersion: 1, scheduleVersion: 'FIR_Oct26', dataDate: '2026-10-12', ratePolicyId: DEFAULT_RATE_POLICY.id, settings: DEFAULT_SETTINGS, assumptions: ['A'], components: [comp({ id: 'A' })], adjustments: [], network: syntheticNetwork(), scenarios: [], engineId: 'embedded' };
  it('hash is stable for identical inputs and changes with any input', () => {
    const a = freezeRun({ ...args, createdAt: 't' });
    expect(freezeRun({ ...args, createdAt: 't2' }).inputHash).toBe(a.inputHash);
    expect(isRunStale(a, args)).toBe(false);
    expect(isRunStale(a, { ...args, components: [comp({ id: 'A', quantity: '2' })] })).toBe(true);
    expect(a.engineVersion).toContain('embedded');
  });
});

describe('Dec class sanity', () => {
  it('rejects invalid input', () => {
    expect(() => Dec.of('abc')).toThrow();
    expect(() => D(1).div(0)).toThrow();
  });
});

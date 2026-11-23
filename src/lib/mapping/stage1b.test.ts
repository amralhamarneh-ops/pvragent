// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseXer } from './xerParser';
import { allocate, cannotReceiveExecution, mapAll, mapLine, phaseOf, type WorkLine } from './realActivityMapping';
import { itemFromDraft, previewDraft, validateDraft, EMPTY_DRAFT } from '../boq/newItem';
import { reconcileDecisions, stableLineId, type DecisionStore } from '../boq/resolutions';

const T = (rows: string[][], name: string, fields: string[]) => [`%T\t${name}`, `%F\t${fields.join('\t')}`, ...rows.map((r) => `%R\t${r.join('\t')}`)];

/** A small generic programme: completed excavation, open pavement, a handover milestone, with TASK codes != internal ids. */
function xerText(): string {
  return [
    'ERMHDR\t8.4',
    ...T([['1', '2026-10-01 08:00']], 'PROJECT', ['proj_id', 'last_recalc_date']),
    ...T([['100', '', 'Site'], ['101', '100', 'Roadworks'], ['102', '101', 'Earthworks']], 'PROJWBS', ['wbs_id', 'parent_wbs_id', 'wbs_name']),
    ...T([['c1', 'Std 10h', '10', '50'], ['c2', 'Std 8h', '8', '40']], 'CALENDAR', ['clndr_id', 'clndr_name', 'day_hr_cnt', 'week_hr_cnt']),
    ...T([
      ['9001', 'EXC-10', 'Bulk excavation', '102', 'TT_Task', 'TK_Complete', 'c1', '2026-01-05 08:00', '2026-02-05 17:00', '100', '300', '0', '2026-01-05', '2026-02-04', '100'],
      ['9002', 'PAV-20', 'Asphalt wearing course', '101', 'TT_Task', 'TK_Active', 'c2', '2026-08-03 08:00', '2026-11-18 17:00', '320', '160', '48', '2026-08-03', '', '38'],
      ['9003', 'HO-99', 'Practical completion handover', '100', 'TT_FinMile', 'TK_NotStart', 'c2', '2027-04-01 08:00', '2027-04-01 17:00', '0', '0', '0', '', '', '0'],
    ], 'TASK', ['task_id', 'task_code', 'task_name', 'wbs_id', 'task_type', 'status_code', 'clndr_id', 'target_start_date', 'target_end_date', 'target_drtn_hr_cnt', 'remain_drtn_hr_cnt', 'total_float_hr_cnt', 'act_start_date', 'act_end_date', 'phys_complete_pct']),
    ...T([['5', '9002', '9001', 'PR_FS', '16'], ['6', '9003', '9002', 'PR_FS', '0'], ['7', '9003', '1234', 'PR_FS', '0']], 'TASKPRED', ['task_pred_id', 'task_id', 'pred_task_id', 'pred_type', 'lag_hr_cnt']),
    '%E',
  ].join('\n');
}

describe('XER parser', () => {
  const m = parseXer(xerText(), 'prog.xer');

  it('keeps internal task ids and display codes separate and links relationships by internal id', () => {
    const exc = m.activities.find((a) => a.id === 'EXC-10');
    expect(exc?.taskId).toBe('9001');
    const rel = m.relationships.find((r) => r.fromTaskId === '9001' && r.toTaskId === '9002');
    expect(rel).toBeTruthy();
    expect(rel?.from).toBe('EXC-10');
    expect(rel?.to).toBe('PAV-20');
    expect(rel?.resolved).toBe(true);
  });

  it('reports a relationship to a missing task as unresolved, not as a link to an invented activity', () => {
    const bad = m.relationships.find((r) => r.fromTaskId === '1234');
    expect(bad?.resolved).toBe(false);
    expect(m.warnings?.some((w) => /unresolved/.test(w))).toBe(true);
  });

  it('does not assume eight-hour days: converts with each activity calendar and keeps source hours', () => {
    const exc = m.activities.find((a) => a.id === 'EXC-10')!;
    const pav = m.activities.find((a) => a.id === 'PAV-20')!;
    expect(exc.durationHours).toBe(100); expect(exc.duration).toBe(10);   // 100 h on a 10 h/day calendar
    expect(pav.durationHours).toBe(320); expect(pav.duration).toBe(40);   // 320 h on an 8 h/day calendar
    expect(m.relationships.find((r) => r.fromTaskId === '9001')?.lagHours).toBe(16);
  });

  it('leaves day values at 0 and warns when a calendar states no hours per day', () => {
    const noCal = parseXer(['%T\tTASK', '%F\ttask_id\ttask_code\ttask_name\ttarget_drtn_hr_cnt', '%R\t1\tA\tX\t80', '%E'].join('\n'));
    expect(noCal.activities[0].durationHours).toBe(80);
    expect(noCal.activities[0].duration).toBe(0);
    expect(noCal.warnings?.some((w) => /hours-per-day/.test(w))).toBe(true);
  });

  it('keeps the full WBS path, type, status, actuals and remaining duration', () => {
    const exc = m.activities.find((a) => a.id === 'EXC-10')!;
    expect(exc.wbs).toBe('Site / Roadworks / Earthworks');
    expect(exc.kind).toBe('task'); expect(exc.status).toBe('completed'); expect(exc.actualFinish).toBe('2026-02-04');
    const ho = m.activities.find((a) => a.id === 'HO-99')!;
    expect(ho.kind).toBe('milestone_finish');
    const pav = m.activities.find((a) => a.id === 'PAV-20')!;
    expect(pav.status).toBe('in_progress'); expect(pav.remainingDurationHours).toBe(160);
  });

  it('does not invent productivity when the file has none', () => {
    expect(m.productivityFields).toEqual([]);
  });
});

const line = (over: Partial<WorkLine>): WorkLine => ({ lineId: 'L1', componentId: 'c1', name: 'Excavation', description: 'Bulk excavation', specification: '', location: '', discipline: '', workType: 'excavation', searchTerms: ['excavation'], quantity: '8400', unit: 'm3', action: 'add', executes: true, ...over });

describe('Activity mapping validation', () => {
  const m = parseXer(xerText(), 'prog.xer');

  it('a construction quantity can never be mapped to a handover milestone', () => {
    const ho = m.activities.find((a) => a.id === 'HO-99')!;
    expect(cannotReceiveExecution({ kind: ho.kind! })).toMatch(/milestone/);
    const r = mapLine(line({}), m, { activityTaskIds: ['9003'] });
    expect(r.allocations.find((a) => a.activityCode === 'HO-99')).toBeUndefined();
    expect(r.state).toBe('needs_question');
  });

  it('completed work is not overwritten: new scope on it becomes a new-activity proposal', () => {
    const r = mapLine(line({}), m);
    expect(r.state).toBe('new_activity');
    expect(r.newActivity?.predecessors[0]?.code).toBe('EXC-10');
    expect(r.newActivity?.durationBasis).toBe('needs_productivity');
    expect(r.allocations).toHaveLength(0);
  });

  it('an open matching activity is proposed automatically with an explanation', () => {
    const r = mapLine(line({ lineId: 'L2', name: 'Asphalt wearing course', description: 'asphalt wearing course', workType: 'asphalt paving', searchTerms: ['asphalt', 'wearing'], unit: 'm2', quantity: '14000' }), m);
    expect(r.state).toBe('proposed');
    expect(r.allocations[0].activityCode).toBe('PAV-20');
    expect(r.explanation.length).toBeGreaterThan(10);
  });

  it('a milestone is shown downstream, not as a quantity target', () => {
    const r = mapLine(line({ lineId: 'L2', name: 'Asphalt wearing course', workType: 'asphalt', searchTerms: ['asphalt', 'wearing'], unit: 'm2' }), m);
    expect(r.downstream.some((d) => d.code === 'HO-99')).toBe(true);
    expect(r.allocations.some((a) => a.activityCode === 'HO-99')).toBe(false);
  });

  it('unmatched work asks a targeted question naming what is missing, and deferral does not trap', () => {
    const r = mapLine(line({ lineId: 'L3', name: 'Zinc roof flashing', workType: 'flashing', searchTerms: ['zinc'], unit: 'm', quantity: '10' }), m);
    expect(['needs_question', 'new_activity']).toContain(r.state);
    if (r.question) { expect(r.question.missing.length).toBeGreaterThan(5); expect(r.question.options.some((o) => o.id === 'defer')).toBe(true); }
    const d = mapLine(line({ lineId: 'L3' }), m, { state: 'deferred', reason: 'later' });
    expect(d.state).toBe('deferred');
  });

  it('allocations sum to the line quantity once, and duplicates are removed', () => {
    const a = allocate([
      { activityTaskId: 'a', activityCode: 'A', activityName: 'A', share: '0', quantity: null, basis: 'automatic' },
      { activityTaskId: 'b', activityCode: 'B', activityName: 'B', share: '0', quantity: null, basis: 'automatic' },
    ], '100', { a: '3', b: '1' });
    expect(Number(a[0].share) + Number(a[1].share)).toBeCloseTo(1, 6);
    expect(Number(a[0].quantity) + Number(a[1].quantity)).toBeCloseTo(100, 4);
    expect(Number(a[0].quantity)).toBeCloseTo(75, 4);
  });

  it('cost-only lines need no activity and are not applicable', () => {
    const r = mapLine(line({ executes: false }), m);
    expect(r.state).toBe('not_applicable');
  });

  it('mapAll counts every state and shares no hidden sample data', () => {
    const res = mapAll([line({ lineId: 'A' }), line({ lineId: 'B', executes: false })], m);
    expect(res.mappings).toHaveLength(2);
    expect(res.counts.notApplicable).toBe(1);
  });

  it('classifies construction phase from words only', () => {
    expect(phaseOf('Practical completion handover')).toBe('handover');
    expect(phaseOf('Bulk excavation')).toBe('earthworks');
  });
});

describe('New assessment items', () => {
  it('requires an explicit choice: a blank quantity or rate is never saved as zero', () => {
    const d = { ...EMPTY_DRAFT, description: 'Culvert headwall', uom: 'no', currency: 'AED' };
    const issues = validateDraft(d).map((i) => i.field);
    expect(issues).toContain('quantity'); expect(issues).toContain('rate');
    const ok = { ...d, quantityUnknown: true, unpriced: true };
    expect(validateDraft(ok)).toHaveLength(0);
    const item = itemFromDraft(ok, 'case1', 'i1', 'tester');
    expect(item.quantity).toBeNull(); expect(item.rate).toBeNull();
    expect(previewDraft(ok).signedAmount).toBeNull();
  });

  it('shows quantity x rate before saving and keeps an explicit zero as zero', () => {
    const d = { ...EMPTY_DRAFT, description: 'Excavation', uom: 'm3', quantity: '8400', rate: '25', currency: 'AED', rateBasis: 'quotation' as const };
    expect(validateDraft(d)).toHaveLength(0);
    expect(previewDraft(d).signedAmount).toBe('210000');
    const zero = { ...d, rate: '0' };
    expect(previewDraft(zero).signedAmount).toBe('0');
    expect(itemFromDraft(zero, 'c', 'i', 'u').rate).toBe('0');
  });

  it('omissions are negative once', () => {
    const d = { ...EMPTY_DRAFT, description: 'Remove kerb', uom: 'm', quantity: '10', rate: '5', currency: 'AED', changeType: 'omission' as const, rateBasis: 'market_rate' as const };
    expect(previewDraft(d).signedAmount).toBe('-50');
  });
});

describe('Stable line identity and revision invalidation', () => {
  it('never uses the BOQ ref alone as the key', () => {
    const a = stableLineId({ importId: 'imp1', sheet: 'Bill 3', rowNumber: 12 });
    const b = stableLineId({ importId: 'imp2', sheet: 'Bill 3', rowNumber: 12 });
    expect(a).not.toBe(b);
    expect(stableLineId({ newItemId: 'x' })).toBe('new|x');
  });

  it('keeps decisions for new items and invalidates source-row decisions after a revision', () => {
    const store: DecisionStore = {
      updatedAt: '',
      decisions: {
        'imp1|S|3': { lineId: 'imp1|S|3', componentId: 'c', resolution: { kind: 'unresolved', at: '' }, sourceSignature: 'old' },
        'new|x': { lineId: 'new|x', componentId: 'c', resolution: { kind: 'unresolved', at: '' }, sourceSignature: 'old' },
      },
    };
    const r = reconcileDecisions(store, 'new-signature');
    expect(r.active.map((d) => d.lineId)).toEqual(['new|x']);
    expect(r.invalidated.map((d) => d.lineId)).toEqual(['imp1|S|3']);
    expect(reconcileDecisions(store, 'old').invalidated).toHaveLength(0);
  });
});

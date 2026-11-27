// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mapLine, retrieveActivities, type WorkLine } from './realActivityMapping';
import type { ScheduleActivity, ScheduleModel } from './types';

const work = (name: string, opts: Partial<WorkLine> = {}): WorkLine => ({
  lineId: 'line', componentId: 'scope', name, description: name, specification: '', location: '', discipline: '', workType: '',
  searchTerms: [], quantity: '100', unit: 'm', action: 'add', executes: true, ...opts,
});
const task = (id: string, name: string, wbs: string, opts: Partial<ScheduleActivity> = {}): ScheduleActivity => ({
  id, taskId: id, name, wbs, start: '2027-01-01', finish: '2027-01-06', duration: 5, totalFloat: 10, progressPct: 0,
  chainFrom: 0, chainTo: 0, discipline: '', zone: '', ...opts,
});
const model = (activities: ScheduleActivity[]): ScheduleModel => ({
  activities, relationships: [], activityCount: activities.length, sampleActivities: [], wbsLevels: [], milestones: [],
} as unknown as ScheduleModel);

describe('execution activity scope evidence', () => {
  const guard = work('Installation of guard rail', { location: 'Interchange 91 / Ramp 1', specification: 'MASH TL-4' });
  it('distinguishes installation, removal, and incompatible test levels or named locations', () => {
    const m = model([
      task('remove', 'Breakout and removal of existing guard rail', 'Roads / IC91 / Ramp 1 / Guardrail TL4'),
      task('other-type', 'Installation of crash cushion', 'Roads / IC91 / Ramp 1 / Guardrail TL4'),
      task('legacy', 'Installation of guardrail TL3', 'Roads / IC91 / Ramp 1'),
      task('wrong-place', 'Install guard rail TL4', 'Roads / Interchange 92 / Ramp 1'),
      task('wrong-ramp', 'Install guard rail TL4', 'Roads / Interchange 91 / Ramp 2'),
      task('right', 'Installation of guardrail TL4', 'Roads / Interchange IC91 / Ramp 1'),
    ]);
    const r = mapLine(guard, m);
    expect(r.allocations.map((a) => a.activityCode)).toEqual(['right']);
    expect(retrieveActivities(guard, m, { limit: 20, broaden: true }).candidates.filter((c) => c.eligible).map((c) => c.activity.code)).toEqual(['right']);
    const stale = mapLine(guard, m, { activityTaskIds: ['remove'] });
    expect(stale.state).toBe('needs_question');
    expect(stale.allocations).toEqual([]);
  });

  it('keeps an unknown test level or a cost-code-only area for review, not auto-allocation', () => {
    const m = model([
      task('scope-only', 'Installation of guard rail', 'Roads / IC91 / Ramp 1'),
      task('cost-only', 'Installation of guard rail TL4', 'Roads / Mainline / Ramp 1', { activityCodes: { 'Network - Cost': 'IC91' } }),
    ]);
    const r = mapLine(guard, m);
    expect(r.state).toBe('needs_question');
    expect(r.allocations).toEqual([]);
    expect(r.candidates.find((c) => c.activity.code === 'scope-only')?.review.join(' ')).toMatch(/test level/);
    expect(r.candidates.find((c) => c.activity.code === 'cost-only')?.review.join(' ')).toMatch(/Only the cost code/);
  });

  it('requires the appropriate utility operation, utility class and bridge, not generic pipe or pile work', () => {
    const pipe = work('Relocation of recycled water HDPE line', { location: 'Bridge 94A' });
    const rows = [
      task('wrong-bridge', 'Relocation of recycled water HDPE line', 'Roads / Bridge 94B'),
      task('potable', 'Relocation of potable water HDPE pipe', 'Roads / Bridge 94A'),
      task('unrelated', 'Water proofing for pile cap', 'Roads / Bridge 94A'),
      task('generic', 'Laying of Pipe', 'Roads / Bridge 94A'),
    ];
    let r = mapLine(pipe, model(rows));
    expect(r.allocations).toEqual([]);
    expect(r.candidates.filter((c) => c.eligible).map((c) => c.activity.code)).toEqual(['generic']);
    r = mapLine(pipe, model([...rows, task('correct', 'Reclaimed water HDPE pipeline relocation', 'Roads / Bridge 094A')]));
    expect(r.allocations.map((a) => a.activityCode)).toEqual(['correct']);
  });

  it('requires a measured location split even for equally good activities under one WBS', () => {
    const line = work('Install guard rail', { location: 'IC91' });
    const m = model([task('A', 'Installation of Guard Rail', 'Roads / IC91 / Ramp 1'), task('B', 'Installation of Guard Rail', 'Roads / IC91 / Ramp 2')]);
    expect(mapLine(line, m).allocations).toEqual([]);
    expect(mapLine(line, m, { activityTaskIds: ['A', 'B'] }).allocations).toEqual([]);
    expect(mapLine(line, m, { activityTaskIds: ['A', 'B'], shares: { A: '30', B: '60' } }).allocations).toEqual([]);
    expect(mapLine(line, m, { activityTaskIds: ['A', 'B'], shares: { A: '30', B: '70' } }).allocations.map((a) => a.quantity)).toEqual(['30', '70']);
  });

  it('will not place a whole chainage range on a partially overlapping activity', () => {
    const line = work('Install guardrail', { location: 'CH 5+000 to CH 6+000' });
    const m = model([task('A', 'Install guardrail CH 5+500 to CH 6+500', 'Roads')]);
    expect(mapLine(line, m).allocations).toEqual([]);
    expect(mapLine(line, m).question?.missing).toMatch(/covers part/);
  });

  it('does not map a commercial omission of Installation to physical removal', () => {
    const line = work('Install guardrail', { location: 'IC91', action: 'omit' });
    const m = model([task('INSTALL', 'Install guardrail', 'Roads / IC91'), task('REMOVE', 'Remove guardrail', 'Roads / IC91')]);
    expect(mapLine(line, m).allocations.map((a) => a.activityCode)).toEqual(['INSTALL']);
  });
});

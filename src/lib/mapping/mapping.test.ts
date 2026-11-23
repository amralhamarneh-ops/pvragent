import { describe, expect, it } from 'vitest';
import { buildChangeSet, buildFahidDrawings, checkAgainstPvr, compareRevisions, drawingHeadline, FAHID_ZONE, polygonArea, polylineLength } from './drawingEngine';
import { mapChangesToBoq, deriveAreaQuantity } from './boqEngine';
import { buildFahidSchedule, DEMO_FIXTURE_FILTERS, mapBoqToActivities } from './activityEngine';
import { validateBoqMapping, validateDrawingChange } from './schemas';

describe('geometry', () => {
  it('measures polyline length and polygon area', () => {
    expect(polylineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }]))?.toBe(5);
    expect(polygonArea([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }]))?.toBe(12);
  });
});

describe('Fahid Island drawing comparison', () => {
  const { revB, revC } = buildFahidDrawings();
  const diff = compareRevisions(revB, revC);
  const changes = buildChangeSet(diff, FAHID_ZONE);

  it('yields +2,000 m of road and +14,000 m2 of pavement', () => {
    const road = changes?.find((c) => c?.type === 'added' && /centreline/i?.test(c?.title));
    const pave = changes?.find((c) => c?.type === 'added' && c?.measure === 'area');
    expect(Math.round(road?.value ?? 0))?.toBe(2000);
    expect(Math.round(pave?.value ?? 0))?.toBe(14000);
  });

  it('matches the PVR text', () => {
    expect(checkAgainstPvr(changes, 2000)?.match)?.toBe(true);
    expect(drawingHeadline(changes, 'Rev C'))?.toContain('14,000 m² of pavement');
  });

  it('finds the removed turning head and relocated barrier', () => {
    expect(diff?.removed?.some((e) => e?.layer === 'R4-TEMP'))?.toBe(true);
    expect(diff?.modified?.some((m) => m?.after?.layer === 'R4-BARRIER'))?.toBe(true);
  });

  it('produces valid data contracts', () => {
    changes?.forEach((c) => expect(validateDrawingChange(c))?.toEqual([]));
  });
});

describe('BoQ mapping ground truth', () => {
  const { revB, revC } = buildFahidDrawings();
  const changes = buildChangeSet(compareRevisions(revB, revC), FAHID_ZONE);
  const boq = mapChangesToBoq({ changes, bills: [3, 4, 5, 6, 12] });

  it('finds expected additions, omission, abortive and a new item', () => {
    expect(boq?.filter((m) => m?.class === 'addition')?.length)?.toBe(5);
    expect(boq?.filter((m) => m?.class === 'omission')?.length)?.toBe(1);
    expect(boq?.filter((m) => m?.class === 'abortive')?.length)?.toBe(1);
    expect(boq?.filter((m) => m?.class === 'new')?.length)?.toBe(1);
    expect(boq?.length)?.toBe(8);
  });

  it('derives 14,000 m2 for the wearing course with shown steps', () => {
    const wearing = boq?.find((m) => m?.boqRef === '3.2.07');
    expect(wearing?.quantity)?.toBe(14000);
    expect(wearing?.quantityCalc)?.toContain('14,000 m²');
    expect(deriveAreaQuantity(2000, 7, 500)?.quantity)?.toBe(13500);
  });

  it('validates every mapping', () => {
    boq?.forEach((m) => expect(validateBoqMapping(m))?.toEqual([]));
  });
});

describe('Activity mapping fixture', () => {
  const { revB, revC } = buildFahidDrawings();
  const changes = buildChangeSet(compareRevisions(revB, revC), FAHID_ZONE);
  const boq = mapChangesToBoq({ changes, bills: [3, 4, 5, 6, 12] });
  const { mappings, suggestions } = mapBoqToActivities(boq, buildFahidSchedule(), DEMO_FIXTURE_FILTERS);

  it('maps open work and flags new activities', () => {
    expect(mappings?.find((m) => m?.boqMappingId === 'BM-01')?.activityId)?.toBe('C4060');
    expect(mappings?.find((m) => m?.boqMappingId === 'BM-05')?.activityId)?.toBe('C4120');
    expect(suggestions?.length)?.toBeGreaterThanOrEqual(1);
  });
});

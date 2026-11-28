import { expect, it } from 'vitest';
import { interpretSheetAuto } from './autoInterpret';
import { interpretSheet } from './interpret';
import { csvToRawSheet } from './readers';

it('uses the item code rather than the repeated item letter under a two-line measurement standard heading', () => {
  const sheet = csvToRawSheet('Example bill', [
    ['ITEM', 'DESCRIPTION', 'CESMM4', 'UNIT', 'QUANTITY', 'RATE', 'AMOUNT'],
    ['', '', 'Ref.', '', '', 'AED', 'AED'],
    ['B', 'Vehicle detection installation', 'X 100.01', 'nr', '4', '12', '48'],
    ['B', 'Roadside signal controller', 'X 100.02', 'nr', '2', '20', '40'],
  ]);
  const { mapping } = interpretSheetAuto(sheet);
  expect(mapping.columns.ref).toBe(2);
  expect(interpretSheet(sheet, mapping).rows.filter(r => r.included).map(r => [r.ref, r.rate.cell])).toEqual([
    ['X 100.01', 'F3'], ['X 100.02', 'F4'],
  ]);
});

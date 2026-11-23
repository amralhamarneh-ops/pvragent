import { EMPTY_DRAFT, previewDraft, validateDraft, type ItemDraft } from './newItem';

/** Test helper: validate and preview a draft assessment item with sensible defaults. */
export function newItemDraftForTest(over: Partial<ItemDraft> = {}) {
  const d: ItemDraft = { ...EMPTY_DRAFT, description: 'Temporary works', uom: 'm2', quantity: '10', rate: '5', currency: 'AED', rateBasis: 'quotation', ...over };
  return { draft: d, issues: validateDraft(d), preview: previewDraft(d) };
}

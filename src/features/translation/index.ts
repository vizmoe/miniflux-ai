import { languageIdentity } from '../../config/primitives.js';
import { isUsableSourceTitle, normalizeText } from '../../html/units.js';
import { displayText, plainText } from '../../ai/text.js';
import type {
  TranslationWork,
  TranslationPayload,
} from '../../db/documents.js';
import type {
  GenerationSource,
  TranslationInspection,
  TranslationSpecification,
} from '../../generation/types.js';
import { matchingFormatting } from '../../html/inline.js';
export function translationEligibility(
  title: string,
  blockCount: number,
  primary: string | null,
  target: string,
  skip: string[],
): 'no_translatable_content' | 'language_not_required' | null {
  if (!isUsableSourceTitle(title) && blockCount === 0)
    return 'no_translatable_content';
  return primary && [languageIdentity(target), ...skip].includes(primary)
    ? 'language_not_required'
    : null;
}
function inspectedBlock(
  value: unknown,
  counts: Map<string, number>,
): { id: string; text: string } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null;
  const part = value as { id: string; text?: unknown };
  if (
    counts.get(part.id) !== 1 ||
    Object.keys(part).length !== 2 ||
    !plainText(part.text)
  )
    return null;
  return { id: part.id, text: part.text };
}
function translatedTitle(
  text: string | undefined,
  source: string,
  requested: boolean,
): TranslationPayload['title'] {
  if (!requested) return null;
  if (normalizeText(text!) === normalizeText(source))
    return { status: 'unchanged' };
  return { status: 'translated', text: text! };
}
export function inspectTranslation(
  value: unknown,
  source: GenerationSource,
  titleRequested: boolean,
): TranslationInspection {
  const result: TranslationInspection = {
    valid: false,
    value: { blocks: [] },
    missingIds: source.blocks.map((b) => b.id),
    missingTitle: titleRequested,
  };
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return result;
  const candidate = value as { title?: unknown; blocks?: unknown };
  if (
    Object.keys(candidate).some((k) => !['title', 'blocks'].includes(k)) ||
    (!titleRequested && 'title' in candidate) ||
    !Array.isArray(candidate.blocks)
  )
    return result;
  const counts = new Map<string, number>();
  for (const b of candidate.blocks)
    if (b && typeof b === 'object' && typeof b.id === 'string')
      counts.set(b.id, (counts.get(b.id) ?? 0) + 1);
  if ([...counts.keys()].some((id) => !source.blocks.some((b) => b.id === id)))
    return result;
  for (const sourceBlock of source.blocks) {
    const b: unknown = candidate.blocks.find((v) => v?.id === sourceBlock.id);
    const part = inspectedBlock(b, counts);
    if (part && matchingFormatting(sourceBlock.text, part.text))
      result.value.blocks.push(part);
  }
  if (titleRequested && displayText(candidate.title)) {
    result.value.title = candidate.title;
    result.missingTitle = false;
  }
  result.missingIds = source.blocks
    .filter((b) => !result.value.blocks.some((r) => r.id === b.id))
    .map((b) => b.id);
  result.valid = !result.missingTitle && result.missingIds.length === 0;
  return result;
}
export function translationSpecification(
  work: TranslationWork,
  source: GenerationSource,
): TranslationSpecification {
  return {
    kind: 'translation',
    instruction: work.instruction,
    targetLanguage: work.target_language,
    titleRequested: isUsableSourceTitle(source.title),
    inspect: inspectTranslation,
    build(value, input, titleRequested) {
      return {
        schema_version: 2,
        title: translatedTitle(value.title, input.title, titleRequested),
        blocks: input.blocks.map((b) => {
          const text = value.blocks.find((v) => v.id === b.id)!.text;
          return normalizeText(text) === normalizeText(b.text)
            ? { id: b.id, status: 'unchanged' }
            : { id: b.id, status: 'translated', text };
        }),
      };
    },
  };
}

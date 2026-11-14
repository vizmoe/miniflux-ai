import { z } from 'zod';
import { displayText, absoluteUrls } from '../../ai/text.js';
import { countContentUnits } from '../../html/units.js';
import type { SummaryWork } from '../../db/documents.js';
import { summaryArtifactSchema } from '../../db/documents.js';
import type { SummarySpecification } from '../../generation/types.js';

export const summaryEligibility = (
  sourceUnits: number,
  minimum: number,
): 'content_too_short' | null =>
  sourceUnits < minimum ? 'content_too_short' : null;
const text = z.string().refine(displayText);
const member = z.discriminatedUnion('format', [
  z.object({ format: z.literal('paragraph'), text }).strict(),
  z
    .object({ format: z.literal('bullets'), items: z.array(text).nonempty() })
    .strict(),
]);
export function summarySpecification(
  work: SummaryWork,
  sourceText: string,
): SummarySpecification {
  const allowedUrls = absoluteUrls(sourceText);
  return {
    kind: 'summary',
    instruction: work.instruction,
    outputLanguage: work.output_language,
    format: work.format,
    maxUnits: work.max_output_units,
    inspect(value) {
      const parsed = member.safeParse(value);
      if (!parsed.success || parsed.data.format !== work.format)
        return { valid: false, reason: 'shape', observedUnits: 0 };
      const prose =
        parsed.data.format === 'paragraph'
          ? parsed.data.text
          : parsed.data.items.join('\n');
      const observed = countContentUnits(prose);
      if ([...absoluteUrls(prose)].some((url) => !allowedUrls.has(url)))
        return { valid: false, reason: 'url', observedUnits: observed };
      if (observed > work.max_output_units)
        return {
          valid: false,
          reason: 'max_units_exceeded',
          observedUnits: observed,
        };
      return { valid: true, value: parsed.data };
    },
    build(value) {
      return summaryArtifactSchema.parse({ schema_version: 1, ...value });
    },
  };
}

import { z } from 'zod';
import { languageIdentity } from '../config/primitives.js';
import { registeredLanguages } from './registry.js';

/** Locale syntax alone accepts invented languages; require an IANA registration. */
export const languageCodeSchema = z
  .string()
  .refine((value) => value === 'und' || registeredLanguages.has(value))
  .transform((value) => languageIdentity(value));

export const languageDiagnosticSchema = z
  .object({
    source: z.enum(['local', 'llm', 'fallback']),
    outcome: z.enum(['identified', 'undetermined', 'failed']),
    reason: z.enum([
      'local_evidence',
      'no_text',
      'llm_evidence',
      'undetermined',
      'timeout',
      'invalid_response',
      'provider_error',
    ]),
    language: languageCodeSchema.nullable(),
    duration_ms: z.number().nonnegative(),
  })
  .strict();
export type LanguageDiagnostic = z.infer<typeof languageDiagnosticSchema>;

import type { SummaryPayload, TranslationPayload } from '../db/documents.js';
export interface GenerationSource {
  title: string;
  blocks: Array<{ id: string; text: string }>;
}
export interface TranslationMember {
  title?: string;
  blocks: Array<{ id: string; text: string }>;
}
export interface TranslationInspection {
  value: TranslationMember;
  valid: boolean;
  missingIds: string[];
  missingTitle: boolean;
}
export type SummaryMember =
  | { format: 'paragraph'; text: string }
  | { format: 'bullets'; items: string[] };
export type SummaryInspection =
  | { valid: true; value: SummaryMember }
  | {
      valid: false;
      reason: 'shape' | 'url' | 'max_units_exceeded';
      observedUnits: number;
    };
export interface TranslationSpecification {
  kind: 'translation';
  instruction: string;
  targetLanguage: string;
  titleRequested: boolean;
  inspect(
    value: unknown,
    source: GenerationSource,
    titleRequested: boolean,
  ): TranslationInspection;
  build(
    value: TranslationMember,
    source: GenerationSource,
    titleRequested: boolean,
  ): TranslationPayload;
}
export interface SummarySpecification {
  kind: 'summary';
  instruction: string;
  outputLanguage: string;
  format: 'paragraph' | 'bullets';
  maxUnits: number;
  inspect(value: unknown): SummaryInspection;
  build(value: SummaryMember): SummaryPayload;
}
export interface GenerationSpecifications {
  translation?: TranslationSpecification;
  summary?: SummarySpecification;
}

import type {
  AiExecution,
  ArtifactStats,
  FeatureKind,
  GenerationFailures,
  SummaryPayload,
  TranslationPayload,
} from '../db/types.js';
import type { SemanticBlock } from '../html/blocks.js';
import type { Envelope, Operation } from '../ai/protocol.js';
import type { WorkOrder } from '../runtime/concurrency.js';
import type { WorkError } from '../obs/errors.js';

export interface GenerationSource {
  title: string;
  blocks: SemanticBlock[];
}
export interface TranslationMember {
  title?: string;
  blocks: SemanticBlock[];
}
export type SummaryMember =
  | { format: 'paragraph'; text: string }
  | { format: 'bullets'; items: string[] };
export interface TranslationInspection {
  valid: boolean;
  value: TranslationMember;
  missingIds: string[];
  missingTitle: boolean;
}
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
  format: SummaryMember['format'];
  maxUnits: number;
  inspect(value: unknown): SummaryInspection;
  build(value: SummaryMember): SummaryPayload;
}
export interface Specifications {
  translation?: TranslationSpecification;
  summary?: SummarySpecification;
}
export interface CallStat {
  provider_id: string;
  model: string;
  operation: Operation;
  duration_ms: number;
  finish_reason: 'stop' | 'length' | 'content_filter' | 'other' | 'missing';
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
  outcome: 'succeeded' | 'failed';
}
export interface GenerationExecution {
  ai: AiExecution;
  order: WorkOrder;
  signal: AbortSignal;
  context: { feed_title: string; primary_language: string | null };
  sections?: string[][];
}
export type GenerateCall = (
  envelope: Envelope,
  instruction: string,
  members: string[],
  track: CallStat[],
) => Promise<Record<string, unknown>>;
export interface GenerationRun {
  execution: GenerationExecution;
  track: CallStat[];
  call: GenerateCall;
  depth: number;
  seed?: unknown;
  seedError?: WorkError;
  repairAllowed?: boolean;
}
export type GeneratedArtifact =
  | {
      kind: 'translation';
      payload: TranslationPayload;
      ai_stats: ArtifactStats;
    }
  | { kind: 'summary'; payload: SummaryPayload; ai_stats: ArtifactStats };
export interface GenerationResult {
  artifacts: GeneratedArtifact[];
  failures: GenerationFailures;
}
export type FeatureTracks = Record<FeatureKind, CallStat[]>;

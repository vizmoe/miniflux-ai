import type { z } from 'zod';
import type * as documents from './documents.js';
import type * as schema from './schema.js';
import type { compactEntrySchema } from './repository.js';
import type { WorkError } from '../obs/errors.js';

export type FeatureKind = z.infer<typeof documents.featureKind>;
export type Entry = typeof schema.entries.$inferSelect;
export type CompactEntry = z.infer<typeof compactEntrySchema>;
export type RetryPolicy = z.infer<typeof documents.retryPolicySchema>;
export type AiExecution = z.infer<typeof documents.aiExecutionSchema>;
export type LastError = z.infer<typeof documents.lastErrorSchema>;
export type Binding = z.infer<typeof documents.bindingSchema>;
export type TranslationWork = z.infer<typeof documents.translationWorkSchema>;
export type SummaryWork = z.infer<typeof documents.summaryWorkSchema>;
export type GeneratePayload = z.infer<typeof documents.generatePayloadSchema>;
export type BackfillPayload = z.infer<typeof documents.backfillPayloadSchema>;
export type BackfillProgress = z.infer<typeof documents.backfillProgressSchema>;
export type DigestSnapshot = z.infer<typeof documents.digestSnapshotSchema>;
export type TranslationPayload = z.infer<
  typeof documents.translationArtifactSchema
>;
export type SummaryPayload = z.infer<typeof documents.summaryArtifactSchema>;
export type ArtifactStats = z.infer<typeof documents.artifactStatsSchema>;
export type DigestStats = z.infer<typeof documents.digestStatsSchema>;
export type CurrentDigestStats = Extract<DigestStats, { schema_version: 2 }>;
export type ProviderStats = z.infer<typeof documents.providerStatsSchema>;
export type TaskType = keyof typeof documents.taskSchemas;
export type TaskPayloads = {
  [K in TaskType]: z.infer<(typeof documents.taskSchemas)[K]>;
};
export type TaskState = 'pending' | 'leased' | 'done' | 'dead';
export type TaskRow = typeof schema.tasks.$inferSelect;
export type Task<K extends TaskType = TaskType> = {
  [T in K]: Omit<
    TaskRow,
    'type' | 'state' | 'payload' | 'progress' | 'last_error' | 'entry_id'
  > & {
    type: T;
    state: TaskState;
    payload: TaskPayloads[T];
    progress: BackfillProgress | null;
    last_error: LastError | null;
    entry_id: T extends 'render' | 'generate_artifacts' ? number : null;
  };
}[K];
export type FeatureState = Omit<
  typeof schema.featureStates.$inferSelect,
  'kind' | 'state'
> & {
  kind: FeatureKind;
  state:
    'scheduled' | 'pending' | 'processing' | 'ready' | 'skipped' | 'failed';
};
export type FeatureDecision = Pick<
  FeatureState,
  'kind' | 'state' | 'skip_reason'
>;
export type GenerationFailures = Partial<Record<FeatureKind, WorkError>>;
export type ArtifactRow = typeof schema.artifacts.$inferSelect;
type ArtifactCommon = Omit<
  ArtifactRow,
  'kind' | 'payload' | 'render_spec' | 'ai_stats'
> & { ai_stats: ArtifactStats };
export type TranslationArtifact = ArtifactCommon & {
  kind: 'translation';
  payload: TranslationPayload;
  render_spec: z.infer<typeof documents.translationRenderSchema>;
};
export type SummaryArtifact = ArtifactCommon & {
  kind: 'summary';
  payload: SummaryPayload;
  render_spec: z.infer<typeof documents.summaryRenderSchema>;
};
export type Artifact = TranslationArtifact | SummaryArtifact;
export type ArtifactInput = Artifact extends infer T
  ? T extends Artifact
    ? Omit<T, 'id' | 'entry_id' | 'marker_token' | 'created_at'>
    : never
  : never;
export type DigestFeed = typeof schema.digestFeeds.$inferSelect;
export type DigestWindowRow = typeof schema.digestWindows.$inferSelect;
export type DigestWindow = Omit<DigestWindowRow, 'config_snapshot'> & {
  config_snapshot: DigestSnapshot;
};
export type DigestRunRow = typeof schema.digestRuns.$inferSelect;
export type DigestRun = Omit<DigestRunRow, 'ai_stats'> & {
  ai_stats: DigestStats;
};

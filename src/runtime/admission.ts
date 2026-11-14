import type { Config } from '../config/index.js';
import {
  backfillSpecs,
  generationSnapshot,
  retrySnapshot,
} from '../config/snapshots.js';
import { evaluateScope } from '../config/scope.js';
import { translationEligibility } from '../features/translation/index.js';
import { summaryEligibility } from '../features/summary/index.js';
import type { Admission, CompactEntry, Repository } from '../db/repository.js';
import type {
  BackfillPayload,
  FeatureKind,
  GeneratePayload,
  RetryPolicy,
} from '../db/documents.js';
import { ApiError } from '../obs/errors.js';

export interface AdmissionPlan {
  decisions: Admission[];
  payload: GeneratePayload | null;
  retry: RetryPolicy;
  outcomes: Partial<Record<FeatureKind, string>>;
}
function continuedPayload(
  due: FeatureKind[],
  specs: ReturnType<typeof backfillSpecs>,
  sourceUnits: number,
): GeneratePayload {
  return {
    schema_version: 1,
    requested_features: due as GeneratePayload['requested_features'],
    ai: specs.ai,
    retry_policy: specs.retry_policy,
    ...(due.includes('translation')
      ? {
          translation: {
            instruction: specs.translation!.instruction,
            target_language: specs.translation!.target_language,
            title_template: specs.translation!.title_template,
          },
        }
      : {}),
    ...(due.includes('summary')
      ? {
          summary: {
            instruction: specs.summary!.instruction,
            output_language: specs.summary!.output_language,
            format: specs.summary!.format,
            max_output_units: Math.min(
              sourceUnits,
              specs.summary!.max_output_units,
            ),
            heading: specs.summary!.heading,
          },
        }
      : {}),
  };
}
function admissionState(
  skip: string | null,
  scheduled: boolean,
): Admission['state'] {
  if (skip) return 'skipped';
  return scheduled ? 'scheduled' : 'pending';
}
export class AdmissionPolicy {
  constructor(
    private readonly config: Config,
    private readonly requireGate: () => void,
    private readonly observe: (
      kind: FeatureKind,
      outcome: string,
    ) => void = () => {},
  ) {}
  requireEnabled(features: Array<FeatureKind | 'digest'>): void {
    this.requireGate();
    if (features.some((feature) => !this.config.features[feature].enabled))
      throw new ApiError(409, 'feature_disabled');
  }
  enabledFeatures(): FeatureKind[] {
    return (['translation', 'summary'] as const).filter(
      (kind) => this.config.features[kind].enabled,
    );
  }
  plan(
    entry: CompactEntry,
    blockCount: number,
    requested = this.enabledFeatures(),
    options: {
      continuation?: BackfillPayload;
      force?: boolean;
      ignoreScope?: boolean;
    } = {},
  ): AdmissionPlan {
    if (!options.continuation) this.requireEnabled(requested);
    const specs = options.continuation ?? backfillSpecs(this.config, requested);
    const decisions: Admission[] = [];
    const outcomes: AdmissionPlan['outcomes'] = {};
    for (const kind of requested) {
      const work = specs[kind];
      if (!work) throw new Error('missing_admission_snapshot');
      if (
        !options.ignoreScope &&
        evaluateScope(work.scope, entry).action === 'deny'
      ) {
        outcomes[kind] = 'scope_denied';
        continue;
      }
      const skip =
        kind === 'translation'
          ? translationEligibility(
              entry.source_title,
              blockCount,
              entry.primary_language,
              specs.translation!.target_language,
              specs.translation!.skip_languages,
            )
          : summaryEligibility(
              entry.source_content_units,
              specs.summary!.min_source_units,
            );
      const state = admissionState(
        skip,
        kind === 'summary' &&
          specs.summary!.schedule_cron !== null &&
          !options.force,
      );
      decisions.push({ kind, state, skip_reason: skip });
      outcomes[kind] = skip ?? state;
    }
    const due = decisions
      .filter((d) => d.state === 'pending')
      .map((d) => d.kind);
    let payload: GeneratePayload | null = null;
    if (due.length) {
      if (options.continuation) {
        payload = continuedPayload(due, specs, entry.source_content_units);
      } else
        payload = generationSnapshot(
          this.config,
          due,
          entry.source_content_units,
        );
    }
    return {
      decisions,
      payload,
      outcomes,
      retry: options.continuation?.retry_policy ?? retrySnapshot(this.config),
    };
  }
  apply(
    repository: Repository,
    entryId: number,
    plan: AdmissionPlan,
    onlyMissing = false,
  ): boolean {
    const result = repository.admit(
      entryId,
      plan.decisions,
      plan.payload,
      onlyMissing,
      plan.retry,
    ).admitted;
    repository.db.afterCommit(() => {
      for (const [kind, outcome] of Object.entries(plan.outcomes))
        this.observe(kind as FeatureKind, outcome);
    });
    return result;
  }
}

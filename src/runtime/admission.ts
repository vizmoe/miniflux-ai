import type { Config } from '../config/index.js';
import type { Repository } from '../db/repository.js';
import type {
  CompactEntry,
  FeatureKind,
  FeatureDecision,
  GeneratePayload,
} from '../db/types.js';
type BackfillSpecs = ReturnType<typeof backfillSpecs>;
interface PlanOptions {
  continuation?: BackfillSpecs;
  ignoreScope?: boolean;
  force?: boolean;
}
export type AdmissionPlan = ReturnType<AdmissionPolicy['plan']>;
import {
  backfillSpecs,
  generationSnapshot,
  retrySnapshot,
} from '../config/snapshots.js';
import { evaluateScope } from '../config/scope.js';
import { translationEligibility } from '../features/translation/index.js';
import { summaryEligibility } from '../features/summary/index.js';
import { ApiError } from '../obs/errors.js';
function continuedPayload(
  due: FeatureKind[],
  specs: BackfillSpecs,
  sourceUnits: number,
): GeneratePayload {
  return {
    schema_version: 1,
    requested_features: due,
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
function admissionState(skip: string | null, scheduled: boolean) {
  if (skip) return 'skipped';
  return scheduled ? 'scheduled' : 'pending';
}
export class AdmissionPolicy {
  config;
  requireGate;
  observe;
  constructor(
    config: Config,
    requireGate: () => void,
    observe: (kind: FeatureKind, outcome: string) => void = () => {},
  ) {
    this.config = config;
    this.requireGate = requireGate;
    this.observe = observe;
  }
  requireEnabled(features: FeatureKind[]) {
    this.requireGate();
    if (features.some((feature) => !this.config.features[feature].enabled))
      throw new ApiError(409, 'feature_disabled');
  }
  enabledFeatures() {
    return (['translation', 'summary'] as const).filter(
      (kind) => this.config.features[kind].enabled,
    );
  }
  plan(
    entry: CompactEntry,
    blockCount: number,
    requested = this.enabledFeatures(),
    options: PlanOptions = {},
  ) {
    if (!options.continuation) this.requireEnabled(requested);
    const specs = options.continuation ?? backfillSpecs(this.config, requested);
    const decisions: FeatureDecision[] = [];
    const outcomes: Partial<Record<FeatureKind, string>> = {};
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
  ) {
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

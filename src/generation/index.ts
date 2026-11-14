import { MAX_SPLIT_DEPTH } from '../config/constants.js';
import { isOverflow } from '../ai/client.js';
import type { AiClient, CallStat } from '../ai/client.js';
import { parseTopLevel } from '../ai/protocol.js';
import type { Envelope } from '../ai/protocol.js';
import { halves, joinTranslation, splitSentences } from '../ai/text.js';
import { artifactStats } from '../ai/stats.js';
import type {
  AiExecution,
  ArtifactStats,
  FeatureKind,
  SummaryPayload,
  TranslationPayload,
} from '../db/documents.js';
import type { WorkOrder } from '../runtime/concurrency.js';
import { WorkError } from '../obs/errors.js';
import type {
  GenerationSource,
  GenerationSpecifications,
  SummaryMember,
  SummarySpecification,
  TranslationMember,
  TranslationInspection,
  TranslationSpecification,
} from './types.js';

export type GeneratedArtifact = { ai_stats: ArtifactStats } & (
  | { kind: 'translation'; payload: TranslationPayload }
  | { kind: 'summary'; payload: SummaryPayload }
);
export interface GenerationResult {
  artifacts: GeneratedArtifact[];
  failures: Partial<Record<FeatureKind, WorkError>>;
}
interface Execution {
  ai: AiExecution;
  order: WorkOrder;
  signal: AbortSignal;
  context: { feed_title: string; primary_language: string | null };
  sections?: string[][];
}
interface GenerationAttempt {
  execution: Execution;
  track: CallStat[];
  call: Call;
  depth: number;
  seed?: unknown;
  seedError?: WorkError;
  repairAllowed?: boolean;
}
const invalid = (kind: string) =>
  new WorkError(`${kind}_invalid`, 'validation', true);
export class ArtifactGenerator {
  constructor(
    private readonly client: AiClient,
    private readonly degraded: (depth: number) => void = () => {},
  ) {}
  async generate(
    source: GenerationSource,
    specs: GenerationSpecifications,
    execution: Execution,
  ): Promise<GenerationResult> {
    if (!specs.translation && !specs.summary)
      throw new Error('no_requested_outputs');
    const tracks: Record<FeatureKind, CallStat[]> = {
      translation: [],
      summary: [],
    };
    const kinds = (['translation', 'summary'] as const).filter((k) => specs[k]);
    const call = async (
      envelope: Envelope,
      instruction: string,
      members: string[],
      track: CallStat[],
    ): Promise<Record<string, unknown>> => {
      const value = await this.client.call(
        execution.ai,
        instruction,
        envelope,
        execution.order,
        execution.signal,
        (stat) => track.push(stat),
      );
      try {
        return parseTopLevel(value, members);
      } catch {
        if (track.at(-1)) track.at(-1)!.outcome = 'failed';
        throw new WorkError('ai_invalid_response', 'invalid_response', true);
      }
    };
    const initial: Envelope = {
      protocol_version: 1,
      operation: 'generate_artifacts',
      context: execution.context,
      source,
      requested_outputs: {
        ...(specs.translation
          ? {
              translation: {
                target_language: specs.translation.targetLanguage,
                title_requested: specs.translation.titleRequested,
                block_ids: source.blocks.map((b) => b.id),
              },
            }
          : {}),
        ...(specs.summary
          ? { summary: this.summaryOutput(specs.summary) }
          : {}),
      },
    };
    let seed: Record<string, unknown> | undefined,
      overflow: WorkError | undefined;
    const shared: CallStat[] = [];
    try {
      seed = await call(
        initial,
        kinds.map((kind) => specs[kind]!.instruction).join('\n\n'),
        kinds,
        shared,
      );
    } catch (error) {
      if (!isOverflow(error)) throw error;
      overflow = error;
    }
    for (const kind of kinds) tracks[kind].push(...shared);
    const artifacts: GeneratedArtifact[] = [],
      failures: GenerationResult['failures'] = {};
    // One member's repair or aggregation cannot regenerate its valid sibling.
    for (const kind of kinds) {
      execution.signal.throwIfAborted();
      try {
        artifacts.push(
          await this.generateMember(kind, source, specs, {
            execution,
            track: tracks[kind],
            call,
            depth: 0,
            seed: seed?.[kind],
            seedError: overflow,
          }),
        );
      } catch (error) {
        if (!(error instanceof WorkError)) throw error;
        failures[kind] = error;
      }
    }
    return { artifacts, failures };
  }
  private async generateMember(
    kind: FeatureKind,
    source: GenerationSource,
    specs: GenerationSpecifications,
    run: GenerationAttempt,
  ): Promise<GeneratedArtifact> {
    if (kind === 'translation') {
      const spec = specs.translation!;
      const member = await this.translation(
        source,
        spec,
        spec.titleRequested,
        run,
      );
      return {
        kind,
        payload: spec.build(member, source, spec.titleRequested),
        ai_stats: artifactStats(run.track),
      };
    }
    const spec = specs.summary!;
    const member = await this.summary(source, source, spec, run);
    return {
      kind,
      payload: spec.build(member),
      ai_stats: artifactStats(run.track),
    };
  }
  private depth(value: number): void {
    if (value > MAX_SPLIT_DEPTH)
      throw new WorkError('split_depth_exceeded', 'validation', false);
    if (value > 0) this.degraded(value);
  }
  private summaryOutput(spec: SummarySpecification) {
    return {
      output_language: spec.outputLanguage,
      format: spec.format,
      max_units: spec.maxUnits,
    };
  }
  private translationEnvelope(
    source: GenerationSource,
    spec: TranslationSpecification,
    titleRequested: boolean,
    context: Execution['context'],
  ): Envelope {
    return {
      protocol_version: 1,
      operation: 'generate_artifacts',
      source,
      context,
      requested_outputs: {
        translation: {
          target_language: spec.targetLanguage,
          title_requested: titleRequested,
          block_ids: source.blocks.map((b) => b.id),
        },
      },
    };
  }
  private async translation(
    source: GenerationSource,
    spec: TranslationSpecification,
    titleRequested: boolean,
    run: GenerationAttempt,
  ): Promise<TranslationMember> {
    const { execution, track, call, depth, seed, seedError } = run;
    this.depth(depth);
    let value = seed,
      splitError = seedError;
    if (value === undefined && !splitError) {
      try {
        value = (
          await call(
            this.translationEnvelope(
              source,
              spec,
              titleRequested,
              execution.context,
            ),
            spec.instruction,
            ['translation'],
            track,
          )
        ).translation;
      } catch (error) {
        if (!isOverflow(error)) throw error;
        splitError = error;
      }
    }
    if (!splitError) {
      const checked = spec.inspect(value, source, titleRequested);
      if (checked.valid) return checked.value;
      return this.repairTranslation(source, spec, checked, run);
    }
    return this.splitTranslation(
      source,
      spec,
      titleRequested,
      { execution, track, call, depth },
      splitError,
    );
  }
  private async repairTranslation(
    source: GenerationSource,
    spec: TranslationSpecification,
    checked: TranslationInspection,
    run: GenerationAttempt,
  ): Promise<TranslationMember> {
    const { execution, track, call, depth, repairAllowed = true } = run;
    const target = {
      title: checked.missingTitle ? source.title : '',
      blocks: source.blocks.filter((b) => checked.missingIds.includes(b.id)),
    };
    let replacement: TranslationMember | undefined;
    if (repairAllowed) {
      try {
        const envelope: Envelope = {
          protocol_version: 1,
          operation: 'repair_translation',
          context: execution.context,
          source: {
            title: checked.missingTitle ? target.title : null,
            blocks: target.blocks,
          },
          requested_output: { target_language: spec.targetLanguage },
          repair_targets: {
            title_requested: checked.missingTitle,
            block_ids: checked.missingIds,
          },
        };
        const repaired = await call(
          envelope,
          spec.instruction,
          ['translation'],
          track,
        );
        // A repair has an independent depth tree; its output is still transient.
        replacement = await this.translation(
          target,
          spec,
          checked.missingTitle,
          {
            execution,
            track,
            call,
            depth: 0,
            seed: repaired.translation,
            seedError: undefined,
            repairAllowed: false,
          },
        );
      } catch (error) {
        if (!isOverflow(error)) throw error;
        replacement = await this.translation(
          target,
          spec,
          checked.missingTitle,
          {
            execution,
            track,
            call,
            depth: 0,
            seed: undefined,
            seedError: error,
            repairAllowed: false,
          },
        );
      }
    } else {
      replacement = await this.splitTranslation(
        target,
        spec,
        checked.missingTitle,
        { execution, track, call, depth },
        invalid('translation'),
      );
    }
    const title = checked.value.title ?? replacement.title;
    return {
      ...(title === undefined ? {} : { title }),
      blocks: source.blocks.map(
        (b) =>
          checked.value.blocks.find((v) => v.id === b.id) ??
          replacement.blocks.find((v) => v.id === b.id)!,
      ),
    };
  }
  private sourceGroups(
    source: GenerationSource,
    sections?: string[][],
  ): GenerationSource[] | null {
    if (source.blocks.length > 1) {
      const groups = sections
        ?.map((ids) => source.blocks.filter((b) => ids.includes(b.id)))
        .filter((v) => v.length);
      const split =
        groups && groups.length > 1 ? groups : halves(source.blocks)!;
      return split.map((blocks) => ({ title: source.title, blocks }));
    }
    if (source.blocks.length === 1) {
      const b = source.blocks[0]!,
        parts = halves(splitSentences(b.text));
      if (parts)
        return parts.map((p) => ({
          title: source.title,
          blocks: [{ id: b.id, text: joinTranslation(p, b.text) }],
        }));
    }
    return null;
  }
  private async splitTranslation(
    source: GenerationSource,
    spec: TranslationSpecification,
    titleRequested: boolean,
    run: GenerationAttempt,
    error: WorkError,
  ): Promise<TranslationMember> {
    const { execution, track, call, depth } = run;
    let inputs: Array<{ source: GenerationSource; title: boolean }>;
    if (titleRequested && source.blocks.length === 1)
      inputs = [
        { source: { title: source.title, blocks: [] }, title: true },
        { source: { title: '', blocks: source.blocks }, title: false },
      ];
    else if (!source.blocks.length && titleRequested) {
      const parts = halves(splitSentences(source.title));
      if (!parts) throw error;
      inputs = parts.map((p) => ({
        source: { title: joinTranslation(p, source.title), blocks: [] },
        title: true,
      }));
    } else {
      const groups = this.sourceGroups(source, execution.sections);
      if (!groups) throw error;
      inputs = groups.map((part, i) => ({
        source: {
          ...part,
          title: i === 0 && titleRequested ? source.title : '',
        },
        title: i === 0 && titleRequested,
      }));
    }
    const originalBytes = Buffer.byteLength(
      JSON.stringify(
        this.translationEnvelope(
          source,
          spec,
          titleRequested,
          execution.context,
        ),
      ),
    );
    if (
      inputs.some(
        (i) =>
          Buffer.byteLength(
            JSON.stringify(
              this.translationEnvelope(
                i.source,
                spec,
                i.title,
                execution.context,
              ),
            ),
          ) >= originalBytes,
      )
    )
      throw error;
    const results: TranslationMember[] = [];
    for (const input of inputs)
      results.push(
        await this.translation(input.source, spec, input.title, {
          execution,
          track,
          call,
          depth: depth + 1,
        }),
      );
    const titles = results.flatMap((r) =>
      r.title === undefined ? [] : [r.title],
    );
    const value: TranslationMember = {
      ...(titleRequested
        ? { title: joinTranslation(titles, source.title) }
        : {}),
      blocks: source.blocks.map((b) => ({
        id: b.id,
        text: joinTranslation(
          results.flatMap((r) =>
            r.blocks.filter((v) => v.id === b.id).map((v) => v.text),
          ),
          b.text,
        ),
      })),
    };
    if (!spec.inspect(value, source, titleRequested).valid)
      throw invalid('translation');
    return value;
  }
  private async summary(
    source: GenerationSource,
    original: GenerationSource,
    spec: SummarySpecification,
    run: GenerationAttempt,
  ): Promise<SummaryMember> {
    const {
      execution,
      track,
      call,
      depth,
      seed,
      seedError,
      repairAllowed = true,
    } = run;
    this.depth(depth);
    let value = seed,
      error = seedError;
    if (value === undefined && !error) {
      try {
        value = (
          await call(
            {
              protocol_version: 1,
              operation: 'generate_artifacts',
              context: execution.context,
              source,
              requested_outputs: { summary: this.summaryOutput(spec) },
            },
            spec.instruction,
            ['summary'],
            track,
          )
        ).summary;
      } catch (e) {
        if (!isOverflow(e)) throw e;
        error = e;
      }
    }
    if (error) return this.splitSummary(source, original, spec, run, error);
    const checked = spec.inspect(value);
    if (checked.valid) return checked.value;
    if (checked.reason !== 'max_units_exceeded' || !repairAllowed)
      throw invalid('summary');
    const envelope: Envelope = {
      protocol_version: 1,
      operation: 'repair_summary',
      context: {
        entry_title: original.title,
        feed_title: execution.context.feed_title,
      },
      source,
      requested_output: this.summaryOutput(spec),
      repair: {
        reason: 'max_units_exceeded',
        observed_units: checked.observedUnits,
      },
    };
    try {
      const repaired = (
        await call(envelope, spec.instruction, ['summary'], track)
      ).summary;
      return this.summary(source, original, spec, {
        execution,
        track,
        call,
        depth: 0,
        seed: repaired,
        seedError: undefined,
        repairAllowed: false,
      });
    } catch (e) {
      if (!isOverflow(e)) throw e;
      return this.summary(source, original, spec, {
        execution,
        track,
        call,
        depth: 0,
        seed: undefined,
        seedError: e,
        repairAllowed: false,
      });
    }
  }
  private async splitSummary(
    source: GenerationSource,
    original: GenerationSource,
    spec: SummarySpecification,
    run: GenerationAttempt,
    error: WorkError,
  ): Promise<SummaryMember> {
    const { execution, track, call, depth } = run;
    const groups = this.sourceGroups(source, execution.sections);
    if (!groups) throw error;
    const results: SummaryMember[] = [];
    for (const group of groups)
      results.push(
        await this.summary(group, original, spec, {
          execution,
          track,
          call,
          depth: depth + 1,
        }),
      );
    return this.mergeSummaries(
      results.map(summaryText),
      original,
      spec,
      execution,
      track,
      call,
      depth + 1,
    );
  }
  private async mergeSummaries(
    partials: string[],
    original: GenerationSource,
    spec: SummarySpecification,
    execution: Execution,
    track: CallStat[],
    call: Call,
    depth: number,
  ): Promise<SummaryMember> {
    this.depth(depth);
    const envelope: Envelope = {
      protocol_version: 1,
      operation: 'merge_summary_partials',
      context: {
        entry_title: original.title,
        feed_title: execution.context.feed_title,
      },
      requested_output: this.summaryOutput(spec),
      partials: partials.map((text, position) => ({ position, text })),
    };
    try {
      const result = (
        await call(envelope, spec.instruction, ['summary'], track)
      ).summary;
      return this.summary(original, original, spec, {
        execution,
        track,
        call,
        depth,
        seed: result,
      });
    } catch (error) {
      if (!isOverflow(error) || partials.length <= 2) throw error;
      const groups = halves(partials)!;
      const reduced: string[] = [];
      for (const group of groups)
        reduced.push(
          group.length === 1
            ? group[0]!
            : summaryText(
                await this.mergeSummaries(
                  group,
                  original,
                  spec,
                  execution,
                  track,
                  call,
                  depth + 1,
                ),
              ),
        );
      if (
        Buffer.byteLength(JSON.stringify(reduced)) >=
        Buffer.byteLength(JSON.stringify(partials))
      )
        throw error;
      return this.mergeSummaries(
        reduced,
        original,
        spec,
        execution,
        track,
        call,
        depth + 1,
      );
    }
  }
}
type Call = (
  envelope: Envelope,
  instruction: string,
  members: string[],
  track: CallStat[],
) => Promise<Record<string, unknown>>;
export function summaryText(value: SummaryMember): string {
  return value.format === 'paragraph' ? value.text : value.items.join('\n');
}

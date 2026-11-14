import { z } from 'zod';
import type { AiClient, CallStat } from '../../ai/client.js';
import { isOverflow } from '../../ai/client.js';
import {
  absoluteUrls,
  halves,
  plainText,
  splitSentences,
} from '../../ai/text.js';
import { overviewResponseSchema, parseTopLevel } from '../../ai/protocol.js';
import type { Envelope, Overview, PreparedItem } from '../../ai/protocol.js';
import type { DigestSnapshot } from '../../db/documents.js';
import type { DigestRun, DigestWindow } from '../../db/digest.js';
import type { Entry } from '../../db/schema.js';
import type { WorkOrder } from '../../runtime/concurrency.js';
import { countContentUnits } from '../../html/units.js';
import { MAX_SPLIT_DEPTH } from '../../config/constants.js';
import { WorkError } from '../../obs/errors.js';

const prose = z
  .string()
  .refine(plainText)
  .refine((s) => absoluteUrls(s).size === 0);
const itemResponse = z.object({ summary: prose }).strict();
type ItemContext = Extract<
  Envelope,
  { operation: 'generate_digest_item' }
>['context'];
type OverviewContext = Extract<
  Envelope,
  { operation: 'generate_digest_overview' }
>['context'];
export class DigestGenerator {
  constructor(
    private readonly client: AiClient,
    private readonly degraded: (depth: number) => void = () => {},
  ) {}
  private depth(depth: number): void {
    if (depth > MAX_SPLIT_DEPTH)
      throw new WorkError('split_depth_exceeded', 'validation', false);
    if (depth) this.degraded(depth);
  }
  private async call(
    snapshot: DigestSnapshot,
    envelope: Envelope,
    order: WorkOrder,
    signal: AbortSignal,
    calls: CallStat[],
  ): Promise<unknown> {
    const instruction = envelope.operation.includes('overview')
      ? snapshot.prompts.overview
      : snapshot.prompts.item_summary;
    return this.client.call(
      snapshot.ai,
      instruction,
      envelope,
      order,
      signal,
      (stat) => calls.push(stat),
    );
  }
  async item(
    entry: Entry,
    input: { kind: 'summary_artifact' | 'source'; text: string },
    snapshot: DigestSnapshot,
    order: WorkOrder,
    signal: AbortSignal,
    calls: CallStat[],
  ): Promise<string> {
    const context: ItemContext = {
      output_language: snapshot.output_language,
      entry_id: entry.entry_id,
      entry_title: entry.source_title,
      feed_title: entry.source_feed_title,
      input_kind: input.kind,
      max_units: snapshot.generation.max_item_summary_units,
    };
    return this.itemLeaf(
      input.text,
      context,
      snapshot,
      order,
      signal,
      calls,
      0,
    );
  }
  private validateItem(value: unknown, max: number): string {
    const parsed = itemResponse.safeParse(value);
    if (!parsed.success || countContentUnits(parsed.data.summary) > max)
      throw new WorkError('digest_item_invalid', 'validation', true);
    return parsed.data.summary;
  }
  private async itemLeaf(
    text: string,
    context: ItemContext,
    snapshot: DigestSnapshot,
    order: WorkOrder,
    signal: AbortSignal,
    calls: CallStat[],
    depth: number,
  ): Promise<string> {
    this.depth(depth);
    try {
      return this.validateItem(
        await this.call(
          snapshot,
          {
            protocol_version: 1,
            operation: 'generate_digest_item',
            context,
            input: { text },
          },
          order,
          signal,
          calls,
        ),
        context.max_units,
      );
    } catch (error) {
      if (!isOverflow(error)) throw error;
      const blocks = text.split(/\n+/).filter((v) => v.trim());
      const groups = halves(blocks.length > 1 ? blocks : splitSentences(text));
      if (!groups) throw error;
      const parts: string[] = [];
      for (const group of groups) {
        const input = group.join('\n');
        if (Buffer.byteLength(input) >= Buffer.byteLength(text)) throw error;
        parts.push(
          await this.itemLeaf(
            input,
            context,
            snapshot,
            order,
            signal,
            calls,
            depth + 1,
          ),
        );
      }
      return this.mergeItems(
        parts,
        context,
        snapshot,
        order,
        signal,
        calls,
        depth + 1,
      );
    }
  }
  private async mergeItems(
    parts: string[],
    context: ItemContext,
    snapshot: DigestSnapshot,
    order: WorkOrder,
    signal: AbortSignal,
    calls: CallStat[],
    depth: number,
  ): Promise<string> {
    this.depth(depth);
    try {
      return this.validateItem(
        await this.call(
          snapshot,
          {
            protocol_version: 1,
            operation: 'merge_digest_item_partials',
            context,
            partials: parts.map((text, position) => ({ position, text })),
          },
          order,
          signal,
          calls,
        ),
        context.max_units,
      );
    } catch (error) {
      if (!isOverflow(error) || parts.length <= 2) throw error;
      const result: string[] = [];
      for (const group of halves(parts)!)
        result.push(
          group.length === 1
            ? group[0]!
            : await this.mergeItems(
                group,
                context,
                snapshot,
                order,
                signal,
                calls,
                depth + 1,
              ),
        );
      if (
        Buffer.byteLength(JSON.stringify(result)) >=
        Buffer.byteLength(JSON.stringify(parts))
      )
        throw error;
      return this.mergeItems(
        result,
        context,
        snapshot,
        order,
        signal,
        calls,
        depth + 1,
      );
    }
  }
  async overview(
    items: PreparedItem[],
    run: DigestRun,
    window: DigestWindow,
    order: WorkOrder,
    signal: AbortSignal,
    calls: CallStat[],
  ): Promise<Overview> {
    const context: OverviewContext = {
      output_language: window.config_snapshot.output_language,
      digest_date: window.digest_date,
      item_count: items.length,
      partition_key: run.partition_key,
      source_category_id: run.source_category_id,
      source_category_title: run.source_category_title,
    };
    return this.overviewLeaf(
      items,
      context,
      window.config_snapshot,
      order,
      signal,
      calls,
      0,
    );
  }
  private validateOverview(value: unknown, ids: number[]): Overview {
    try {
      parseTopLevel(value, ['overview', 'sections']);
    } catch {
      throw new WorkError('ai_invalid_response', 'invalid_response', true);
    }
    const result = overviewResponseSchema.safeParse(value);
    if (!result.success)
      throw new WorkError('digest_overview_invalid', 'validation', true);
    const assigned = result.data.sections.flatMap((s) => s.item_ids);
    if (
      assigned.length !== ids.length ||
      new Set(assigned).size !== ids.length ||
      assigned.some((id) => !ids.includes(id)) ||
      !prose.safeParse(result.data.overview).success ||
      result.data.sections.some((s) => !prose.safeParse(s.title).success)
    )
      throw new WorkError('digest_overview_invalid', 'validation', true);
    return result.data;
  }
  private async overviewLeaf(
    items: PreparedItem[],
    context: OverviewContext,
    snapshot: DigestSnapshot,
    order: WorkOrder,
    signal: AbortSignal,
    calls: CallStat[],
    depth: number,
  ): Promise<Overview> {
    this.depth(depth);
    try {
      return this.validateOverview(
        await this.call(
          snapshot,
          {
            protocol_version: 1,
            operation: 'generate_digest_overview',
            context: { ...context, item_count: items.length },
            items: items as [PreparedItem, ...PreparedItem[]],
          },
          order,
          signal,
          calls,
        ),
        items.map((i) => i.id),
      );
    } catch (error) {
      if (!isOverflow(error)) throw error;
      const groups = halves(items);
      if (!groups) throw error;
      const plans: Overview[] = [];
      for (const group of groups)
        plans.push(
          await this.overviewLeaf(
            group,
            context,
            snapshot,
            order,
            signal,
            calls,
            depth + 1,
          ),
        );
      return this.mergeOverviews(
        plans,
        context,
        snapshot,
        order,
        signal,
        calls,
        depth + 1,
      );
    }
  }
  private async mergeOverviews(
    parts: Overview[],
    context: OverviewContext,
    snapshot: DigestSnapshot,
    order: WorkOrder,
    signal: AbortSignal,
    calls: CallStat[],
    depth: number,
  ): Promise<Overview> {
    this.depth(depth);
    const ids = parts.flatMap((p) => p.sections.flatMap((s) => s.item_ids));
    try {
      return this.validateOverview(
        await this.call(
          snapshot,
          {
            protocol_version: 1,
            operation: 'merge_digest_overview_partials',
            context: { ...context, item_count: ids.length },
            partials: parts.map((p, position) => ({ ...p, position })),
          },
          order,
          signal,
          calls,
        ),
        ids,
      );
    } catch (error) {
      if (!isOverflow(error) || parts.length <= 2) throw error;
      const reduced: Overview[] = [];
      for (const group of halves(parts)!)
        reduced.push(
          group.length === 1
            ? group[0]!
            : await this.mergeOverviews(
                group,
                context,
                snapshot,
                order,
                signal,
                calls,
                depth + 1,
              ),
        );
      if (
        Buffer.byteLength(JSON.stringify(reduced)) >=
        Buffer.byteLength(JSON.stringify(parts))
      )
        throw error;
      return this.mergeOverviews(
        reduced,
        context,
        snapshot,
        order,
        signal,
        calls,
        depth + 1,
      );
    }
  }
}

import { isDeepStrictEqual } from 'node:util';
import { BlockPlanMismatch, compose } from '../html/composition.js';
import {
  canonicalSanitizerTree,
  sanitizeTree,
} from '../html/minifluxSanitizer.js';
import {
  computeSourceIntegritySignature,
  projectSource,
} from '../html/ownership.js';
import { parseSource } from '../html/dom.js';
import { renderPayloadSchema } from '../db/documents.js';
import type { LastError } from '../db/documents.js';
import type { Repository, Task } from '../db/repository.js';
import type { SourceReader } from '../source/index.js';
import { assertSourceCurrent } from '../source/index.js';
import type { MinifluxClient } from '../miniflux/client.js';
import type { EntryLock } from '../runtime/concurrency.js';
import { WorkError } from '../obs/errors.js';

export class Renderer {
  constructor(
    private readonly repository: Repository,
    private readonly source: SourceReader,
    private readonly client: Pick<MinifluxClient, 'updateEntry'>,
    private readonly lock: EntryLock,
    private readonly version: () => string,
    private readonly rendered: () => void = () => {},
  ) {}
  private fail(stage: LastError['integrity_stage']): never {
    throw new WorkError('render_integrity_failed', 'integrity', false, 0, {
      miniflux_version: this.version(),
      integrity_stage: stage,
    });
  }
  private verify(stage: LastError['integrity_stage'], check: () => void): void {
    try {
      check();
    } catch (error) {
      if (
        error instanceof WorkError &&
        error.detail.code === 'render_integrity_failed'
      )
        throw error;
      this.fail(stage);
    }
  }
  async run(task: Task, signal: AbortSignal): Promise<void> {
    const generation = renderPayloadSchema.parse(
      task.payload,
    ).render_generation;
    await this.lock.with(
      task.entry_id!,
      async () => {
        this.repository.assertOwner(task);
        signal.throwIfAborted();
        const entry = this.repository.entry(task.entry_id!);
        if (!entry) throw new WorkError('entry_not_found', 'not_found', false);
        if (generation > entry.render_generation)
          throw new WorkError('invalid_render_generation', 'validation', false);
        if (
          generation <= entry.rendered_generation ||
          generation < entry.render_generation
        ) {
          this.repository.settle(task, 'done');
          return;
        }
        const current = this.repository.currentArtifacts(entry.entry_id),
          ownership = this.repository.artifacts(entry.entry_id);
        const source = await this.source.load(entry.entry_id, signal);
        assertSourceCurrent(entry.source_fingerprint, source);
        let proposal: ReturnType<typeof compose>;
        try {
          proposal = compose(source, current);
        } catch (error) {
          if (error instanceof BlockPlanMismatch)
            this.fail('pre_put_block_plan_join');
          throw error;
        }
        const signature = proposal.sourceSignature;
        this.verify('pre_put_sanitizer', () => {
          const preflightRoot = parseSource(proposal.content);
          const proposedTree = canonicalSanitizerTree(preflightRoot);
          sanitizeTree(preflightRoot, entry.entry_url);
          // HTML5 parsing restores implicit containers (for example tbody)
          // that Miniflux intentionally omits from its serialized HTML.
          const sanitizedRoot = parseSource(preflightRoot.innerHTML);
          if (
            !isDeepStrictEqual(
              canonicalSanitizerTree(sanitizedRoot),
              proposedTree,
            ) ||
            !isDeepStrictEqual(
              computeSourceIntegritySignature(sanitizedRoot, ownership),
              signature,
            )
          )
            this.fail('pre_put_sanitizer');
        });
        this.repository.assertOwner(task);
        signal.throwIfAborted();
        const returned = await this.client.updateEntry(
          entry.entry_id,
          { title: proposal.title, content: proposal.content },
          signal,
        );
        this.repository.assertOwner(task);
        signal.throwIfAborted();
        const storedRoot = parseSource(returned.content);
        this.verify('put_response_markers', () => {
          const markers = projectSource(storedRoot, ownership).toSorted(
            (a, b) => a.localeCompare(b, 'en'),
          );
          if (!isDeepStrictEqual(markers, proposal.markers))
            this.fail('put_response_markers');
        });
        if (
          !isDeepStrictEqual(
            computeSourceIntegritySignature(storedRoot),
            signature,
          )
        )
          this.fail('put_response_source_signature');
        if (returned.title !== proposal.title) this.fail('put_response_title');
        this.repository.completeRender(task, generation, returned.title);
        this.rendered();
      },
      signal,
    );
  }
}

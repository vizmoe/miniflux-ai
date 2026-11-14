import { WorkError } from '../obs/errors.js';
import { createHash } from 'node:crypto';
import { expandTemplate } from '../config/primitives.js';
import { parseSource } from '../html/dom.js';
import {
  computeSourceIntegritySignature,
  projectSource,
} from '../html/ownership.js';
import type { Repository } from '../db/repository.js';
import type { MinifluxClient, StoredEntry } from '../miniflux/client.js';

export interface SourceProjection {
  title: string;
  content: string;
}
export interface SourceReader {
  load(entryId: number, signal?: AbortSignal): Promise<SourceProjection>;
}
export function sourceFingerprint(source: SourceProjection): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        source.title,
        computeSourceIntegritySignature(source.content),
      ]),
    )
    .digest('hex');
}
export function assertSourceCurrent(
  fingerprint: string | null,
  source: SourceProjection,
): void {
  if (fingerprint !== null && fingerprint !== sourceFingerprint(source))
    throw new WorkError('source_changed', 'validation', false);
}
export class MinifluxSourceReader implements SourceReader {
  constructor(
    private readonly repository: Repository,
    private readonly client: MinifluxClient,
  ) {}
  async load(entryId: number, signal?: AbortSignal): Promise<SourceProjection> {
    return (await this.inspect(entryId, undefined, signal)).source;
  }
  async inspect(entryId: number, stored?: StoredEntry, signal?: AbortSignal) {
    const entry = this.repository.entry(entryId);
    if (!entry) throw new WorkError('entry_not_found', 'not_found', false);
    const ownership = this.repository.artifacts(entryId);
    const current = stored ?? (await this.client.getEntry(entryId, signal));
    if (current.id !== entryId || current.feed_id !== entry.feed_id)
      throw new WorkError(
        'miniflux_invalid_response',
        'invalid_response',
        true,
      );
    const translation = this.repository
      .currentArtifacts(entryId)
      .find((a) => a.kind === 'translation');
    const renderedTitle =
      entry.rendered_title ??
      (translation?.kind === 'translation' &&
      translation.payload.title?.status === 'translated'
        ? expandTemplate(translation.render_spec.title_template, {
            original: entry.source_title,
            translated: translation.payload.title.text,
          })
        : entry.source_title);
    const title =
      current.title === renderedTitle ? entry.source_title : current.title;
    const root = parseSource(current.content);
    const markers = projectSource(root, ownership);
    const source = { title, content: root.innerHTML };
    return {
      source,
      stored: current,
      markers,
      fingerprint: sourceFingerprint(source),
    };
  }
}

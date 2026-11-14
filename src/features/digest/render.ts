import type { Overview, PreparedItem } from '../../ai/protocol.js';
import { escapeHtml } from '../../html/dom.js';
import { expandTemplate } from '../../config/primitives.js';
import { permalinkPath, templateValues } from '../../db/digest.js';
import type { DigestRun, DigestWindow } from '../../db/digest.js';
import type { Entry, FeedRecord } from '../../db/schema.js';

export function provisioningAtom(feed: FeedRecord): string {
  const url = escapeHtml(feed.feed_url),
    title = escapeHtml(feed.feed_title);
  return `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><id>${url}</id><title>${title}</title><updated>${new Date(feed.created_at).toISOString()}</updated><link rel="self" href="${url}"/><author><name>miniflux-ai</name></author></feed>`;
}
export function renderDigest(
  run: DigestRun,
  window: DigestWindow,
  entries: Entry[],
  items: PreparedItem[],
  overview: Overview,
) {
  const snapshot = window.config_snapshot;
  const title = expandTemplate(
    snapshot.output.entry_title_template,
    templateValues(
      snapshot,
      run.partition_key,
      run.source_category_title,
      window.digest_date,
    ),
  );
  let content = `<p><strong>${escapeHtml(window.digest_date)}</strong></p><blockquote><p>${escapeHtml(overview.overview)}</p></blockquote>`;
  for (const section of overview.sections) {
    content += `<h2>${escapeHtml(section.title)}</h2><ul>`;
    for (const id of section.item_ids) {
      const entry = entries.find((e) => e.entry_id === id)!,
        item = items.find((i) => i.id === id)!;
      let attribution = escapeHtml(entry.source_feed_title);
      if (snapshot.output.include_feed_site_url && entry.source_feed_site_url) {
        // Captured site URLs are allowed to be non-HTTP(S) ingest data; only safe links become HTML attributes.
        try {
          const url = new URL(entry.source_feed_site_url);
          if (['http:', 'https:'].includes(url.protocol))
            attribution = `<a href="${escapeHtml(entry.source_feed_site_url)}">${attribution}</a>`;
        } catch {
          /* text attribution */
        }
      }
      content += `<li><a href="${escapeHtml(entry.entry_url)}">${escapeHtml(entry.source_title)}</a><br>${escapeHtml(item.summary)}<br><small>${attribution}</small></li>`;
    }
    content += '</ul>';
  }
  return {
    title,
    content,
    url: `${snapshot.output.public_base_url}${permalinkPath(window.job_id, run.partition_key, window.digest_date)}`,
    external_id: run.external_id,
    // Miniflux's import DTO uses Unix seconds; local selection retains exact millisecond bounds.
    published_at: Math.floor(window.window_end / 1000),
    status: 'unread',
    starred: false,
  };
}

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Database } from '../src/db/database.js';
import { Repository } from '../src/db/repository.js';
import {
  backfillSpecs,
  generationSnapshot,
  retrySnapshot,
} from '../src/config/snapshots.js';
import { parseConfig } from '../src/config/index.js';
import { emptyBackfillProgress } from '../src/db/documents.js';
import { LeaseLost, WorkError } from '../src/obs/errors.js';
import type { CompactEntry } from '../src/db/types.js';

const config = parseConfig(
  'miniflux:\n  base_url: https://example.test\n  api_key: test-miniflux\nserver:\n  admin_token: test-admin\ningestion:\n  webhook:\n    enabled: false\n',
);
const roots: { root: string; db: Database }[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'miniflux-ai-db-'));
  const db = new Database(root);
  roots.push({ root, db });
  let now = 1_800_000_000_000;
  const repository = new Repository(db, () => now);
  const entry: CompactEntry = {
    entry_id: 1,
    feed_id: 1,
    category_id: 1,
    entry_url: 'https://example.test/1',
    published_at: now,
    source_author: '',
    source_feed_title: 'Feed',
    source_feed_url: 'https://example.test/feed',
    source_feed_site_url: 'https://example.test',
    source_category_title: 'Category',
    source_title: 'Article',
    source_content_units: 100,
    primary_language: 'en',
    language_confidence: 1,
  };
  repository.insertEntry(entry);
  return {
    root,
    db,
    repository,
    entry,
    advance(ms: number) {
      now += ms;
    },
  };
}
afterEach(() => {
  for (const { root, db } of roots.splice(0)) {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('keeps all recovered migration files byte-for-byte compatible', () => {
  const expected = JSON.parse(
    readFileSync(
      new URL('./fixtures/migrations.json', import.meta.url),
      'utf8',
    ),
  ) as Record<string, string>;
  for (const [path, hash] of Object.entries(expected))
    expect(
      createHash('sha256')
        .update(readFileSync(new URL('../' + path, import.meta.url)))
        .digest('hex'),
    ).toBe(hash);
});

it('migrates a fresh database, persists data, and enforces one writer', () => {
  const { root, db, repository } = setup();
  expect(db.ping()).toBe(true);
  expect(
    db.get<{ n: number }>('SELECT count(*) AS n FROM __drizzle_migrations')!.n,
  ).toBe(5);
  expect(() => new Database(root)).toThrow('instance_lock_unavailable');
  expect(repository.entry(1)?.source_title).toBe('Article');
  db.close();
  const reopened = new Database(root);
  expect(new Repository(reopened).entry(1)?.source_title).toBe('Article');
  reopened.close();
});

it('rolls back writes and emits observations only after commit', () => {
  const { db, repository, entry } = setup();
  let observed = 0;
  repository.observe.entry = () => {
    observed++;
  };
  expect(() =>
    db.transaction(() => {
      repository.insertEntry({ ...entry, entry_id: 2 });
      throw new Error('rollback');
    }),
  ).toThrow('rollback');
  expect(repository.entry(2)).toBeUndefined();
  expect(observed).toBe(0);
  db.transaction(() => {
    repository.insertEntry({ ...entry, entry_id: 2 });
    expect(observed).toBe(0);
  });
  expect(observed).toBe(1);
});

describe('durable queue contracts', () => {
  it('deduplicates active generation and fences stale leases', () => {
    const { repository, advance } = setup();
    const payload = generationSnapshot(config, ['translation'], 100);
    const decisions = [
      { kind: 'translation', state: 'pending', skip_reason: null },
    ] as const;
    repository.admit(1, [...decisions], payload);
    expect(() => repository.admit(1, [...decisions], payload)).toThrow(
      'generation_in_progress',
    );
    const task = repository.claim(2, 100)!;
    expect(task.type).toBe('generate_artifacts');
    expect(task.attempts).toBe(1);
    expect(() =>
      repository.assertOwner({ ...task, lease_owner: 'stale' }),
    ).toThrow(LeaseLost);
    advance(101);
    expect(repository.reap()).toBe(1);
    expect(() => repository.assertOwner(task)).toThrow(LeaseLost);
    expect(repository.task(task.id)?.state).toBe('pending');
    expect(repository.featureStates(1)[0].state).toBe('pending');
  });

  it('reserves a worker for foreground work and allows retrying terminal tasks', () => {
    const { repository } = setup();
    const payload = {
      schema_version: 1 as const,
      since_ms: null,
      until_ms: null,
      feed_ids: [],
      category_ids: [],
      limit: 5,
      dry_run: true,
      page_size: 10,
      ...backfillSpecs(config, ['translation']),
    };
    repository.createTask(
      'ingest_backfill',
      'background-a',
      null,
      payload,
      emptyBackfillProgress(),
    );
    repository.createTask(
      'ingest_backfill',
      'background-b',
      null,
      payload,
      emptyBackfillProgress(),
    );
    const background = repository.claim(2, 1000)!;
    expect(background.type).toBe('ingest_backfill');
    expect(repository.claim(2, 1000)).toBeUndefined();
    repository.requestRender(1, retrySnapshot(config));
    const foreground = repository.claim(2, 1000)!;
    expect(foreground.type).toBe('render');
    repository.settle(
      background,
      new WorkError('invalid_fixture', 'validation', false),
    );
    expect(repository.task(background.id)?.state).toBe('dead');
    expect(repository.requeue(background.id).attempts).toBe(0);
    expect(repository.task(background.id)?.state).toBe('pending');
  });
});

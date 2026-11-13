import { z } from 'zod';
import type { Database } from '../db/database.js';
import type { Entry, FeatureKind } from '../db/types.js';
export interface EntryListItem extends Pick<
  Entry,
  | 'entry_id'
  | 'source_title'
  | 'source_feed_title'
  | 'feed_id'
  | 'primary_language'
  | 'created_at'
  | 'entry_url'
> {
  translation_state: string | null;
  translation_skip_reason: string | null;
  summary_state: string | null;
  summary_skip_reason: string | null;
  render_status: string;
}
const states = [
  'scheduled',
  'pending',
  'processing',
  'ready',
  'skipped',
  'failed',
];
export function dashboard(db: Database, now = Date.now()) {
  const features = {
    translation: Object.fromEntries(states.map((s) => [s, 0])),
    summary: Object.fromEntries(states.map((s) => [s, 0])),
  };
  for (const row of db.all<{ kind: FeatureKind; state: string; count: number }>(
    'SELECT kind,state,count(*) AS count FROM entry_feature_states GROUP BY kind,state',
  ))
    features[row.kind][row.state] = row.count;
  const tasks = Object.fromEntries(
    ['pending', 'leased', 'done', 'dead'].map((s) => [s, 0]),
  );
  for (const row of db.all<{ state: string; count: number }>(
    'SELECT state,count(*) AS count FROM tasks GROUP BY state',
  ))
    tasks[row.state] = row.count;
  const day = 86400000,
    today = Math.floor(now / day) * day;
  const history = db.all<{ date: string; kind: FeatureKind; count: number }>(
    "SELECT strftime('%Y-%m-%d',created_at/1000,'unixepoch') AS date,kind,count(*) AS count FROM artifacts WHERE created_at>=? AND created_at<? GROUP BY date,kind",
    today - 13 * day,
    today + day,
  );
  const activity = Array.from({ length: 14 }, (_, i) => {
    const date = new Date(today - (13 - i) * day).toISOString().slice(0, 10);
    return {
      date,
      translation:
        history.find((r) => r.date === date && r.kind === 'translation')
          ?.count ?? 0,
      summary:
        history.find((r) => r.date === date && r.kind === 'summary')?.count ??
        0,
    };
  });
  const feeds = db.all<{
    feed_id: number;
    title: string;
    entries: number;
    translation_ready: number;
    translation_failed: number;
    translation_skipped: number;
  }>(`SELECT e.feed_id,max(e.source_feed_title) AS title,count(*) AS entries,
    sum(CASE WHEN t.state='ready' THEN 1 ELSE 0 END) AS translation_ready,
    sum(CASE WHEN t.state='failed' THEN 1 ELSE 0 END) AS translation_failed,
    sum(CASE WHEN t.state='skipped' THEN 1 ELSE 0 END) AS translation_skipped
    FROM entries e LEFT JOIN entry_feature_states t ON t.entry_id=e.entry_id AND t.kind='translation'
    GROUP BY e.feed_id ORDER BY translation_failed DESC,entries DESC,e.feed_id LIMIT 20`);
  const count = (sql: string) => db.get<{ n: number }>(sql)!.n;
  return {
    as_of: new Date(now).toISOString(),
    entries: count('SELECT count(*) AS n FROM entries'),
    render_pending: count(
      'SELECT count(*) AS n FROM entries WHERE render_generation>rendered_generation',
    ),
    rendered: count(
      'SELECT count(*) AS n FROM entries WHERE render_generation>0 AND render_generation=rendered_generation',
    ),
    features,
    tasks,
    activity,
    feeds,
  };
}
export function listEntries(db: Database, input: unknown) {
  const query = z
    .object({
      q: z.string().trim().max(200).optional(),
      state: z.enum(states).optional(),
      feature: z.enum(['translation', 'summary']).default('translation'),
      before_id: z.coerce.number().pipe(z.int().positive()).optional(),
      limit: z.coerce.number().pipe(z.int().min(1).max(100)).default(30),
      feed_id: z.coerce.number().pipe(z.int().positive()).optional(),
    })
    .strict()
    .parse(input);
  const clauses = [],
    values = [];
  if (query.q) {
    clauses.push(
      '(instr(lower(e.source_title),lower(?))>0 OR CAST(e.entry_id AS TEXT)=?)',
    );
    values.push(query.q, query.q);
  }
  if (query.state) {
    clauses.push(`${query.feature === 'translation' ? 't' : 's'}.state=?`);
    values.push(query.state);
  }
  if (query.before_id) {
    clauses.push('e.entry_id<?');
    values.push(query.before_id);
  }
  if (query.feed_id) {
    clauses.push('e.feed_id=?');
    values.push(query.feed_id);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const entries = db.all<EntryListItem>(
    `SELECT e.entry_id,e.source_title,e.source_feed_title,e.feed_id,e.primary_language,e.created_at,e.entry_url,
    t.state AS translation_state,t.skip_reason AS translation_skip_reason,s.state AS summary_state,s.skip_reason AS summary_skip_reason,
    CASE WHEN e.render_generation=0 THEN 'never_requested' WHEN e.render_generation>e.rendered_generation THEN 'pending' ELSE 'current' END AS render_status
    FROM entries e LEFT JOIN entry_feature_states t ON t.entry_id=e.entry_id AND t.kind='translation'
    LEFT JOIN entry_feature_states s ON s.entry_id=e.entry_id AND s.kind='summary'
    ${where} ORDER BY e.entry_id DESC LIMIT ?`,
    ...values,
    query.limit + 1,
  );
  const hasMore = entries.length > query.limit;
  if (hasMore) entries.pop();
  return { entries, next_cursor: hasMore ? entries.at(-1)!.entry_id : null };
}

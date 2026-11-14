import { entry, feed, serviceFixture, response } from '../helpers.js';

const fixture = await serviceFixture(
  'features:\n  summary:\n    min_source_units: 1\n  digest:\n    enabled: false\n    jobs:\n      - id: daily\n        cron: "0 0 * * *"\n        output:\n          feed_title_template: Daily digest\n',
);
const titles = [
  'Making the Internet faster, one connection at a time',
  'A practical guide to building resilient systems',
  'The next chapter for the open web',
  'Understanding how your data travels around the world',
  'Designing software that stands the test of time',
  '<img src=x onerror="window.injected=true"> untrusted title',
];
fixture.upstream.feeds.set(1, { ...feed(1), title: 'Cloudflare Blog' });
fixture.upstream.feeds.set(2, { ...feed(2), title: 'Engineering Notes' });
fixture.upstream.categories.set(7, { id: 7, title: 'News' });
fixture.upstream.categories.set(9, { id: 9, title: 'Empty category' });
await fixture.prepare();
for (let i = 1; i <= titles.length; i++) {
  const row = entry(
    i,
    '<p>A complete guide to maintaining useful software and improving reliability.</p>',
    i % 2 ? 1 : 2,
  );
  row.title = titles[i - 1]!;
  row.feed = fixture.upstream.feeds.get(row.feed_id)!;
  fixture.upstream.entries.set(i, row);
}
await fixture.service.ingest.poll();
await fixture.drain();
fixture.upstream.entries.set(7, {
  ...entry(7),
  feed: fixture.upstream.feeds.get(1)!,
  title: 'When a model provider rejects a request',
});
fixture.upstream.aiHandler = () =>
  response({ error: { message: 'Bad credentials' } }, 401);
await fixture.service.ingest.poll();
await fixture.drain();
fixture.upstream.aiHandler = undefined;
await fixture.app.listen({ host: '127.0.0.1', port: 4199 });
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void fixture.close().then(() => process.exit(0));
  });

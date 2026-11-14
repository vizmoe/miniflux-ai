import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { absoluteUrls } from '../src/ai/text.js';
import { cleanLexical } from '../src/html/units.js';

describe('untrusted text processing', () => {
  it.each([
    [
      'scheme candidate',
      "assert.equal(absoluteUrls('a'.repeat(150_000)).size, 0)",
    ],
    [
      'URL punctuation',
      "const url = 'https://example.test/' + '.'.repeat(150_000) + 'x'; assert.deepEqual([...absoluteUrls(url)], [url])",
    ],
    [
      'email candidate',
      "assert.equal(cleanLexical('a'.repeat(150_000)).trim(), '')",
    ],
    [
      'base URL slash run',
      "const url = 'https://example.test/' + '/'.repeat(150_000) + 'x'; assert.equal(normalizeBaseUrl(url + '/'), url)",
    ],
    [
      'srcset comma run',
      "const url = 'https://example.test/' + ','.repeat(150_000) + 'x'; const root = parseSource(sanitize('<img srcset=\"' + url + ',\">', 'https://example.test')); assert.equal(root.querySelector('img').getAttribute('srcset'), url)",
    ],
  ])(
    'bounds %s processing without blocking the service',
    (_name, assertion) => {
      // A subprocess deadline can interrupt a synchronous regex that blocks the event loop.
      // The budget includes TS loader startup and is deliberately generous for CI.
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `
      import assert from 'node:assert/strict';
      import { absoluteUrls } from './src/ai/text.ts';
      import { cleanLexical } from './src/html/units.ts';
      import { normalizeBaseUrl } from './src/config/primitives.ts';
      import { sanitize } from './src/html/minifluxSanitizer.ts';
      import { parseSource } from './src/html/dom.ts';
      ${assertion};
    `,
        ],
        { cwd: process.cwd(), timeout: 4000, encoding: 'utf8' },
      );
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
    },
  );

  it('recognizes URL schemes and trims only sentence punctuation', () => {
    expect([
      ...absoluteUrls(
        'See (https://example.test/a), ftp://files.test/a; svn+ssh://host.test/repo. 新链接：https://example.test/b。',
      ),
    ]).toEqual([
      'https://example.test/a',
      'ftp://files.test/a',
      'svn+ssh://host.test/repo',
      'https://example.test/b',
    ]);
    expect([
      ...absoluteUrls('prefix https://example.test/a...b suffix'),
    ]).toEqual(['https://example.test/a...b']);
  });

  it('keeps word boundaries and chained addresses in lexical cleaning', () => {
    expect(cleanLexical('1aa-bhttp://x')).toBe(' aa- ');
    expect(cleanLexical('a1@user@example.com1...')).toBe('a @  ...');
    expect(cleanLexical('user@example.coma+b@user@example.com')).toBe(' +b@ ');
  });

  it('removes lexical noise while retaining adjacent prose', () => {
    for (const noise of [
      'user+tag@host.test',
      'www.host.test/a',
      'https://host.test/a',
      '/tmp/file',
      '../file',
      '~/file',
      'C:\\file',
      'v1.2.3',
      'abcdef0123456789',
    ]) {
      expect(
        cleanLexical(`before ${noise} after`).trim().replace(/\s+/g, ' '),
      ).toBe('before after');
    }
    expect(cleanLexical('An ordinary prose sentence.')).toBe(
      'An ordinary prose sentence.',
    );
  });
});

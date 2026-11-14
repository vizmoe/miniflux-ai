import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(dir, entry.name))
      : [join(dir, entry.name)],
  );
}
describe('executable architecture boundaries', () => {
  it('keeps Features independent and orchestration behind shared interfaces', () => {
    for (const file of files('src').filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(file, 'utf8'),
        source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest),
        feature = /^src\/features\/([^/]+)\//.exec(file)?.[1];
      const imports = source.statements
        .filter(ts.isImportDeclaration)
        .map((s) => (s.moduleSpecifier as ts.StringLiteral).text);
      for (const path of imports) {
        if (feature)
          for (const other of ['translation', 'summary', 'digest'].filter(
            (f) => f !== feature,
          ))
            expect(path, `${file} imports ${path}`).not.toMatch(
              new RegExp(`(?:^|/)${other}(?:/|$)`),
            );
        if (file.startsWith('src/generation/'))
          expect(path).not.toContain('features/');
      }
      if (!['src/render/index.ts', 'src/miniflux/client.ts'].includes(file))
        expect(text, file).not.toMatch(/\.updateEntry\s*\(/);
      if (
        file.startsWith('src/features/') ||
        file.startsWith('src/generation/') ||
        file.startsWith('src/server/')
      ) {
        expect(text, file).not.toMatch(
          /\.getEntry\s*\(|projectSource\s*\(|mfai-v1-(?:translation|summary)-/,
        );
      }
      if (/^src\/(?:ingest|queue)\//.test(file))
        expect(
          imports.every((path) => !/features\/|scheduler\//.test(path)),
        ).toBe(true);
    }
  });
  it('contains no original-page, Readability, fetch-content or alternate-storage path', () => {
    const production = files('src')
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    expect(production).not.toMatch(
      /fetch-content|readability|postgres(?:ql)?:\/\/|mysql:\/\//i,
    );
    expect(JSON.parse(readFileSync('package.json', 'utf8')).private).toBe(true);
    expect(
      relative(process.cwd(), join(process.cwd(), 'data/miniflux-ai.db')),
    ).toBe('data/miniflux-ai.db');
  });
});

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { YamlConfiguration } from '../src/config/store.js';

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
const text = `# Operator comment\nminiflux:\n  base_url: https://miniflux.test\n  api_key: private-miniflux\nserver:\n  admin_token: private-admin\ningestion:\n  webhook:\n    enabled: false\nai:\n  providers:\n    - id: primary\n      base_url: https://ai.test/v1\n      api_key: private-ai\n      model: old\n`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mfai-yaml-'));
  roots.push(root);
  const path = join(root, 'config.yaml');
  writeFileSync(path, text);
  return { path, store: new YamlConfiguration(path) };
}
describe('atomic YAML configuration', () => {
  it('writes a private replacement, preserves unrelated settings/comments, and survives reload', () => {
    const { path, store } = fixture();
    const before = store.read();
    const inode = statSync(path).ino;
    store.updateAi(before.revision, (ai) => ({
      ...ai,
      providers: ai.providers.map((p) => ({ ...p, model: 'new' })),
    }));
    expect(statSync(path).ino).not.toBe(inode);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toContain('# Operator comment');
    const reloaded = new YamlConfiguration(path).read();
    expect(reloaded.config.ai.providers[0]!.model).toBe('new');
    expect(reloaded.config.miniflux).toEqual(before.config.miniflux);
    expect(reloaded.revision).not.toBe(before.revision);
  });
  it('notices manual edits and rejects stale saves without overwriting them', () => {
    const { path, store } = fixture();
    const before = store.read();
    writeFileSync(path, text.replace('model: old', 'model: manual'));
    expect(store.read().config.ai.providers[0]!.model).toBe('manual');
    expect(() => store.updateAi(before.revision, (ai) => ai)).toThrow(
      'configuration_conflict',
    );
    expect(readFileSync(path, 'utf8')).toContain('model: manual');
  });
  it('leaves the file intact when validation or credential alias isolation fails', () => {
    const { path, store } = fixture();
    expect(() =>
      store.updateAi(store.read().revision, (ai) => ({
        ...ai,
        providers: [{ ...ai.providers[0]!, base_url: 'http://insecure.test' }],
      })),
    ).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(text);
    const aliased = text
      .replace('api_key: private-miniflux', 'api_key: *key')
      .replace('api_key: private-ai', 'api_key: &key private-ai');
    // YAML forward aliases are invalid and must never become a partly written configuration.
    writeFileSync(path, aliased);
    expect(() => store.read()).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(aliased);
  });
  it('rejects symlink destinations and reports unavailable files without contents', () => {
    const { path } = fixture();
    const link = path + '.link';
    symlinkSync(path, link);
    expect(() => new YamlConfiguration(link).read()).toThrow(
      'configuration_unavailable',
    );
    writeFileSync(path, 'miniflux: private-secret-invalid-config');
    expect(() => new YamlConfiguration(path).read()).toThrow('miniflux');
  });
});

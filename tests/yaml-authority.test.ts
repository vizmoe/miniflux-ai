import { describe, expect, it } from 'vitest';
import { parseConfig, redactConfig } from '../src/config/index.js';

const common = `miniflux:\n  base_url: https://miniflux.test\n  api_key: fixture-miniflux\nserver:\n  admin_token: fixture-admin\ningestion:\n  webhook:\n    enabled: false\n`;
const yaml = `${common}ai:\n  providers:\n    - id: primary\n      priority: 100\n      base_url: https://primary.test/v1\n      api_key: fixture-primary\n      model: primary-model\n    - id: secondary\n      priority: 50\n      base_url: https://secondary.test/v1\n      api_key: fixture-secondary\n      model: secondary-model\n`;

describe('YAML configuration authority', () => {
  it('accepts multiple complete providers and redacts every credential', () => {
    const config = parseConfig(yaml);
    expect(config.ai.providers.map((p) => p.id)).toEqual([
      'primary',
      'secondary',
    ]);
    expect(config.ai.failover).toEqual({
      cooldown: '5m',
      failure_threshold: 2,
    });
    const view = JSON.stringify(redactConfig(config));
    for (const secret of [
      'fixture-primary',
      'fixture-secondary',
      'fixture-miniflux',
      'fixture-admin',
    ])
      expect(view).not.toContain(secret);
  });
  it('leaves literal prompt expressions untouched instead of interpolating environment variables', () => {
    const config = parseConfig(
      `${yaml}prompts:\n  summary: 'Explain the literal expression \${HOME}.'\n`,
    );
    expect(config.prompts.summary).toContain('${HOME}');
  });
  it('rejects duplicated provider identities', () => {
    expect(() =>
      parseConfig(yaml.replace('id: secondary', 'id: primary')),
    ).toThrow();
  });
});

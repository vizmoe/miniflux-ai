import { z } from 'zod';
import {
  aiConfigSchema,
  ConfigurationError,
  providerSchema,
  redactConfig,
} from '../config/index.js';
import type { Config } from '../config/index.js';
import { canonicalJson } from '../config/primitives.js';
import type { YamlConfiguration } from '../config/store.js';
import type { AiClient } from '../ai/client.js';
import { ApiError } from '../obs/errors.js';

const updateSchema = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    providers: z
      .array(
        providerSchema
          .omit({ api_key: true })
          .extend({ api_key: z.string().max(4096).optional() }),
      )
      .max(32),
    failover: aiConfigSchema.shape.failover,
  })
  .strict();
const restartSettings = (c: Config) =>
  canonicalJson({
    ...c,
    ai: { max_concurrent_requests: c.ai.max_concurrent_requests },
  });

/** The management API edits the same file consulted before each AI call. */
export class ModelSettings {
  constructor(
    private readonly configuration: YamlConfiguration,
    private readonly startup: Config,
    private readonly health: () => ReturnType<AiClient['health']>,
    private readonly changed: () => void = () => {},
  ) {}
  get configured(): boolean {
    try {
      return this.configuration
        .read()
        .config.ai.providers.some((p) => p.enabled);
    } catch {
      return false;
    }
  }
  requireConfigured(): void {
    if (!this.configured) throw new ApiError(503, 'model_not_configured');
  }
  private restartRequired(config: Config): boolean {
    return restartSettings(config) !== restartSettings(this.startup);
  }
  configView() {
    const { config, revision } = this.configuration.read();
    return {
      source: 'yaml' as const,
      revision,
      restart_required: this.restartRequired(config),
      config: redactConfig(config),
    };
  }
  view() {
    const { config, revision } = this.configuration.read();
    const health = this.health();
    return {
      revision,
      source: 'yaml' as const,
      restart_required: this.restartRequired(config),
      configured: config.ai.providers.some((p) => p.enabled),
      max_concurrent_requests: config.ai.max_concurrent_requests,
      failover: config.ai.failover,
      providers: config.ai.providers.map(({ api_key, ...p }) => ({
        ...p,
        api_key_configured: Boolean(api_key),
        health: health.find((h) => h.id === p.id) ?? {
          id: p.id,
          state: p.enabled ? ('healthy' as const) : ('disabled' as const),
          consecutive_failures: 0,
          retry_at: null,
          last_failure: null,
        },
      })),
    };
  }
  update(input: unknown) {
    const data = updateSchema.parse(input);
    try {
      this.configuration.updateAi(data.revision, (current) => ({
        ...current,
        failover: data.failover,
        providers: data.providers.map((p) => {
          const previous = current.providers.find(
            (old) => old.id === p.id && old.base_url === p.base_url,
          );
          const api_key = p.api_key?.trim() || previous?.api_key;
          if (!api_key) throw new ApiError(400, 'api_key_required');
          return { ...p, api_key };
        }),
      }));
    } catch (error) {
      if (error instanceof ConfigurationError)
        throw new ApiError(400, 'invalid_configuration', {
          paths: error.paths,
        });
      throw error;
    }
    this.changed();
    return this.view();
  }
}

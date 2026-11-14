import { createHash } from 'node:crypto';
import type { AiConfiguration, AiProvider } from '../config/index.js';
import { durationMs } from '../config/primitives.js';
import { WorkError } from '../obs/errors.js';

type Health = {
  fingerprint: string;
  failures: number;
  retryAt: number | null;
  probe: Promise<void> | null;
  epoch: number;
  lastFailure: string | null;
};
const fingerprint = (p: AiProvider) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        p.base_url,
        p.api_key,
        p.model,
        p.request_timeout_ms,
        p.enabled,
      ]),
    )
    .digest('hex');

async function waitForRecovery(probes: Promise<void>[], signal: AbortSignal) {
  signal.throwIfAborted();
  let onAbort = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.race(probes).then(resolve, reject);
    });
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** One shared circuit per configured service, across every Feature and language review. */
export class ProviderPool {
  private readonly states = new Map<string, Health>();
  constructor(
    private readonly configuration: () => AiConfiguration,
    private readonly now = Date.now,
  ) {}
  private current(): AiConfiguration {
    let config: AiConfiguration;
    try {
      config = structuredClone(this.configuration());
    } catch {
      throw new WorkError('ai_configuration_unavailable', 'validation', true);
    }
    const ids = new Set(config.providers.map((p) => p.id));
    for (const id of this.states.keys())
      if (!ids.has(id)) this.states.delete(id);
    for (const p of config.providers) {
      const identity = fingerprint(p);
      if (this.states.get(p.id)?.fingerprint !== identity)
        this.states.set(p.id, {
          fingerprint: identity,
          failures: 0,
          retryAt: null,
          probe: null,
          epoch: 0,
          lastFailure: null,
        });
    }
    return config;
  }
  private healthState(provider: AiProvider, health: Health) {
    if (!provider.enabled) return 'disabled' as const;
    if (health.probe) return 'probing' as const;
    if (health.retryAt === null) return 'healthy' as const;
    return health.retryAt > this.now()
      ? ('cooling' as const)
      : ('recovering' as const);
  }
  health() {
    return this.current().providers.map((p) => {
      const h = this.states.get(p.id)!;
      return {
        id: p.id,
        state: this.healthState(p, h),
        consecutive_failures: h.failures,
        retry_at: h.retryAt,
        last_failure: h.lastFailure,
      };
    });
  }
  private available(
    provider: AiProvider,
    attempted: Set<string>,
    probes: Promise<void>[],
  ): Health | undefined {
    if (attempted.has(provider.id)) return;
    const h = this.states.get(provider.id);
    // Calls keep their route snapshot, but may not modify an edited provider's circuit.
    if (h?.fingerprint !== fingerprint(provider)) return;
    if (h.probe) {
      probes.push(h.probe);
      return;
    }
    if (h.retryAt !== null && h.retryAt > this.now()) return;
    return h;
  }
  private recordFailure(
    provider: AiProvider,
    h: Health,
    epoch: number,
    probe: boolean,
    config: AiConfiguration,
    error: WorkError,
  ): void {
    if (this.states.get(provider.id) !== h) return;
    if (h.epoch !== epoch) {
      // A late failure may extend Retry-After, but cannot revive a cooled circuit.
      if (h.retryAt !== null && error.retryAfterMs > 0)
        h.retryAt = Math.max(h.retryAt, this.now() + error.retryAfterMs);
      return;
    }
    h.failures++;
    h.lastFailure = error.detail.code;
    if (
      probe ||
      h.failures >= config.failover.failure_threshold ||
      error.retryAfterMs > 0
    ) {
      h.retryAt =
        this.now() +
        Math.max(durationMs(config.failover.cooldown), error.retryAfterMs);
      h.epoch++;
    }
  }
  private async runAttempt<T>(
    provider: AiProvider,
    h: Health,
    config: AiConfiguration,
    attempt: (provider: AiProvider) => Promise<T>,
    signal: AbortSignal,
  ): Promise<{ ok: true; value: T } | { ok: false; error: WorkError }> {
    const probe = h.retryAt !== null;
    let finishProbe = () => {};
    if (probe)
      h.probe = new Promise<void>((resolve) => {
        finishProbe = resolve;
      });
    const epoch = h.epoch;
    const succeeded = () => {
      if (this.states.get(provider.id) !== h || h.epoch !== epoch) return;
      h.failures = 0;
      h.retryAt = null;
      h.lastFailure = null;
    };
    try {
      const value = await attempt(provider);
      signal.throwIfAborted();
      succeeded();
      return { ok: true, value };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (!(error instanceof WorkError)) throw error;
      if (
        ['context_overflow', 'request_too_large', 'output_truncated'].includes(
          error.detail.failure_class,
        )
      ) {
        succeeded();
        throw error;
      }
      this.recordFailure(provider, h, epoch, probe, config, error);
      return { ok: false, error };
    } finally {
      if (probe) {
        h.probe = null;
        finishProbe();
      }
    }
  }
  async run<T>(
    attempt: (provider: AiProvider) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    signal.throwIfAborted();
    const config = this.current();
    const providers = config.providers
      .filter((p) => p.enabled)
      .sort((a, b) => b.priority - a.priority);
    if (!providers.length)
      throw new WorkError('ai_not_configured', 'auth', false);
    const errors: WorkError[] = [];
    const attempted = new Set<string>();
    for (;;) {
      const probes: Promise<void>[] = [];
      for (const provider of providers) {
        signal.throwIfAborted();
        const h = this.available(provider, attempted, probes);
        if (!h) continue;
        attempted.add(provider.id);
        const result = await this.runAttempt(
          provider,
          h,
          config,
          attempt,
          signal,
        );
        if (result.ok) return result.value;
        errors.push(result.error);
      }
      if (!probes.length) break;
      // Keep the current task attempt open when its only remaining route is
      // already probing. Healthy alternatives above still run immediately.
      await waitForRecovery(probes, signal);
    }
    return this.unavailable(providers, errors);
  }
  private unavailable(providers: AiProvider[], errors: WorkError[]): never {
    const waits = providers.map((p) => {
      const h = this.states.get(p.id);
      return Math.max(0, (h?.retryAt ?? 0) - this.now());
    });
    const wait = Math.min(...waits);
    const failure = errors.find((e) => e.detail.retryable) ?? errors.at(-1);
    if (failure) {
      const retryable =
        failure.detail.retryable || waits.some((delay) => delay > 0);
      throw new WorkError(
        failure.detail.code,
        failure.detail.failure_class,
        retryable,
        wait,
        { ...failure.detail, retryable },
      );
    }
    throw new WorkError(
      'ai_providers_unavailable',
      'overload',
      true,
      Math.max(1000, wait),
    );
  }
}

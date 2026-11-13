import { Cron } from 'croner';
interface SchedulerCallbacks {
  gate(): boolean;
  verify(): Promise<unknown>;
  bootstrap(): Promise<unknown>;
  poll(signal: AbortSignal): Promise<unknown>;
  recoverEntries(signal: AbortSignal): Promise<unknown>;
  resumeWindows(): Promise<unknown>;
  reconcileFeeds(): Promise<unknown>;
  activate(): Promise<unknown>;
  summaries(): Promise<unknown>;
  digest(id: string, occurrence: Date): Promise<unknown>;
  failed(operation: string): void;
}
interface SchedulerConfig {
  pollIntervalMs: number;
  summaryCron: string | null;
  digestCrons: { id: string; cron: string }[];
}
import { ENTRY_RECOVERY_TICK_MS } from '../config/constants.js';
/** Owns cross-module time/event delivery. Module callbacks own transactions. */
export class Scheduler {
  callbacks;
  config;
  controller = new AbortController();
  crons: Cron[] = [];
  pollTimer?: NodeJS.Timeout;
  retryTimer?: NodeJS.Timeout;
  recoveryTimer?: NodeJS.Timeout;
  activationFlight?: Promise<void>;
  activationRequested = false;
  polling = false;
  startupFlight?: Promise<void>;
  initialized = false;
  pending = new Set<Promise<unknown>>();
  constructor(callbacks: SchedulerCallbacks, config: SchedulerConfig) {
    this.callbacks = callbacks;
    this.config = config;
  }
  run(operation: string, work: () => Promise<unknown>) {
    if (this.controller.signal.aborted) return;
    const promise = work()
      .catch(() => this.callbacks.failed(operation))
      .finally(() => this.pending.delete(promise));
    this.pending.add(promise);
  }
  start() {
    this.run('startup', () => this.initialize());
    this.recoveryTimer = setInterval(() => {
      if (this.initialized && this.callbacks.gate())
        this.run('recovery', () =>
          this.callbacks.recoverEntries(this.controller.signal),
        );
    }, ENTRY_RECOVERY_TICK_MS);
    this.retryTimer = setInterval(
      () => this.run('startup', () => this.initialize()),
      60_000,
    );
    this.pollTimer = setInterval(
      () => this.run('poll', () => this.poll()),
      this.config.pollIntervalMs,
    );
    if (this.config.summaryCron)
      this.crons.push(
        new Cron(
          this.config.summaryCron,
          {
            timezone: 'UTC',
            protect: true,
            mode: '5-part',
            sloppyRanges: true,
          },
          () => {
            if (this.callbacks.gate() && this.initialized)
              this.run('summaries', () => this.callbacks.summaries());
          },
        ),
      );
    for (const job of this.config.digestCrons) {
      let expected: Date | null = null;
      const cron = new Cron(
        job.cron,
        { timezone: 'UTC', protect: true, mode: '5-part', sloppyRanges: true },
        () => {
          const occurrence = expected;
          expected = cron.nextRun();
          if (occurrence && this.callbacks.gate() && this.initialized)
            this.run('digest', () => this.callbacks.digest(job.id, occurrence));
        },
      );
      expected = cron.nextRun();
      this.crons.push(cron);
    }
  }
  async initialize(): Promise<void> {
    if (this.initialized || this.controller.signal.aborted) return;
    if (this.startupFlight) return this.startupFlight;
    this.startupFlight = (async () => {
      await this.callbacks.verify();
      if (!this.callbacks.gate() || this.controller.signal.aborted) return;
      await this.callbacks.bootstrap();
      if (this.controller.signal.aborted) return;
      await this.callbacks.resumeWindows();
      this.initialized = true;
      await this.callbacks.reconcileFeeds();
      await this.requestActivation();
    })().finally(() => {
      this.startupFlight = undefined;
    });
    return this.startupFlight;
  }
  recovered() {
    this.run('recovery', async () => {
      await this.initialize();
      await this.callbacks.reconcileFeeds();
      await this.requestActivation();
    });
  }
  async poll() {
    if (this.polling || !this.callbacks.gate()) return;
    this.polling = true;
    try {
      await this.initialize();
      await this.callbacks.poll(this.controller.signal);
      await this.callbacks.recoverEntries(this.controller.signal);
    } finally {
      try {
        await this.callbacks.reconcileFeeds();
      } finally {
        try {
          await this.requestActivation();
        } finally {
          this.polling = false;
        }
      }
    }
  }
  requestActivation() {
    if (this.controller.signal.aborted || !this.callbacks.gate())
      return Promise.resolve();
    this.activationRequested = true;
    if (this.activationFlight) return this.activationFlight;
    this.activationFlight = (async () => {
      do {
        this.activationRequested = false;
        await this.callbacks.activate();
      } while (
        this.activationRequested &&
        !this.controller.signal.aborted &&
        this.callbacks.gate()
      );
    })().finally(() => {
      this.activationFlight = undefined;
    });
    return this.activationFlight;
  }
  stop() {
    this.controller.abort();
    this.crons.forEach((cron) => cron.stop());
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.retryTimer) clearInterval(this.retryTimer);
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
  }
  async drained() {
    await Promise.allSettled([
      ...this.pending,
      ...(this.activationFlight ? [this.activationFlight] : []),
    ]);
  }
}

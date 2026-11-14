import { Cron } from 'croner';
import { ENTRY_RECOVERY_TICK_MS } from '../config/constants.js';

export interface SchedulerCallbacks {
  gate(): boolean;
  verify(): Promise<unknown>;
  bootstrap(): Promise<void>;
  poll(signal: AbortSignal): Promise<void>;
  recoverEntries(signal: AbortSignal): Promise<void>;
  resumeWindows(): Promise<void>;
  reconcileFeeds(): Promise<void>;
  activate(): Promise<void>;
  summaries(): Promise<void>;
  digest(jobId: string, occurrence: Date): Promise<void>;
  failed(operation: string): void;
}
/** Owns cross-module time/event delivery. Module callbacks own transactions. */
export class Scheduler {
  private readonly controller = new AbortController();
  private readonly crons: Cron[] = [];
  private pollTimer?: ReturnType<typeof setInterval>;
  private retryTimer?: ReturnType<typeof setInterval>;
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private activationFlight?: Promise<void>;
  private activationRequested = false;
  private polling = false;
  private startupFlight?: Promise<void>;
  private initialized = false;
  private readonly pending = new Set<Promise<void>>();
  constructor(
    private readonly callbacks: SchedulerCallbacks,
    private readonly config: {
      pollIntervalMs: number;
      summaryCron: string | null;
      digestCrons: Array<{ id: string; cron: string }>;
    },
  ) {}
  private run(operation: string, work: () => Promise<void>): void {
    if (this.controller.signal.aborted) return;
    const promise = work()
      .catch(() => this.callbacks.failed(operation))
      .finally(() => this.pending.delete(promise));
    this.pending.add(promise);
  }
  start(): void {
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
  recovered(): void {
    this.run('recovery', async () => {
      await this.initialize();
      await this.callbacks.reconcileFeeds();
      await this.requestActivation();
    });
  }
  private async poll(): Promise<void> {
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
  requestActivation(): Promise<void> {
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
  stop(): void {
    this.controller.abort();
    this.crons.forEach((cron) => cron.stop());
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.retryTimer) clearInterval(this.retryTimer);
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
  }
  async drained(): Promise<void> {
    await Promise.allSettled([
      ...this.pending,
      ...(this.activationFlight ? [this.activationFlight] : []),
    ]);
  }
}

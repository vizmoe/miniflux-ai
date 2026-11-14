import { setTimeout as delay } from 'node:timers/promises';
import type { Repository, Task } from '../db/repository.js';
import type { TaskType } from '../db/documents.js';
import { digestStats } from '../ai/stats.js';
import type { CallStat } from '../ai/client.js';
import { LeaseLost, safeWorkError, WorkError } from '../obs/errors.js';

export interface TaskContext {
  signal: AbortSignal;
  assertOwned(): void;
  calls: CallStat[];
}
export type TaskHandler = (task: Task, context: TaskContext) => Promise<void>;
export class Queue {
  private readonly active = new Map<
    number,
    {
      task: Task;
      controller: AbortController;
      promise: Promise<void>;
      renew: ReturnType<typeof setInterval>;
      calls: CallStat[];
    }
  >();
  private claimTimer?: ReturnType<typeof setInterval>;
  private reaperTimer?: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(
    private readonly repository: Repository,
    private readonly handlers: Record<TaskType, TaskHandler>,
    private readonly options: {
      concurrency: number;
      leaseMs: number;
      gate: () => boolean;
      terminal: () => void;
      observe?: (task: Task, outcome: string, durationMs: number) => void;
    },
  ) {}
  start(): void {
    this.stopped = false;
    this.claimTimer = setInterval(() => this.tick(), 100);
    this.reaperTimer = setInterval(
      () => {
        try {
          const count = this.repository.reap();
          if (count) this.options.terminal();
        } catch {
          /* retry the repository on the next bounded pass */
        }
      },
      Math.max(1, Math.floor(this.options.leaseMs / 3)),
    );
    this.tick();
  }
  tick(): void {
    if (this.stopped || !this.options.gate()) return;
    try {
      while (this.active.size < this.options.concurrency) {
        const task = this.repository.claim(
          this.options.concurrency,
          this.options.leaseMs,
        );
        if (!task) break;
        const controller = new AbortController();
        const calls: CallStat[] = [];
        const renew = setInterval(
          () => {
            try {
              this.repository.renew(task, this.options.leaseMs);
            } catch {
              controller.abort(new LeaseLost());
            }
          },
          Math.max(1, Math.floor(this.options.leaseMs / 3)),
        );
        const promise = this.execute(task, controller, calls)
          .catch(() => {
            // A repository/observer failure after settlement must not escape the
            // worker loop. Ownership expiry recovers any still-leased task.
          })
          .finally(() => {
            clearInterval(renew);
            this.active.delete(task.id);
          });
        this.active.set(task.id, { task, controller, calls, renew, promise });
      }
    } catch {
      /* a failed claim consumes no attempt; the transaction has rolled back */
    }
  }
  private dispatch(task: Task, context: TaskContext): Promise<void> {
    switch (task.type) {
      case 'generate_artifacts':
        return this.handlers.generate_artifacts(task, context);
      case 'render':
        return this.handlers.render(task, context);
      case 'digest':
        return this.handlers.digest(task, context);
      case 'ingest_backfill':
        return this.handlers.ingest_backfill(task, context);
    }
  }
  private async execute(
    task: Task,
    controller: AbortController,
    calls: CallStat[],
  ): Promise<void> {
    const start = Date.now();
    try {
      await this.dispatch(task, {
        signal: controller.signal,
        calls,
        assertOwned: () => {
          controller.signal.throwIfAborted();
          this.repository.assertOwner(task);
        },
      });
    } catch (error) {
      if (!(error instanceof LeaseLost) && !controller.signal.aborted) {
        try {
          this.repository.settle(
            task,
            safeWorkError(error),
            task.type === 'digest' ? digestStats(calls) : undefined,
          );
        } catch {
          controller.abort(new LeaseLost());
        }
      }
    } finally {
      if (!controller.signal.aborted) {
        const current = this.repository.task(task.id);
        if (current?.state === 'done' || current?.state === 'dead')
          this.options.terminal();
        if (current)
          this.options.observe?.(current, current.state, Date.now() - start);
      }
    }
  }
  async idle(): Promise<void> {
    await Promise.all([...this.active.values()].map((v) => v.promise));
  }
  async stop(graceMs: number): Promise<void> {
    this.stopped = true;
    if (this.claimTimer) clearInterval(this.claimTimer);
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    const timeout = new AbortController();
    await Promise.race([
      this.idle(),
      delay(graceMs, undefined, { signal: timeout.signal }).catch(() => {}),
    ]);
    timeout.abort();
    for (const item of this.active.values()) {
      clearInterval(item.renew);
      item.controller.abort(new LeaseLost());
      try {
        this.repository.settle(
          item.task,
          new WorkError('worker_released', 'timeout', true),
          item.task.type === 'digest' ? digestStats(item.calls) : undefined,
        );
      } catch {
        /* already completed or lost */
      }
    }
  }
}

import { setTimeout as delay } from 'node:timers/promises';
export interface WorkOrder {
  priority: number;
  created_at: number;
  id: number;
}
type Release = () => void;
interface Waiter {
  order: WorkOrder;
  sequence: number;
  resolve: (release: Release) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  abort: () => void;
}
const defaultOrder = Object.freeze({
  priority: 0,
  created_at: 0,
  id: 0,
});
export class PrioritySemaphore {
  capacity;
  active = 0;
  sequence = 0;
  waiting: Waiter[] = [];
  constructor(capacity: number) {
    this.capacity = capacity;
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new Error('invalid_capacity');
  }
  acquire(
    order: WorkOrder = defaultOrder,
    signal?: AbortSignal,
  ): Promise<Release> {
    signal?.throwIfAborted();
    return new Promise<Release>((resolve, reject) => {
      const waiter = {
        order,
        sequence: this.sequence++,
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        },
      };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.waiting.push(waiter);
      this.waiting.sort(
        (a, b) =>
          b.order.priority - a.order.priority ||
          a.order.created_at - b.order.created_at ||
          a.order.id - b.order.id ||
          a.sequence - b.sequence,
      );
      this.drain();
    });
  }
  drain() {
    while (this.active < this.capacity && this.waiting.length) {
      const next = this.waiting.shift()!;
      next.signal?.removeEventListener('abort', next.abort);
      this.active++;
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.drain();
      });
    }
  }
  async use<T>(
    operation: () => T | Promise<T>,
    order?: WorkOrder,
    signal?: AbortSignal,
  ): Promise<T> {
    const release = await this.acquire(order, signal);
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      release();
    }
  }
}
export class EntryLock {
  locks = new Map<number, { semaphore: PrioritySemaphore; users: number }>();
  async with<T>(
    entryId: number,
    operation: () => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const slot = this.locks.get(entryId) ?? {
      semaphore: new PrioritySemaphore(1),
      users: 0,
    };
    this.locks.set(entryId, slot);
    slot.users++;
    try {
      return await slot.semaphore.use(
        async () => operation(),
        undefined,
        signal,
      );
    } finally {
      if (--slot.users === 0) this.locks.delete(entryId);
    }
  }
}
/** Start-rate limiter: waiting for a permit never occupies an HTTP socket. */
export class RequestLimiter {
  perSecond;
  nextStart = 0;
  startLock = new PrioritySemaphore(1);
  concurrent;
  constructor(concurrency: number, perSecond: number) {
    this.perSecond = perSecond;
    this.concurrent = new PrioritySemaphore(concurrency);
  }
  async run<T>(
    operation: () => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.concurrent.use(
      async () => {
        const release = await this.startLock.acquire(undefined, signal);
        try {
          while (this.nextStart > performance.now())
            await delay(
              Math.ceil(this.nextStart - performance.now()),
              undefined,
              {
                signal,
              },
            );
          signal?.throwIfAborted();
          try {
            // Invoke while holding the start permit, without waiting for the response.
            return operation();
          } finally {
            // A monotonic deadline also accounts for synchronous request preparation.
            this.nextStart = performance.now() + 1000 / this.perSecond;
          }
        } finally {
          release();
        }
      },
      undefined,
      signal,
    );
  }
}

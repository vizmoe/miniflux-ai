import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PrioritySemaphore,
  EntryLock,
  RequestLimiter,
} from '../src/runtime/concurrency.js';
import { Scheduler } from '../src/scheduler/index.js';
import type { SchedulerCallbacks } from '../src/scheduler/index.js';
import { Queue } from '../src/queue/index.js';
import type { TaskHandler } from '../src/queue/index.js';
import { BindingController } from '../src/miniflux/binding.js';
import { MinifluxClient, retryAfter } from '../src/miniflux/client.js';
import { retrySnapshot } from '../src/config/snapshots.js';
import { WorkError } from '../src/obs/errors.js';
import {
  compact,
  config,
  FakeUpstream,
  response,
  temporaryRepository,
} from './helpers.js';

const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.useRealTimers();
});
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function callbacks(): SchedulerCallbacks {
  return {
    recoverEntries: vi.fn(async () => {}),
    gate: vi.fn(() => true),
    verify: vi.fn(async () => {}),
    bootstrap: vi.fn(async () => {}),
    poll: vi.fn(async () => {}),
    resumeWindows: vi.fn(async () => {}),
    reconcileFeeds: vi.fn(async () => {}),
    activate: vi.fn(async () => {}),
    summaries: vi.fn(async () => {}),
    digest: vi.fn(async () => {}),
    failed: vi.fn(),
  };
}
describe('global concurrency and shutdown', () => {
  it('uses priority and task age for waiters, removes aborted waits and releases once', async () => {
    const semaphore = new PrioritySemaphore(1),
      events: number[] = [],
      release = await semaphore.acquire();
    const pending = [3, 2, 1].map((id) =>
      semaphore.use(
        async () => {
          events.push(id);
        },
        { id, priority: id === 3 ? 0 : 100, created_at: id },
      ),
    );
    const abort = new AbortController(),
      cancelled = semaphore.acquire(undefined, abort.signal);
    abort.abort(new Error('cancelled'));
    await expect(cancelled).rejects.toThrow('cancelled');
    release();
    release();
    await Promise.all(pending);
    expect(events).toEqual([1, 2, 3]);
    expect(() => new PrioritySemaphore(0)).toThrow();
    const lock = new EntryLock(),
      gate = deferred(),
      order: string[] = [];
    const first = lock.with(1, async () => {
        order.push('first');
        await gate.promise;
      }),
      second = lock.with(1, () => {
        order.push('second');
      }),
      other = lock.with(2, () => {
        order.push('other');
      });
    await other;
    expect(order).toEqual(['first', 'other']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order.at(-1)).toBe('second');
  });
  it('limits HTTP starts globally and aborts delayed requests', async () => {
    const limiter = new RequestLimiter(4, 20),
      starts: number[] = [];
    const calls = [1, 2, 3].map(() =>
      limiter.run(async () => {
        starts.push(performance.now());
      }),
    );
    await Promise.all(calls);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(50);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(50);
    const abort = new AbortController(),
      cancelled = limiter.run(async () => {}, abort.signal);
    const rejected = expect(cancelled).rejects.toThrow();
    abort.abort();
    await rejected;
  });
  it('paces overlapping requests across forward and backward wall-clock jumps', async () => {
    const limiter = new RequestLimiter(4, 20),
      gate = deferred(),
      started = deferred(),
      starts: number[] = [];
    let wallTime = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => wallTime);
    closers.push(
      () => clock.mockRestore(),
      () => gate.resolve(),
    );
    const first = limiter.run(async () => {
      starts.push(performance.now());
      started.resolve();
      await gate.promise;
    });
    await started.promise;
    const signal = AbortSignal.timeout(5000);
    wallTime += 3600000;
    await limiter.run(async () => {
      starts.push(performance.now());
    }, signal);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(50);
    wallTime -= 7200000;
    await limiter.run(async () => {
      starts.push(performance.now());
    }, signal);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(50);
    gate.resolve();
    await first;
  });
  it('aborts lost owners, recovers expired work, and survives repository faults', async () => {
    const f = temporaryRepository();
    closers.push(() => f.close());
    f.repository.insertEntry(compact());
    const policy = retrySnapshot(
      config('queue:\n  retry:\n    max_attempts: 1\n'),
    );
    const task = f.repository.requestRender(1, policy),
      done = deferred(),
      terminal = vi.fn();
    const handler: TaskHandler = async (_task, context) => {
      await new Promise<void>((resolve) =>
        context.signal.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      );
      done.resolve();
      context.assertOwned();
    };
    const queue = new Queue(
      f.repository,
      {
        render: handler,
        generate_artifacts: handler,
        digest: handler,
        ingest_backfill: handler,
      },
      { concurrency: 2, leaseMs: 15, gate: () => true, terminal },
    );
    closers.push(() => queue.stop(0));
    vi.spyOn(f.repository, 'renew').mockImplementation(() => {
      throw new Error('lost connection');
    });
    const claim = vi.spyOn(f.repository, 'claim');
    claim.mockImplementationOnce(() => {
      throw new Error('claim fault');
    });
    queue.tick();
    expect(f.repository.task(task.id)!.attempts).toBe(0);
    const reap = vi.spyOn(f.repository, 'reap');
    reap.mockImplementationOnce(() => {
      throw new Error('temporary repository failure');
    });
    queue.start();
    await done.promise;
    await queue.idle();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.repository.task(task.id)).toMatchObject({
      state: 'dead',
      last_error: { code: 'lease_expired' },
    });
    expect(terminal).toHaveBeenCalled();
  });
  it('contains post-handler observation faults and leaves unsettled work recoverable', async () => {
    const f = temporaryRepository();
    closers.push(() => f.close());
    f.repository.insertEntry(compact());
    const task = f.repository.requestRender(1, retrySnapshot(config()));
    const handler: TaskHandler = async () => {
      throw new Error('unexpected failure');
    };
    const queue = new Queue(
      f.repository,
      {
        render: handler,
        generate_artifacts: handler,
        digest: handler,
        ingest_backfill: handler,
      },
      {
        concurrency: 2,
        leaseMs: 1000,
        gate: () => true,
        terminal: () => {},
        observe: () => {
          throw new Error('observer failed');
        },
      },
    );
    closers.push(() => queue.stop(0));
    queue.tick();
    await queue.idle();
    expect(f.repository.task(task.id)!.state).toBe('pending');
    f.db.run('UPDATE tasks SET run_after=0 WHERE id=?', task.id);
    vi.spyOn(f.repository, 'settle').mockImplementationOnce(() => {
      throw new Error('repository temporarily unavailable');
    });
    queue.tick();
    await queue.idle();
    expect(f.repository.task(task.id)!.state).toBe('leased');
  });
  it('settles failed handlers, renews ownership, notifies terminal transitions and releases at shutdown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const f = temporaryRepository();
    closers.push(() => f.close());
    f.repository.insertEntry(compact());
    const c = config('queue:\n  retry:\n    max_attempts: 1\n');
    const task = f.repository.requestRender(1, retrySnapshot(c));
    let gate = false;
    const terminal = vi.fn(),
      observe = vi.fn();
    const fail: TaskHandler = async (_task, context) => {
      context.assertOwned();
      throw new WorkError('test_failure', 'validation', false);
    };
    const queue = new Queue(
      f.repository,
      {
        render: fail,
        generate_artifacts: fail,
        digest: fail,
        ingest_backfill: fail,
      },
      { concurrency: 2, leaseMs: 30, gate: () => gate, terminal, observe },
    );
    closers.push(() => queue.stop(0));
    queue.tick();
    expect(f.repository.task(task.id)!.attempts).toBe(0);
    gate = true;
    queue.start();
    await queue.idle();
    expect(f.repository.task(task.id)!.state).toBe('dead');
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalled();
    await queue.stop(0);
    const next = f.repository.requestRender(1, retrySnapshot(c)),
      waiting = deferred();
    const wait: TaskHandler = async () => waiting.promise;
    const active = new Queue(
      f.repository,
      {
        render: wait,
        generate_artifacts: wait,
        digest: wait,
        ingest_backfill: wait,
      },
      { concurrency: 2, leaseMs: 30, gate: () => true, terminal },
    );
    closers.push(() => active.stop(0));
    active.tick();
    await vi.advanceTimersByTimeAsync(45);
    expect(f.repository.task(next.id)!.lease_expires_at!).toBeGreaterThan(
      Date.now(),
    );
    await active.stop(0);
    waiting.resolve();
    await active.idle();
    expect(f.repository.task(next.id)).toMatchObject({
      attempts: 1,
      state: 'dead',
      lease_owner: null,
    });
  });
});
describe('single Scheduler owns startup, UTC cron and event delivery', () => {
  it.each(['0 0 * * *', '0/60 0/24 * * *'])(
    'admits %s and polls after bootstrap while Output feeds are still initializing',
    async (cron) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-03T23:59:59Z'));
      const cb = callbacks(),
        feed = deferred();
      cb.reconcileFeeds = vi.fn(async () => feed.promise);
      const scheduler = new Scheduler(cb, {
        pollIntervalMs: 500,
        summaryCron: cron,
        digestCrons: [{ id: 'daily', cron }],
      });
      closers.push(async () => {
        feed.resolve();
        scheduler.stop();
        await scheduler.drained();
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(1001);
      expect(cb.bootstrap).toHaveBeenCalledTimes(1);
      expect(cb.poll).toHaveBeenCalledTimes(1);
      expect(cb.summaries).toHaveBeenCalledTimes(1);
      expect(cb.digest).toHaveBeenCalledExactlyOnceWith(
        'daily',
        new Date('2026-09-04T00:00:00Z'),
      );
      feed.resolve();
      await scheduler.drained();
    },
  );
  it.each(['America/New_York', 'Asia/Tokyo', 'UTC'])(
    'fires identical UTC occurrences under %s without historical catchup',
    async (timezone) => {
      const old = process.env.TZ;
      process.env.TZ = timezone;
      closers.push(() => {
        process.env.TZ = old;
      });
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-03T23:59:59Z'));
      const cb = callbacks(),
        scheduler = new Scheduler(cb, {
          pollIntervalMs: 10000,
          summaryCron: '0 0 * * *',
          digestCrons: [{ id: 'daily', cron: '0 0 * * *' }],
        });
      closers.push(async () => {
        scheduler.stop();
        await scheduler.drained();
      });
      scheduler.start();
      await scheduler.initialize();
      expect(cb.digest).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1001);
      expect(cb.digest).toHaveBeenCalledExactlyOnceWith(
        'daily',
        new Date('2026-09-04T00:00:00Z'),
      );
      expect(cb.summaries).toHaveBeenCalledTimes(1);
      expect(cb.resumeWindows).toHaveBeenCalledTimes(1);
      scheduler.stop();
      await vi.advanceTimersByTimeAsync(86400000);
      expect(cb.digest).toHaveBeenCalledTimes(1);
    },
  );
  it('coalesces activation requests into one follow-up pass and suppresses overlapping polls', async () => {
    vi.useFakeTimers();
    const cb = callbacks(),
      activation = deferred(),
      polling = deferred();
    let passes = 0;
    cb.activate = vi.fn(async () => {
      if (++passes === 1) await activation.promise;
    });
    cb.poll = vi.fn(async () => polling.promise);
    const scheduler = new Scheduler(cb, {
      pollIntervalMs: 10,
      summaryCron: null,
      digestCrons: [],
    });
    closers.push(async () => {
      activation.resolve();
      polling.resolve();
      scheduler.stop();
      await scheduler.drained();
    });
    const initial = scheduler.requestActivation();
    void scheduler.requestActivation();
    void scheduler.requestActivation();
    expect(passes).toBe(1);
    activation.resolve();
    await initial;
    expect(passes).toBe(2);
    scheduler.start();
    await scheduler.initialize();
    await vi.advanceTimersByTimeAsync(35);
    expect(cb.poll).toHaveBeenCalledTimes(1);
    polling.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(cb.poll).toHaveBeenCalledTimes(2);
  });
  it('retries initialization after failure and obeys the account gate during recovery', async () => {
    vi.useFakeTimers();
    const cb = callbacks();
    let open = false;
    cb.gate = () => open;
    const scheduler = new Scheduler(cb, {
      pollIntervalMs: 100000,
      summaryCron: null,
      digestCrons: [],
    });
    closers.push(async () => {
      scheduler.stop();
      await scheduler.drained();
    });
    scheduler.start();
    await scheduler.initialize();
    expect(cb.bootstrap).not.toHaveBeenCalled();
    expect(cb.activate).not.toHaveBeenCalled();
    open = true;
    cb.bootstrap = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue(undefined);
    scheduler.recovered();
    await scheduler.drained();
    expect(cb.failed).toHaveBeenCalledWith('recovery');
    await vi.advanceTimersByTimeAsync(60000);
    expect(cb.resumeWindows).toHaveBeenCalledTimes(1);
    expect(cb.activate).toHaveBeenCalled();
    scheduler.recovered();
    await scheduler.drained();
    expect(cb.reconcileFeeds).toHaveBeenCalledTimes(2);
  });
});
describe('account-bound Miniflux authority', () => {
  function setup() {
    const f = temporaryRepository();
    closers.push(() => f.close());
    const upstream = new FakeUpstream(),
      client = new MinifluxClient(
        { ...config().miniflux, max_requests_per_second: 100000 },
        upstream.fetch,
      );
    return { ...f, upstream, client };
  }
  it('coalesces probes, caches only success, and pauses admission during probe failures', async () => {
    let now = 1;
    const f = setup(),
      controller = new BindingController(
        f.repository,
        f.client,
        'https://miniflux.test',
        () => {},
        () => now,
      );
    closers.push(() => controller.stop());
    expect(controller.state).toBe('unbound');
    expect(() => controller.requireOpen()).toThrow();
    await Promise.all([
      controller.check(),
      controller.check(),
      controller.check(),
    ]);
    expect(controller.state).toBe('verified');
    expect(f.upstream.requests).toHaveLength(2);
    await controller.check();
    expect(f.upstream.requests).toHaveLength(2);
    now += 60001;
    f.upstream.intercept = (url) =>
      url.pathname === '/v1/version' ? response({}, 503) : undefined;
    expect((await controller.check()).ready).toBe(false);
    expect(controller.open).toBe(false);
    await controller.check();
    expect(f.upstream.requests).toHaveLength(4);
    f.upstream.intercept = undefined;
    expect((await controller.check()).ready).toBe(true);
    expect(controller.open).toBe(true);
    const rotation = new BindingController(
      f.repository,
      f.client,
      'https://miniflux.test',
    );
    closers.push(() => rotation.stop());
    expect((await rotation.check()).ready).toBe(true);
  });
  it('blocks a changed numeric account and requires explicit base-address CAS confirmation', async () => {
    const f = setup();
    f.repository.bind({
      schema_version: 1,
      base_url: 'https://old.test',
      user_id: 1,
    });
    const changed = new BindingController(
      f.repository,
      f.client,
      'https://miniflux.test',
    );
    closers.push(() => changed.stop());
    expect((await changed.check()).reason).toBe(
      'miniflux_base_url_confirmation_required',
    );
    expect(f.upstream.requests).toHaveLength(0);
    await expect(changed.confirm('https://wrong.test')).rejects.toThrow(
      'miniflux_binding_conflict',
    );
    await expect(changed.confirm('not a URL')).rejects.toThrow(
      'invalid_base_url',
    );
    expect(f.upstream.requests).toHaveLength(0);
    await changed.confirm('https://miniflux.test/');
    expect(changed.open).toBe(true);
    expect(f.repository.binding()!.base_url).toBe('https://miniflux.test');
    f.upstream.userId = 2;
    const other = new BindingController(
      f.repository,
      f.client,
      'https://miniflux.test',
    );
    closers.push(() => other.stop());
    expect((await other.check()).reason).toBe('miniflux_account_mismatch');
    expect(other.state).toBe('account_mismatch');
    await expect(other.confirm('https://miniflux.test')).rejects.toThrow(
      'miniflux_base_url_confirmation_not_required',
    );
  });
  it.each(['2.2.17', '2.3.2', '2.3.4', '3.0.0', '2.3.3-rc.1', 'bad-version'])(
    'keeps the gate closed for version %s',
    async (version) => {
      const f = setup();
      f.upstream.version = version;
      const controller = new BindingController(
        f.repository,
        f.client,
        'https://miniflux.test',
      );
      closers.push(() => controller.stop());
      expect((await controller.check()).ready).toBe(false);
      expect(controller.open).toBe(false);
      expect(f.repository.binding()).toBeUndefined();
      expect(f.upstream.requests).toHaveLength(1);
    },
  );
  it('accepts supported additive fields, validates identities and parses Retry-After bounds', async () => {
    const f = setup();
    f.upstream.version = '2.3.3';
    expect(await f.client.version()).toBe('2.3.3');
    f.upstream.intercept = () =>
      response({ id: 2, feed_id: 1, title: '', content: '' });
    await expect(f.client.getEntry(1)).rejects.toThrow(
      'miniflux_invalid_response',
    );
    expect(retryAfter('12', 0)).toBe(12000);
    expect(retryAfter('Thu, 01 Jan 1970 00:00:12 GMT', 1000)).toBe(11000);
    expect(retryAfter('invalid')).toBe(0);
    expect(retryAfter(null)).toBe(0);
  });
});

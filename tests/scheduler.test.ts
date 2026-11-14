import { expect, it, vi } from 'vitest';
import { Scheduler } from '../src/scheduler/index.js';

it('delivers UTC cron occurrences, honors the readiness gate, and stops scheduling', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-14T07:59:59Z'));
  let ready = true;
  const callbacks = {
    gate: () => ready,
    verify: vi.fn(async () => {}),
    bootstrap: vi.fn(async () => {}),
    poll: vi.fn(async () => {}),
    recoverEntries: vi.fn(async () => {}),
    resumeWindows: vi.fn(async () => {}),
    reconcileFeeds: vi.fn(async () => {}),
    activate: vi.fn(async () => {}),
    summaries: vi.fn(async () => {}),
    digest: vi.fn(async (_id: string, _occurrence: Date) => {}),
    failed: vi.fn(),
  };
  const scheduler = new Scheduler(callbacks, {
    pollIntervalMs: 3_600_000,
    summaryCron: '0 8 * * *',
    digestCrons: [{ id: 'daily', cron: '* * * * *' }],
  });
  try {
    scheduler.start();
    await scheduler.initialize();
    await vi.advanceTimersByTimeAsync(1000);
    expect(callbacks.summaries).toHaveBeenCalledTimes(1);
    expect(callbacks.digest.mock.calls).toEqual([
      ['daily', new Date('2026-11-14T08:00:00Z')],
    ]);
    ready = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callbacks.digest).toHaveBeenCalledTimes(1);
    ready = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callbacks.digest.mock.calls[1]).toEqual([
      'daily',
      new Date('2026-11-14T08:02:00Z'),
    ]);
    scheduler.stop();
    await scheduler.drained();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callbacks.digest).toHaveBeenCalledTimes(2);
    expect(callbacks.summaries).toHaveBeenCalledTimes(1);
    expect(callbacks.failed).not.toHaveBeenCalled();
  } finally {
    scheduler.stop();
    vi.useRealTimers();
  }
});

import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Config } from '../config/index.js';
import {
  ENTRY_RECOVERY_BATCH_SIZE,
  ENTRY_RECOVERY_RECHECK_MS,
  LANGUAGE_REVIEW_BATCH_TIMEOUT_MS,
} from '../config/constants.js';
import { aiSnapshot, retrySnapshot } from '../config/snapshots.js';
import { safeId } from '../config/primitives.js';
import type { Repository } from '../db/repository.js';
import type { Entry } from '../db/schema.js';
import type { MinifluxClient, StoredEntry } from '../miniflux/client.js';
import type { MinifluxSourceReader } from '../source/index.js';
import { assertSourceCurrent } from '../source/index.js';
import type { LastError } from '../db/documents.js';
import { BlockPlanMismatch, compose } from '../html/composition.js';
import { extractSemanticBlocks } from '../html/blocks.js';
import { parseSource } from '../html/dom.js';
import { canonicalSanitizerTree } from '../html/minifluxSanitizer.js';
import type { LanguageAnalyzer } from '../lang/review.js';
import { ApiError, safeWorkError } from '../obs/errors.js';
import type { AdmissionPolicy } from './admission.js';
import type { EntryLock } from './concurrency.js';

const storedSchema = z.object({
  id: safeId,
  feed_id: safeId,
  title: z.string(),
  content: z.string(),
});
type Inspection = Awaited<ReturnType<MinifluxSourceReader['inspect']>>;
export type RecoveryOutcome =
  'unchanged' | 'restored' | 'regenerated' | 'busy' | 'missing' | 'failed';

/** Reconciles only Entries we already own; never changes a Feed or fetches a page. */
export class EntryRecovery {
  private flight?: Promise<void>;
  private readonly controller = new AbortController();
  readonly status = {
    checked: 0,
    restored: 0,
    regenerated: 0,
    failed: 0,
    last_scan_at: null as number | null,
  };
  constructor(
    private readonly repository: Repository,
    private readonly client: MinifluxClient,
    private readonly source: MinifluxSourceReader,
    private readonly detector: LanguageAnalyzer,
    private readonly admission: AdmissionPolicy,
    private readonly lock: EntryLock,
    private readonly config: Config,
    private readonly gate: () => boolean,
    private readonly observe: (
      id: number,
      outcome: RecoveryOutcome,
      error?: LastError,
    ) => void = () => {},
  ) {}
  stop(): void {
    this.controller.abort();
  }
  async drained(): Promise<void> {
    await this.flight;
  }
  scan(signal?: AbortSignal): Promise<void> {
    if (this.flight) return this.flight;
    this.flight = this.scanBatch(signal).finally(() => {
      this.flight = undefined;
    });
    return this.flight;
  }
  private async scanBatch(signal?: AbortSignal): Promise<void> {
    if (!this.gate()) return;
    signal = AbortSignal.any([
      this.controller.signal,
      ...(signal ? [signal] : []),
    ]);
    signal.throwIfAborted();
    const entries = this.repository.recoveryCandidates(
      this.repository.now() - ENTRY_RECOVERY_RECHECK_MS,
      ENTRY_RECOVERY_BATCH_SIZE,
    );
    if (!entries.length) return;
    const ids = entries.map((e) => e.entry_id),
      min = Math.min(...ids),
      max = Math.max(...ids);
    // A bounded range read amortizes API cost for dense IDs. Sparse ranges and
    // deleted Entries fall back to individual reads; absence in a page is not 404.
    const page = await this.client.entries(
      {
        order: 'id',
        direction: 'asc',
        after_entry_id: min - 1,
        ...(max < Number.MAX_SAFE_INTEGER ? { before_entry_id: max + 1 } : {}),
        limit: ENTRY_RECOVERY_BATCH_SIZE,
      },
      signal,
    );
    const snapshots = new Map<number, StoredEntry>();
    for (const raw of page) {
      const parsed = storedSchema.safeParse(raw);
      if (parsed.success && ids.includes(parsed.data.id))
        snapshots.set(parsed.data.id, parsed.data);
    }
    for (const entry of entries) {
      signal.throwIfAborted();
      if (!this.gate()) break;
      await this.check(entry.entry_id, signal, snapshots.get(entry.entry_id));
    }
    this.status.last_scan_at = this.repository.now();
  }
  private decision(
    entry: Entry,
    inspection: Inspection,
  ): 'unchanged' | 'restored' | 'regenerated' {
    const artifacts = this.repository.currentArtifacts(entry.entry_id);
    if (
      entry.source_fingerprint &&
      entry.source_fingerprint !== inspection.fingerprint
    )
      return 'regenerated';
    if (
      !entry.source_fingerprint &&
      (inspection.source.title !== entry.source_title ||
        !artifacts.some((a) => a.kind === 'translation'))
    )
      return 'regenerated';
    try {
      const proposal = compose(inspection.source, artifacts);
      return proposal.title === inspection.stored.title &&
        isDeepStrictEqual(
          canonicalSanitizerTree(parseSource(proposal.content)),
          canonicalSanitizerTree(parseSource(inspection.stored.content)),
        )
        ? 'unchanged'
        : 'restored';
    } catch (error) {
      if (error instanceof BlockPlanMismatch) return 'regenerated';
      throw error;
    }
  }
  async check(
    id: number,
    signal?: AbortSignal,
    snapshot?: StoredEntry,
  ): Promise<RecoveryOutcome> {
    signal = AbortSignal.any([
      this.controller.signal,
      ...(signal ? [signal] : []),
    ]);
    if (!this.gate()) throw new ApiError(503, 'ingestion_not_ready');
    return this.lock.with(
      id,
      async () => {
        let outcome: RecoveryOutcome;
        let failure: LastError | undefined;
        try {
          const entry = this.repository.entry(id);
          if (!entry) throw new ApiError(404, 'entry_not_found');
          let inspected = await this.source.inspect(id, snapshot, signal);
          let decision = this.decision(entry, inspected);
          // A batch response can predate a concurrent Write-back. Re-read under
          // the shared Entry lock before scheduling any correction.
          if (decision !== 'unchanged' && snapshot) {
            inspected = await this.source.inspect(id, undefined, signal);
            decision = this.decision(entry, inspected);
          }
          signal.throwIfAborted();
          if (!this.gate()) throw new ApiError(503, 'ingestion_not_ready');
          outcome = await this.applyDecision(
            entry,
            inspected,
            decision,
            signal,
          );
        } catch (error) {
          if (signal.aborted || !this.gate()) throw error;
          failure = safeWorkError(error).detail;
          outcome =
            failure.failure_class === 'not_found' ? 'missing' : 'failed';
        }
        this.repository.checkedEntry(id, outcome);
        this.status.checked++;
        if (
          outcome === 'restored' ||
          outcome === 'regenerated' ||
          outcome === 'failed'
        )
          this.status[outcome]++;
        this.observe(id, outcome, failure);
        return outcome;
      },
      signal,
    );
  }
  private async applyDecision(
    entry: Entry,
    inspected: Inspection,
    decision: 'unchanged' | 'restored' | 'regenerated',
    signal: AbortSignal,
  ): Promise<RecoveryOutcome> {
    if (decision === 'regenerated') {
      await this.regenerate(entry, inspected, signal);
      return decision;
    }
    this.repository.establishSourceFingerprint(
      entry.entry_id,
      inspected.fingerprint,
    );
    if (decision === 'restored') {
      if (this.repository.activeRender(entry.entry_id)) return 'busy';
      this.repository.requestRender(entry.entry_id, retrySnapshot(this.config));
    }
    return decision;
  }
  private async regenerate(
    entry: Entry,
    inspected: Inspection,
    signal: AbortSignal,
  ): Promise<void> {
    const plan = extractSemanticBlocks(parseSource(inspected.source.content));
    const evidence = this.detector.prepare(inspected.source.title, plan.blocks);
    const language = await this.detector.resolve(
      evidence,
      aiSnapshot(),
      entry.entry_id,
      signal,
      AbortSignal.timeout(LANGUAGE_REVIEW_BATCH_TIMEOUT_MS),
    );
    signal.throwIfAborted();
    if (!this.gate()) throw new ApiError(503, 'ingestion_not_ready');
    const current = await this.source.inspect(
      entry.entry_id,
      undefined,
      signal,
    );
    assertSourceCurrent(inspected.fingerprint, current.source);
    const facts = {
      source_title: inspected.source.title,
      source_content_units: plan.sourceContentUnits,
      primary_language: language.primaryLanguage,
      language_confidence: language.languageConfidence,
    };
    const admission = this.admission.plan(
      { ...entry, ...facts },
      plan.blocks.length,
      undefined,
      { force: true },
    );
    this.repository.db.transaction(() => {
      this.repository.refreshSource(
        entry.entry_id,
        facts,
        inspected.fingerprint,
      );
      this.admission.apply(this.repository, entry.entry_id, admission);
      if (
        !current.markers.length &&
        current.stored.title === current.source.title
      )
        // The latest GET already confirms the empty composition. Old Render
        // ownership was revoked above; this acknowledges it without a PUT.
        this.repository.acknowledgeSourceOnly(
          entry.entry_id,
          current.stored.title,
        );
      else
        // Also remove obsolete output when all Features now skip or deny.
        this.repository.requestRender(
          entry.entry_id,
          retrySnapshot(this.config),
        );
    });
  }
}

import type { Repository } from '../db/repository.js';
import type { MinifluxClient } from './client.js';
import type { Binding } from '../db/types.js';
export interface BindingStatus {
  ready: boolean;
  reason: string | null;
  version: string | null;
}
import {
  MINIFLUX_SUPPORTED_VERSION,
  MINIFLUX_VERSION_PROBE_TTL,
} from '../config/constants.js';
import { normalizeBaseUrl } from '../config/primitives.js';
import { ApiError, WorkError } from '../obs/errors.js';
function bindingFailure(error: unknown) {
  if (error instanceof ApiError) return error.code;
  if (error instanceof WorkError) return error.detail.code;
  return 'repository_unavailable';
}
export class BindingController {
  repository;
  client;
  baseUrl;
  recovered;
  now;
  verified = false;
  cache?: { at: number; status: BindingStatus };
  inFlight?: Promise<BindingStatus>;
  timer?: NodeJS.Timeout;
  stopped = false;
  controller = new AbortController();
  constructor(
    repository: Repository,
    client: MinifluxClient,
    baseUrl: string,
    recovered = () => {},
    now = Date.now,
  ) {
    this.repository = repository;
    this.client = client;
    this.baseUrl = baseUrl;
    this.recovered = recovered;
    this.now = now;
  }
  get open() {
    return this.verified && !this.stopped;
  }
  get state() {
    const binding = this.repository.binding();
    if (!binding) return 'unbound';
    if (binding.base_url !== this.baseUrl)
      return 'base_url_confirmation_required';
    if (this.verified) return 'verified';
    return this.lastStatus.reason === 'miniflux_account_mismatch'
      ? 'account_mismatch'
      : 'verifying';
  }
  lastStatus: BindingStatus = {
    ready: false,
    reason: 'miniflux_unavailable',
    version: null,
  };
  async check(): Promise<BindingStatus> {
    if (this.cache && this.now() - this.cache.at < MINIFLUX_VERSION_PROBE_TTL)
      return this.cache.status;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.probe().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }
  async supportedVersion() {
    const version = await this.client.version(this.controller.signal);
    if (version !== MINIFLUX_SUPPORTED_VERSION)
      throw new WorkError(
        'miniflux_version_unsupported',
        'unsupported_version',
        false,
      );
    return version;
  }
  async verifyAccount(stored?: Binding) {
    const userId = await this.client.me(this.controller.signal);
    this.controller.signal.throwIfAborted();
    if (stored && stored.user_id !== userId)
      throw new ApiError(503, 'miniflux_account_mismatch');
    if (!stored)
      this.repository.bind({
        schema_version: 1,
        base_url: this.baseUrl,
        user_id: userId,
      });
    this.verified = true;
  }
  async probe() {
    const wasReady = this.lastStatus.ready;
    try {
      const stored = this.repository.binding();
      if (!this.verified && stored && stored.base_url !== this.baseUrl)
        throw new ApiError(503, 'miniflux_base_url_confirmation_required');
      const version = await this.supportedVersion();
      if (!this.verified) await this.verifyAccount(stored);
      this.lastStatus = { ready: true, reason: null, version };
      this.cache = { status: this.lastStatus, at: this.now() };
      if (!wasReady) this.recovered();
    } catch (error) {
      this.cache = undefined;
      this.lastStatus = {
        ready: false,
        reason: bindingFailure(error),
        version: null,
      };
    }
    if (!this.verified && !this.stopped && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.check().catch(() => {});
      }, MINIFLUX_VERSION_PROBE_TTL);
      this.timer.unref();
    }
    return this.lastStatus;
  }
  requireOpen() {
    if (!this.open)
      throw new ApiError(503, this.lastStatus.reason ?? 'miniflux_unavailable');
  }
  async confirm(url: string) {
    let normalized;
    try {
      normalized = normalizeBaseUrl(url);
    } catch {
      throw new ApiError(400, 'invalid_base_url');
    }
    if (normalized !== this.baseUrl)
      throw new ApiError(409, 'miniflux_binding_conflict');
    const before = this.repository.binding();
    if (!before || before.base_url === this.baseUrl)
      throw new ApiError(409, 'miniflux_base_url_confirmation_not_required');
    try {
      const version = await this.supportedVersion();
      const userId = await this.client.me(this.controller.signal);
      this.controller.signal.throwIfAborted();
      const next: Binding = {
        schema_version: 1,
        base_url: this.baseUrl,
        user_id: userId,
      };
      this.repository.bind(next, before);
      this.verified = true;
      this.lastStatus = { ready: true, reason: null, version };
      this.cache = { status: this.lastStatus, at: this.now() };
      this.recovered();
      return next;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(
        503,
        e instanceof WorkError ? e.detail.code : 'repository_unavailable',
      );
    }
  }
  stop() {
    this.stopped = true;
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
  }
}

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { flockSync } from 'fs-ext';
import { isAlias, isNode, parseDocument } from 'yaml';
import type { Document } from 'yaml';
import { ApiError } from '../obs/errors.js';
import { canonicalJson } from './primitives.js';
import { ConfigurationError } from './errors.js';
import { parseConfig } from './index.js';
import type { AiConfiguration, Config } from './index.js';
import { scopeLocation } from './scope.js';
import type { Scope } from './scope.js';

export const revisionOf = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

function withoutPath(config: Config, path: Array<string | number>): string {
  const copy = structuredClone(config);
  let parent = copy as unknown as Record<string | number, unknown>;
  for (const key of path.slice(0, -1))
    parent = parent[key] as Record<string | number, unknown>;
  delete parent[path.at(-1)!];
  return canonicalJson(copy);
}
function isolatedDocumentText(document: Document): string {
  try {
    document.toJS({ maxAliasCount: 20 });
    return document.toString();
  } catch {
    throw new ApiError(400, 'configuration_alias_conflict');
  }
}

/** A pathname replacement is the commit point; readers see one complete document. */
export function replacePrivateFile(
  path: string,
  text: string,
  beforeRename = () => {},
): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    beforeRename();
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      // Cleanup must not replace the write result; orphaned temporary files stay private.
    }
  }
  // Rename has committed. A directory fsync is best effort on filesystems which do not support it.
  let directory: number | undefined;
  try {
    directory = openSync(dirname(path), constants.O_RDONLY);
    fsyncSync(directory);
  } catch {
    /* The complete replacement remains authoritative. */
  } finally {
    if (directory !== undefined) closeSync(directory);
  }
}

export class YamlConfiguration {
  readonly path: string;
  private cache?: { text: string; revision: string; config: Config };
  constructor(path = './config.yaml') {
    this.path = resolve(path);
  }
  private text(): string {
    let fd: number | undefined;
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
        throw new Error('invalid_configuration_file');
      return readFileSync(fd, 'utf8');
    } catch {
      throw new ApiError(503, 'configuration_unavailable');
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  read(): { revision: string; config: Config } {
    const text = this.text();
    if (this.cache?.text !== text) {
      this.cache = {
        text,
        revision: revisionOf(text),
        config: parseConfig(text),
      };
    }
    // Callers cannot mutate the cached configuration into a second authority.
    return {
      revision: this.cache.revision,
      config: structuredClone(this.cache.config),
    };
  }
  updateAi(
    revision: string,
    update: (current: AiConfiguration) => AiConfiguration,
  ): { revision: string; config: Config } {
    return this.updateValue(revision, (current) => ({
      path: ['ai'],
      value: update(current.ai),
    }));
  }
  updateScope(
    revision: string,
    target: string,
    update: (current: Scope) => Scope,
  ): { revision: string; config: Config } {
    return this.updateValue(revision, (current) => {
      const location = scopeLocation(current, target);
      if (!location) throw new ApiError(404, 'scope_not_found');
      return { path: location.path, value: update(location.owner.scope) };
    });
  }
  private updateValue(
    revision: string,
    update: (current: Config) => {
      path: Array<string | number>;
      value: unknown;
    },
  ): { revision: string; config: Config } {
    let fd: number | undefined;
    try {
      fd = openSync(
        `${this.path}.lock`,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      if (!fstatSync(fd).isFile())
        throw new Error('invalid_configuration_lock');
      fchmodSync(fd, 0o600);
      flockSync(fd, 'exnb');
    } catch {
      if (fd !== undefined) closeSync(fd);
      throw new ApiError(503, 'configuration_write_unavailable');
    }
    try {
      const text = this.text();
      if (revisionOf(text) !== revision)
        throw new ApiError(409, 'configuration_conflict');
      const current = parseConfig(text);
      const document = parseDocument(text, { uniqueKeys: true });
      const { path, value } = update(structuredClone(current));
      for (let length = 1; length < path.length; length++)
        if (isAlias(document.getIn(path.slice(0, length), true)))
          throw new ApiError(400, 'configuration_alias_conflict');
      const original = document.getIn(path, true);
      const replacement = document.createNode(value);
      if (isNode(original)) replacement.commentBefore = original.commentBefore;
      document.setIn(path, replacement);
      const nextText = isolatedDocumentText(document);
      if (Buffer.byteLength(nextText, 'utf8') > 2 * 1024 * 1024)
        throw new ApiError(400, 'configuration_too_large');
      const next = parseConfig(nextText);
      if (withoutPath(current, path) !== withoutPath(next, path))
        throw new ApiError(400, 'configuration_alias_conflict');
      replacePrivateFile(this.path, nextText, () => {
        if (revisionOf(this.text()) !== revision)
          throw new ApiError(409, 'configuration_conflict');
      });
      this.cache = {
        text: nextText,
        revision: revisionOf(nextText),
        config: next,
      };
      return this.read();
    } catch (error) {
      if (error instanceof ApiError || error instanceof ConfigurationError)
        throw error;
      throw new ApiError(503, 'configuration_write_unavailable');
    } finally {
      flockSync(fd, 'un');
      closeSync(fd);
    }
  }
}

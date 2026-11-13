import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Sqlite from 'better-sqlite3';
import { flockSync } from 'fs-ext';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  INSTANCE_LOCK_FILE,
  SQLITE_DATABASE_FILE,
} from '../config/constants.js';
/** Owns the kernel lock for its entire lifetime, including all migrations. */
export class Database {
  sqlite!: Sqlite.Database;
  lockFd;
  closed = false;
  commitCallbacks: (() => void)[][] = [];
  private statements = new Map<string, Sqlite.Statement<unknown[]>>();
  constructor(root = process.cwd()) {
    mkdirSync(resolve(root, 'data'), { recursive: true, mode: 0o700 });
    this.lockFd = openSync(resolve(root, INSTANCE_LOCK_FILE), 'a+', 0o600);
    try {
      flockSync(this.lockFd, 'exnb');
    } catch {
      closeSync(this.lockFd);
      throw new Error('instance_lock_unavailable');
    }
    try {
      const databasePath = resolve(root, SQLITE_DATABASE_FILE);
      // A crash can leave WAL/SHM files from an older, more permissive release.
      // Restrict them before SQLite opens or recovers any existing journal.
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          chmodSync(databasePath + suffix, 0o600);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !('code' in error) ||
            error.code !== 'ENOENT'
          )
            throw error;
        }
      }
      this.sqlite = new Sqlite(databasePath);
      chmodSync(databasePath, 0o600);
      this.sqlite.pragma('journal_mode = WAL');
      this.sqlite.pragma('busy_timeout = 5000');
      this.sqlite.pragma('foreign_keys = ON');
      this.sqlite.pragma('synchronous = NORMAL');
      const migrationsFolder = resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../drizzle',
      );
      migrate(drizzle(this.sqlite), { migrationsFolder });
    } catch (error) {
      this.sqlite?.close();
      flockSync(this.lockFd, 'un');
      closeSync(this.lockFd);
      throw error;
    }
  }
  transaction<T>(work: () => T): T {
    const callbacks: (() => void)[] = [];
    this.commitCallbacks.push(callbacks);
    let result;
    try {
      result = this.sqlite.transaction(work).immediate();
    } catch (error) {
      this.commitCallbacks.pop();
      throw error;
    }
    this.commitCallbacks.pop();
    const parent = this.commitCallbacks.at(-1);
    if (parent) parent.push(...callbacks);
    else for (const callback of callbacks) this.afterCommit(callback);
    return result;
  }
  /** Observability cannot report a rolled-back mutation or undo a commit. */
  afterCommit(callback: () => void) {
    const pending = this.commitCallbacks.at(-1);
    if (pending) pending.push(callback);
    else {
      try {
        callback();
      } catch {
        /* instrumentation is not durable work */
      }
    }
  }
  get<T extends object = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): T | undefined {
    return this.statement(sql).get(...params) as T | undefined;
  }
  all<T extends object = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): T[] {
    return this.statement(sql).all(...params) as T[];
  }
  run(sql: string, ...params: unknown[]) {
    return this.statement(sql).run(...params);
  }
  private statement(sql: string): Sqlite.Statement<unknown[]> {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const statement = this.sqlite.prepare<unknown[]>(sql);
    // SQL templates contain placeholders, never article bodies or credentials.
    // Bound the cache even when Admin filters create different query shapes.
    if (this.statements.size >= 128)
      this.statements.delete(this.statements.keys().next().value!);
    this.statements.set(sql, statement);
    return statement;
  }
  ping() {
    return this.get('SELECT 1 AS ok')?.ok === 1;
  }
  close() {
    if (this.closed) return;
    this.sqlite.close();
    this.statements.clear();
    flockSync(this.lockFd, 'un');
    closeSync(this.lockFd);
    this.closed = true;
  }
}

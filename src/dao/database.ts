//
// The DAO-facing handle to a managed connection plus the small SQL helpers the
// DAO modules use. Managed connection ownership belongs exclusively to src/db.

import type { SQLInputValue } from "node:sqlite";
import { type DB, recordQueryTiming, runInTx } from "../db/mod.ts";

/** A transaction / executor handle. Both are the managed connection. */
export type Tx = DB;
export type Executor = DB;

/** A bindable SQL parameter. Booleans must be converted to 0/1 by the caller. */
export type Param = SQLInputValue;
export type Row = Record<string, unknown>;

/** Binds a boolean as SQLite's 0/1 integer. */
export function sqlBool(value: boolean): number {
  return value ? 1 : 0;
}

/** Normalizes an optional value to `null` for SQLite binding. */
export function nullable<T>(value: T | null | undefined): T | null {
  return value === undefined ? null : value;
}

const managedHandles = new WeakMap<DB, Database>();

/**
 * A DAO-facing handle to a managed connection. Managed connection ownership
 * belongs exclusively to src/db.
 */
export class Database {
  #db: DB | null;
  #managed: boolean;

  constructor(db: DB | null, managed = false) {
    this.#db = db;
    this.#managed = managed;
  }

  /** The underlying managed connection for DAO implementations. */
  get db(): DB | null {
    return this.#db;
  }

  get managed(): boolean {
    return this.#managed;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  /** Close only closes explicitly standalone connections. */
  close(): void {
    if (this.#db === null || this.#managed) return;
    this.#db.close();
  }

  /** Runs a callback in one transaction on the managed connection. */
  runInTx<T>(fn: (conn: Tx) => T): T {
    if (this.#db === null) throw new Error("database is not open");
    return runInTx(this.#db, fn);
  }
}

/** Wraps a managed connection, returning the same handle for the same DB. */
export function wrapDatabase(db: DB | null): Database | null {
  if (db === null) return null;
  const existing = managedHandles.get(db);
  if (existing) return existing;
  const handle = new Database(db, true);
  managedHandles.set(db, handle);
  return handle;
}

/**
 * Wraps a caller-owned connection. It exists for offline checks that
 * intentionally open a second connection; normal runtime code must use
 * `wrapDatabase` and `closeAll`.
 */
export function wrapStandaloneDatabase(db: DB | null): Database | null {
  if (db === null) return null;
  return new Database(db, false);
}

/** Runs `fn` and records its wall time against the slow-query baseline. */
function timed<T>(sql: string, fn: () => T): T {
  const started = performance.now();
  try {
    return fn();
  } finally {
    recordQueryTiming(sql, performance.now() - started);
  }
}

/** Runs a query and returns every row. */
export function queryAll<T = Row>(
  db: DB,
  sql: string,
  params: Param[] = [],
): T[] {
  return timed(sql, () => db.query<T>(sql, ...params));
}

/** Runs a query and returns the first row, or `undefined`. */
export function queryOptional<T = Row>(
  db: DB,
  sql: string,
  params: Param[] = [],
): T | undefined {
  return timed(sql, () => db.get<T>(sql, ...params)) ?? undefined;
}

/** Runs a statement and returns `changes`, mapping 0/undefined to 0. */
export function execChanges(db: DB, sql: string, params: Param[] = []): number {
  const result = timed(sql, () => db.run(sql, ...params));
  return Number(result.changes ?? 0);
}

/** Runs a statement that returns a `RETURNING` scalar, or `undefined`. */
export function execReturning<T>(
  db: DB,
  sql: string,
  params: Param[] = [],
): T | undefined {
  const row = timed(sql, () => db.get<Record<string, unknown>>(sql, ...params));
  if (row === undefined) return undefined;
  const values = Object.values(row);
  return values[0] as T;
}

/**
 * Builds a `(?, ?, ...)` placeholder list and matching params for `IN (...)`,
 * mirroring `bun.In`.
 */
export function inList(values: readonly Param[]): {
  sql: string;
  params: Param[];
} {
  return {
    sql: values.map(() => "?").join(", "),
    params: [...values],
  };
}

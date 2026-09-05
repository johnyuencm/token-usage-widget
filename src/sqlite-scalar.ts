/**
 * Read a scalar from a SQLite file without requiring the sqlite3 CLI.
 * Prefers Node's built-in node:sqlite (Node 22+), then falls back to sqlite3 on PATH.
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export type SqliteExecFile = (
  cmd: string,
  args: string[],
  opts: { windowsHide?: boolean; encoding?: string; maxBuffer?: number },
) => Promise<{ stdout: string | Buffer }>;

export interface SqliteScalarOptions {
  execFile?: SqliteExecFile;
  nodeSqliteGet?: (dbPath: string, sql: string) => string;
}

interface NodeSqliteDb {
  prepare(sql: string): { get(): Record<string, unknown> | undefined };
  close(): void;
}

function defaultNodeSqliteGet(dbPath: string, sql: string): string {
  let DatabaseSync: new (file: string, opts?: { readOnly?: boolean }) => NodeSqliteDb;
  try {
    ({ DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSync });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`node:sqlite unavailable: ${msg}`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare(sql).get();
    if (!row) return "";
    const first = Object.values(row)[0];
    return first == null ? "" : String(first).trim();
  } finally {
    db.close();
  }
}

async function sqlite3CliGet(
  dbPath: string,
  sql: string,
  execFileImpl: SqliteExecFile,
): Promise<string> {
  try {
    const result = await execFileImpl("sqlite3", [dbPath, sql], {
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return String(result.stdout).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not recognized|not found/i.test(msg)) {
      throw new Error("sqlite3 CLI not found on PATH");
    }
    throw new Error(`sqlite3 CLI failed: ${msg}`);
  }
}

export async function sqliteScalar(
  dbPath: string,
  sql: string,
  options: SqliteScalarOptions = {},
): Promise<string> {
  const nodeGet = options.nodeSqliteGet ?? defaultNodeSqliteGet;
  try {
    return nodeGet(dbPath, sql);
  } catch (nodeErr) {
    try {
      return await sqlite3CliGet(dbPath, sql, options.execFile ?? execFileAsync);
    } catch (cliErr) {
      const nodeMsg = nodeErr instanceof Error ? nodeErr.message : String(nodeErr);
      const cliMsg = cliErr instanceof Error ? cliErr.message : String(cliErr);
      throw new Error(`Failed to read sqlite database (${dbPath}): ${nodeMsg}; ${cliMsg}`);
    }
  }
}

export function copySqliteSidecars(src: string, dest: string): void {
  copyFileSync(src, dest);
  for (const suffix of ["-wal", "-shm"] as const) {
    if (existsSync(src + suffix)) {
      try {
        copyFileSync(src + suffix, dest + suffix);
      } catch {
        // WAL/SHM are optional; the copied main database may still be queryable.
      }
    }
  }
}

export function removeSqliteSidecars(dest: string): void {
  for (const p of [dest, `${dest}-wal`, `${dest}-shm`]) {
    try {
      unlinkSync(p);
    } catch {
      // ignore
    }
  }
}

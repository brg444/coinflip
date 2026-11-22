import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  SQLiteContractRepository,
  SQLiteIntentRepository,
  SQLiteWalletRepository,
  type SQLExecutor,
} from "@arkade-os/sdk/repositories/sqlite";

/** Write then fsync the tmp file before rename so a crash cannot leave a torn JSON file. */
export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(16).slice(2)}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

export function revision(): string {
  const baked = process.env.GIT_COMMIT?.trim();
  if (baked) return baked;
  try {
    const file = readFileSync("/etc/git-commit", "utf8").trim();
    if (file) return file;
  } catch {
    // Local service run has no image revision.
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

/** Open a WAL sqlite file under `dataDir` and return SDK repositories backed by it. */
export async function openSqliteStorage(dataDir: string, name = "arkade.sqlite") {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, name);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  const executor: SQLExecutor = {
    async run(sql, params) {
      db.prepare(sql).run(...((params ?? []) as SQLInputValue[]));
    },
    async get<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      return db.prepare(sql).get(...((params ?? []) as SQLInputValue[])) as T | undefined;
    },
    async all<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      return db.prepare(sql).all(...((params ?? []) as SQLInputValue[])) as T[];
    },
  };
  return {
    file,
    db,
    walletRepository: new SQLiteWalletRepository(executor),
    contractRepository: new SQLiteContractRepository(executor),
    intentRepository: new SQLiteIntentRepository(executor),
  };
}

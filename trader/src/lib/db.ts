import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { ROOT } from "./config.js";

export type DB = Database.Database;

const MIGRATIONS_DIR = resolve(ROOT, "shared/migrations");

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 30000");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/** Same contract as shared/migrate.py: files applied in name order, tracked in schema_migrations. */
export function migrate(db: DB, dir = MIGRATIONS_DIR): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const name of files) {
    const run = db.transaction(() => {
      if (db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(name)) return false;
      db.exec(readFileSync(resolve(dir, name), "utf8"));
      db.prepare("INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)").run(name, Date.now());
      return true;
    });
    if (run.immediate()) applied.push(name);
  }
  return applied;
}

export function heartbeat(db: DB, service: string, info: unknown): void {
  db.prepare(
    `INSERT INTO service_heartbeats(service, ts, pid, info) VALUES (?, ?, ?, ?)
     ON CONFLICT(service) DO UPDATE SET ts = excluded.ts, pid = excluded.pid, info = excluded.info`,
  ).run(service, Date.now(), process.pid, JSON.stringify(info));
}

/**
 * SQLite singleton — Xpoz Intelligence Pipeline
 *
 * Uses better-sqlite3 (sync API). Database file: data/pipeline.db
 * Created automatically on first use.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_SQL } from "./schema.js";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  // Ensure data/ dir exists
  mkdirSync("data", { recursive: true });

  const dbPath = join("data", "pipeline.db");
  _db = new Database(dbPath);

  // Enable WAL for better concurrent read performance
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  // Apply schema (idempotent — IF NOT EXISTS)
  _db.exec(SCHEMA_SQL);

  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

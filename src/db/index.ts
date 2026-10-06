import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export type DB = Database.Database;

/** Open (or create) the database and apply any pending numbered migrations. */
export function openDb(file: string): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current === 0) keepLegacyPrototypeTable(db);
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  for (const file of files) {
    const version = parseInt(file, 10);
    if (version <= current) continue;
    db.transaction(() => {
      db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      db.pragma(`user_version = ${version}`);
    })();
  }
}

/** The phase 1 JS prototype made its own `messages` table; move it aside rather than lose it. */
function keepLegacyPrototypeTable(db: DB) {
  const legacy = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get();
  if (legacy) db.exec('ALTER TABLE messages RENAME TO legacy_messages');
}

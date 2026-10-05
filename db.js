import Database from 'better-sqlite3';

const db = new Database('messages.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id                TEXT PRIMARY KEY,
    sender_jid        TEXT,
    sender_name       TEXT,
    raw_text          TEXT,
    summary           TEXT,
    is_urgent         INTEGER,
    requires_callback INTEGER,
    heard             INTEGER DEFAULT 0,
    created_at        INTEGER
  )
`);

const insert = db.prepare(`
  INSERT OR IGNORE INTO messages
    (id, sender_jid, sender_name, raw_text, summary, is_urgent, requires_callback, heard, created_at)
  VALUES
    (@id, @sender_jid, @sender_name, @raw_text, @summary, @is_urgent, @requires_callback, 0, @created_at)
`);

export const saveMessage = (m) => insert.run(m);

export const getUnheard = () =>
  db.prepare('SELECT * FROM messages WHERE heard = 0 ORDER BY is_urgent DESC, created_at').all();

export const markHeard = (ids) => {
  const stmt = db.prepare('UPDATE messages SET heard = 1 WHERE id = ?');
  db.transaction((list) => list.forEach((id) => stmt.run(id)))(ids);
};

export default db;

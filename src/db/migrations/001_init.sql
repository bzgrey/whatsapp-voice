-- Times are unix seconds.

CREATE TABLE chats (
  jid          TEXT PRIMARY KEY,
  name         TEXT,               -- group subject (DM names come from contacts)
  is_group     INTEGER NOT NULL DEFAULT 0,
  tier         TEXT NOT NULL DEFAULT 'normal' CHECK (tier IN ('flagged', 'normal', 'mentions', 'muted')),
  archived     INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER,            -- as last reported by WhatsApp (for restore-unread after send)
  summary      TEXT,               -- roll-call one-liner over unheard messages
  summary_upto INTEGER,            -- rowid of the newest message the summary covers
  updated_at   INTEGER
);

CREATE TABLE contacts (
  jid       TEXT PRIMARY KEY,      -- phone JID (…@s.whatsapp.net) when known, else the LID
  lid       TEXT UNIQUE,
  name      TEXT,                  -- my address-book name
  push_name TEXT                   -- their own WhatsApp name
);

CREATE TABLE messages (
  rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL,       -- WhatsApp message id
  chat_jid    TEXT NOT NULL,
  sender_jid  TEXT,
  sender_name TEXT,                -- push name at the time, fallback for unknown contacts
  from_me     INTEGER NOT NULL DEFAULT 0,
  type        TEXT NOT NULL,       -- text, voice, audio, image, video, document, sticker, reaction, contact, location, poll, other
  raw_text    TEXT,                -- text, caption, emoji, file name, …
  transcript  TEXT,                -- voice notes
  media_desc  TEXT,                -- image description, link title, document name
  media_ref   TEXT,                -- serialized WAMessage for a pending media download; cleared after processing
  is_urgent   INTEGER,             -- NULL until classified
  is_trivial  INTEGER,
  quoted_id   TEXT,
  mentions_me INTEGER NOT NULL DEFAULT 0,
  heard_at    INTEGER,
  created_at  INTEGER NOT NULL,
  UNIQUE (chat_jid, id)
);
CREATE INDEX messages_chat ON messages (chat_jid, created_at);
CREATE INDEX messages_unheard ON messages (heard_at, from_me);
CREATE INDEX messages_created ON messages (created_at);

CREATE TABLE jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,        -- classify, transcribe, describe, summarize
  ref        TEXT NOT NULL,        -- messages.rowid, or chat jid for summarize
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  run_after  INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX jobs_due ON jobs (status, run_after);
CREATE UNIQUE INDEX jobs_one_pending ON jobs (kind, ref) WHERE status = 'pending';

CREATE TABLE drafts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid    TEXT NOT NULL,
  text        TEXT NOT NULL,
  quoted_id   TEXT,                -- message to quote-reply, if an in-context reply
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  caller       TEXT,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'dropped')),
  current_chat TEXT,               -- chat being briefed when last seen (for "your last call dropped during …")
  in_briefing  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  purpose       TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  audio_seconds REAL NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0
);
CREATE INDEX usage_ts ON usage (ts);

CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT
);

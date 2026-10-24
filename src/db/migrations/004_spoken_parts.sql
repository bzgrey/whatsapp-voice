-- What each call read out, word for word, so it can be repeated later in the
-- call or on the next one. Holds message content: purged with messages (4 days).
CREATE TABLE spoken_parts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id     INTEGER NOT NULL,
  part        INTEGER NOT NULL,          -- rows sharing a number were said together (a roll-call batch)
  chat_jid    TEXT,
  kind        TEXT NOT NULL,             -- urgent | flagged | rollcall | read | summary
  text        TEXT NOT NULL,             -- the exact words
  message_ids TEXT NOT NULL DEFAULT '[]', -- JSON array of message rowids it covered
  created_at  INTEGER NOT NULL
);
CREATE INDEX spoken_parts_call ON spoken_parts (call_id, part);
CREATE INDEX spoken_parts_chat ON spoken_parts (chat_jid, call_id);

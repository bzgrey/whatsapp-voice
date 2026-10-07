-- Messages I've already replied to count as heard (see Ingest.handle).
UPDATE messages SET heard_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE from_me = 0 AND heard_at IS NULL AND EXISTS (
  SELECT 1 FROM messages mine
  WHERE mine.chat_jid = messages.chat_jid AND mine.from_me = 1 AND mine.created_at >= messages.created_at
);

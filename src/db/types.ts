export type Tier = 'flagged' | 'normal' | 'mentions' | 'muted';

export type MessageType =
  | 'text' | 'voice' | 'audio' | 'image' | 'video' | 'document' | 'sticker'
  | 'reaction' | 'contact' | 'location' | 'poll' | 'other';

export interface ChatRow {
  jid: string;
  name: string | null;
  is_group: number;
  tier: Tier;
  archived: number;
  unread_count: number | null;
  summary: string | null;
  summary_upto: number | null;
  updated_at: number | null;
}

export interface ContactRow {
  jid: string;
  lid: string | null;
  name: string | null;
  push_name: string | null;
  /** From config.yaml `names:`. */
  alias: string | null;
}

export interface MessageRow {
  rowid: number;
  id: string;
  chat_jid: string;
  sender_jid: string | null;
  sender_name: string | null;
  from_me: number;
  type: MessageType;
  raw_text: string | null;
  transcript: string | null;
  media_desc: string | null;
  media_ref: string | null;
  is_urgent: number | null;
  is_trivial: number | null;
  quoted_id: string | null;
  mentions_me: number;
  heard_at: number | null;
  created_at: number;
}

export type NewMessage = Omit<MessageRow, 'rowid' | 'heard_at' | 'transcript' | 'media_desc' | 'is_urgent'> & {
  media_desc?: string | null;
  is_urgent?: number | null;
};

export type JobKind = 'classify' | 'transcribe' | 'describe' | 'summarize';

export interface JobRow {
  id: number;
  kind: JobKind;
  ref: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  run_after: number;
  last_error: string | null;
  created_at: number;
}

export interface DraftRow {
  id: number;
  chat_jid: string;
  text: string;
  quoted_id: string | null;
  status: 'pending' | 'sent' | 'cancelled';
  created_at: number;
  updated_at: number;
}

export interface CallRow {
  id: number;
  caller: string | null;
  started_at: number;
  ended_at: number | null;
  status: 'active' | 'ended' | 'dropped';
  current_chat: string | null;
  in_briefing: number;
}

export interface UsageEntry {
  purpose: string;
  model: string;
  input_tokens?: number;
  output_tokens?: number;
  audio_seconds?: number;
  cost_usd: number;
}

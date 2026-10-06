import type { MessageRow } from '../db/types.ts';

/** Max images described per chat (SPEC §2.5). */
export const MAX_DESCRIBED_IMAGES = 2;

/** ~150 spoken words a minute. */
export const WORDS_PER_SECOND = 2.5;

export const wordCount = (s: string) => (s.match(/\S+/g) ?? []).length;
export const speakSeconds = (s: string) => Math.round(wordCount(s) / WORDS_PER_SECOND);

const quoted = (s: string) => `"${s.trim()}"`;

function documentPhrase(name: string | null): string {
  if (!name) return 'a document';
  const ext = /\.([a-z0-9]{2,5})$/i.exec(name)?.[1]?.toLowerCase();
  const kind = ext === 'pdf' ? 'a PDF' : ext && ['doc', 'docx'].includes(ext) ? 'a Word document'
    : ext && ['xls', 'xlsx', 'csv'].includes(ext) ? 'a spreadsheet' : 'a document';
  return `${kind} called ${name}`;
}

/** Speakable content of one message, without the sender. */
export function messageContent(m: MessageRow, opts: { describeImage?: boolean } = {}): string {
  const caption = m.raw_text?.trim() ? `, captioned ${quoted(m.raw_text)}` : '';
  switch (m.type) {
    case 'text':
      return (m.raw_text ?? '').trim() + (m.media_desc ? ` (a link: ${m.media_desc})` : '');
    case 'voice':
      return m.transcript ? `voice note: ${quoted(m.transcript)}` : 'a voice note, not yet transcribed';
    case 'audio':
      return 'an audio file' + caption;
    case 'image':
      return (opts.describeImage !== false && m.media_desc ? `a photo: ${m.media_desc}` : 'a photo') + caption;
    case 'video':
      return 'a video' + caption;
    case 'document':
      return documentPhrase(m.media_desc ?? m.raw_text) + (m.media_desc && m.raw_text ? `, captioned ${quoted(m.raw_text)}` : '');
    case 'sticker':
      return 'a sticker';
    case 'reaction':
      return `reacted ${m.raw_text ?? ''}`.trim();
    case 'contact':
      return m.raw_text ? `a contact card for ${m.raw_text}` : 'a contact card';
    case 'location':
      return m.raw_text ? `a location: ${m.raw_text}` : 'a location';
    case 'poll':
      return m.raw_text ? `a poll: ${quoted(m.raw_text)}` : 'a poll';
    default:
      return m.raw_text?.trim() || 'a message';
  }
}

const plural = (n: number, one: string, many: string, couple?: string) =>
  n === 1 ? one : n === 2 && couple ? couple : `${n} ${many}`;

/** "plus a couple of reactions and a thumbs-up" for trivial messages (SPEC §2.4). */
export function trivialTag(trivial: MessageRow[]): string {
  if (!trivial.length) return '';
  const reactions = trivial.filter((m) => m.type === 'reaction').length;
  const stickers = trivial.filter((m) => m.type === 'sticker').length;
  const texts = trivial.filter((m) => m.type !== 'reaction' && m.type !== 'sticker');
  const thumbs = texts.filter((m) => /^\s*👍[\u{1F3FB}-\u{1F3FF}]?\s*$/u.test(m.raw_text ?? '')).length;
  const other = texts.length - thumbs;
  const parts = [
    reactions && plural(reactions, 'a reaction', 'reactions', 'a couple of reactions'),
    stickers && plural(stickers, 'a sticker', 'stickers', 'a couple of stickers'),
    thumbs && plural(thumbs, 'a thumbs-up', 'thumbs-ups'),
    other && plural(other, 'a short reply', 'short replies', 'a couple of short replies'),
  ].filter(Boolean) as string[];
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]!;
  return list;
}

/**
 * A message as the object of a spoken sentence, for narration:
 * '"See you at 8"', 'a photo of the baby, captioned "first steps"', 'a voice note: "…"'.
 */
export function messageObject(m: MessageRow, opts: { describeImage?: boolean } = {}): string {
  const caption = m.raw_text?.trim() ? `, captioned ${quoted(m.raw_text)}` : '';
  switch (m.type) {
    case 'text': return quoted(m.raw_text ?? '') + (m.media_desc ? ` (a link: ${m.media_desc})` : '');
    case 'voice': return m.transcript ? `a voice note: ${quoted(m.transcript)}` : 'a voice note, not yet transcribed';
    case 'image': return (opts.describeImage !== false && m.media_desc ? `a photo of ${m.media_desc.replace(/^(a |an )?photo of /i, '')}` : 'a photo') + caption;
    default: return messageContent(m, opts);
  }
}

/** How each message is introduced when read aloud. */
export interface Narration {
  /** Who sent it ("Mom", "Yossi"); "You" for my own. */
  senderOf: (m: MessageRow) => string;
  /** What it replies to, e.g. 'your message "Did it work?"', or null. */
  replyOf?: (m: MessageRow) => string | null;
  /** Context for the first message, e.g. 'your message "Did it work?"' when it follows something I sent. */
  after?: string | null;
}

export interface Rendered {
  /** Speakable lines, one per non-trivial message. */
  lines: string[];
  /** "plus …" tag for trivial messages, or ''. */
  trivial: string;
  /** Number of non-trivial messages. */
  count: number;
}

/**
 * Render a chat's messages for reading out, one narrated sentence each so the
 * listener can tell messages and people apart:
 *   Mom, after your message "Did it work?", wrote: "3333 worked!"
 *   Then a photo of a gray cap, captioned "is this yours?"
 *   Yossi, replying to your message "Shiur at 9?", wrote: "yes"
 * Images beyond the first two collapse into "and 6 more photos" (SPEC §2.5).
 * With no narration, lines are bare content (used for counting only).
 */
export function renderMessages(msgs: MessageRow[], narration: Narration | null): Rendered {
  const real = msgs.filter((m) => !m.is_trivial);
  const trivial = msgs.filter((m) => m.is_trivial);
  const lines: string[] = [];
  let prevSender: string | null = null;
  let images = 0;
  let extraImages = 0;
  for (const m of real) {
    if (m.type === 'image' && !m.raw_text?.trim()) {
      images++;
      if (images > MAX_DESCRIBED_IMAGES) { extraImages++; continue; }
    }
    const describeImage = m.type !== 'image' || images <= MAX_DESCRIBED_IMAGES;
    if (!narration) { lines.push(messageContent(m, { describeImage })); continue; }
    const who = narration.senderOf(m);
    const same = lines.length > 0 && prevSender === who;
    prevSender = who;
    const reply = narration.replyOf?.(m) ?? (lines.length === 0 ? narration.after ?? null : null);
    const ctx = reply ? `, ${narration.replyOf?.(m) ? 'replying to' : 'after'} ${reply},` : '';
    const object = messageObject(m, { describeImage });
    const verb = m.type === 'text' ? 'wrote:' : m.type === 'reaction' ? '' : 'sent';
    lines.push(same
      ? `Then${ctx ? ctx.replace(/,$/, ':') : m.type === 'text' ? ':' : ''} ${m.type === 'reaction' ? messageContent(m) : object}`
      : `${who}${ctx} ${m.type === 'reaction' ? messageContent(m) : `${verb} ${object}`}`);
  }
  if (extraImages) lines.push(`and ${plural(extraImages, 'one more photo', 'more photos')}`);
  return { lines, trivial: trivialTag(trivial), count: real.length };
}

/** "[Tue 14:03] Yossi: …" lines for model context (not for reading out). */
export function contextLines(msgs: MessageRow[], senderOf: (m: MessageRow) => string, tz = 'Asia/Jerusalem'): string[] {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return msgs.map((m) => `[${fmt.format(new Date(m.created_at * 1000))}] ${m.from_me ? 'Me' : senderOf(m)}${m.heard_at || m.from_me ? '' : ' (new)'}: ${messageContent(m)}`);
}

/** "since Tuesday" / "for about 3 hours" (Israel time). */
export function sincePhrase(ts: number, now: number, tz = 'Asia/Jerusalem'): string {
  const hours = (now - ts) / 3600;
  if (hours < 1) return 'for a few minutes';
  if (hours < 20) return `for about ${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`;
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long' }).format(new Date(ts * 1000));
  return hours < 6 * 24 ? `since ${day}` : `for ${Math.round(hours / 24)} days`;
}

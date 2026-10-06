import type { MessageType } from '../db/types.ts';

/**
 * The subset of Baileys' WAMessage we read. Typed structurally so tests can
 * pass plain objects.
 */
export interface RawMessage {
  key: {
    id?: string | null;
    remoteJid?: string | null;
    remoteJidAlt?: string;
    participant?: string | null;
    participantAlt?: string;
    fromMe?: boolean | null;
  };
  message?: any;
  pushName?: string | null;
  messageTimestamp?: number | { toNumber(): number } | null;
}

export interface Extracted {
  id: string;
  remoteJid: string;
  remoteJidAlt?: string;
  participant?: string;
  participantAlt?: string;
  fromMe: boolean;
  pushName: string | null;
  timestamp: number;
  type: MessageType;
  text: string | null;
  /** Link title or document file name. */
  mediaDesc: string | null;
  /** Voice notes and images need downloading for enrichment. */
  needsMedia: boolean;
  seconds: number | null;
  quotedId: string | null;
  quotedParticipant: string | null;
  mentionedJids: string[];
  /** Deletions and edits of an earlier message. */
  protocol?: { kind: 'revoke' | 'edit'; targetId: string; text?: string };
}

const WRAPPERS = [
  'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
  'documentWithCaptionMessage', 'editedMessage', 'deviceSentMessage',
] as const;

/** Strip ephemeral / view-once / device-sent wrappers. */
export function unwrap(content: any): any {
  let c = content;
  for (let i = 0; i < 5 && c; i++) {
    const w = WRAPPERS.find((k) => c[k]?.message);
    if (!w) break;
    c = c[w].message;
  }
  return c;
}

const IGNORED = new Set(['senderKeyDistributionMessage', 'messageContextInfo']);

function textOf(m: any): string | null {
  if (!m) return null;
  return m.conversation ?? m.extendedTextMessage?.text ?? null;
}

const ts = (t: RawMessage['messageTimestamp']) =>
  t == null ? Math.floor(Date.now() / 1000) : typeof t === 'number' ? t : Number(t.toNumber ? t.toNumber() : t);

/** Turn a Baileys message into the fields we store. Null when there's nothing to keep. */
export function extract(raw: RawMessage): Extracted | null {
  const { key } = raw;
  if (!key.id || !key.remoteJid) return null;
  const c = unwrap(raw.message);
  if (!c) return null;

  const base = {
    id: key.id,
    remoteJid: key.remoteJid,
    remoteJidAlt: key.remoteJidAlt,
    participant: key.participant ?? undefined,
    participantAlt: key.participantAlt,
    fromMe: !!key.fromMe,
    pushName: raw.pushName ?? null,
    timestamp: ts(raw.messageTimestamp),
    mediaDesc: null as string | null,
    needsMedia: false,
    seconds: null as number | null,
    quotedId: null as string | null,
    quotedParticipant: null as string | null,
    mentionedJids: [] as string[],
  };

  if (c.protocolMessage) {
    const p = c.protocolMessage;
    const targetId = p.key?.id;
    if (!targetId) return null;
    // proto enum: REVOKE = 0, MESSAGE_EDIT = 14
    if (p.type === 0 || p.type === 'REVOKE') return { ...base, type: 'other', text: null, protocol: { kind: 'revoke', targetId } };
    const edited = textOf(unwrap(p.editedMessage)) ?? unwrap(p.editedMessage)?.imageMessage?.caption;
    if (edited != null) return { ...base, type: 'text', text: edited, protocol: { kind: 'edit', targetId, text: edited } };
    return null;
  }

  const kind = Object.keys(c).find((k) => !IGNORED.has(k) && c[k] != null);
  if (!kind) return null;
  const inner = c[kind];
  const ctx = inner?.contextInfo;
  if (ctx) {
    base.quotedId = ctx.stanzaId ?? null;
    base.quotedParticipant = ctx.participant ?? null;
    base.mentionedJids = ctx.mentionedJid ?? [];
  }

  const out = (type: MessageType, text: string | null, extra: Partial<Extracted> = {}): Extracted =>
    ({ ...base, type, text: text?.trim() ? text : null, ...extra });

  switch (kind) {
    case 'conversation':
      return out('text', c.conversation);
    case 'extendedTextMessage':
      return out('text', inner.text, { mediaDesc: inner.title || null });
    case 'audioMessage':
      return inner.ptt
        ? out('voice', null, { needsMedia: true, seconds: inner.seconds ?? null })
        : out('audio', null, { seconds: inner.seconds ?? null });
    case 'imageMessage':
      return out('image', inner.caption ?? null, { needsMedia: true });
    case 'videoMessage':
    case 'ptvMessage':
      return out('video', inner.caption ?? null, { seconds: inner.seconds ?? null });
    case 'documentMessage':
      return out('document', inner.caption ?? null, { mediaDesc: inner.fileName ?? inner.title ?? null });
    case 'stickerMessage':
      return out('sticker', null);
    case 'reactionMessage':
      // An empty reaction text means the reaction was removed.
      if (!inner.text) return null;
      return out('reaction', inner.text, { quotedId: inner.key?.id ?? null, quotedParticipant: inner.key?.participant ?? null });
    case 'contactMessage':
      return out('contact', inner.displayName ?? null);
    case 'contactsArrayMessage':
      return out('contact', inner.displayName ?? (inner.contacts ?? []).map((x: any) => x.displayName).filter(Boolean).join(', '));
    case 'locationMessage':
    case 'liveLocationMessage':
      return out('location', [inner.name, inner.address].filter(Boolean).join(', ') || null);
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      return out('poll', inner.name ?? null);
    case 'pollUpdateMessage':
    case 'keepInChatMessage':
    case 'pinInChatMessage':
    case 'call':
      return null;
    default:
      return out('other', null);
  }
}

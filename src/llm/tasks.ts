import type { Models } from '../config/schema.ts';
import type { NameMatcher } from '../config/resolve.ts';
import { LLM } from './openai.ts';

export interface Classification {
  is_urgent: boolean;
  is_trivial: boolean;
}

const CLASSIFY_SYSTEM = `You triage WhatsApp messages for someone at yeshiva who can only check them by phone call.
Messages may be in Hebrew, English, Yiddish, or a mix.
Return JSON: {"is_urgent": boolean, "is_trivial": boolean}.
is_urgent: true ONLY for emergencies or truly time-sensitive matters: illness, injury, accident, hospital, death, someone in danger, someone waiting for him right now, or a request that is useless if not answered within hours. Routine requests, plans for later, simmering questions and chatter are NOT urgent. When unsure, false.
is_trivial: true for content-free messages: "ok", "thanks", "👍", "lol", a lone emoji, "good night", a sticker, a reaction. A short message with real content ("ok, see you at 8") is NOT trivial. A bare "yes", "no", "כן", "לא", "maybe" or a time is an answer to something, so NOT trivial.`;

export const SUMMARY_LINE_SYSTEM = `You write one-line summaries of a WhatsApp chat for a phone briefing, spoken aloud in English.
You get the recent conversation; lines marked (new) are the unheard ones. "Me" is the listener.
Summarize ONLY the new messages, using earlier lines just for context (e.g. "answering your question about Thursday").
Write one short clause, max 15 words, no sender name, no lead-in like "They said". Example: "asking to borrow your sefer and whether Thursday works".
In groups, name who said what if it matters. Translate to English. Return JSON: {"line": string}.`;

export const SUMMARY_DETAIL_SYSTEM = `You summarize a WhatsApp chat for someone listening on a phone call, in English.
Lines marked (new) are the unheard messages; "Me" is the listener. Focus on the new messages, using the rest as context.
Give a clear spoken summary in 2–5 sentences: what was said, what is being asked of him, any times, places or numbers exactly.
No lists, no markdown. Plain sentences that sound natural read aloud.`;

const DESCRIBE_SYSTEM = `Describe this WhatsApp photo in one short spoken phrase (max 12 words), for someone who can't see it.
Start lowercase, no "this is" or "an image of". Example: "the baby sitting in a sukkah". If there's legible text that matters (an invitation, a schedule), include the key words. If a caption is given, don't repeat it.
Return JSON: {"description": string}.`;

const NAME_MATCH_SYSTEM = `You match a spoken name to WhatsApp contacts. Names may be in Hebrew, English or Yiddish, so match across scripts and transliterations ("Yossi" = "יוסי", "Moishe" = "משה").
Return JSON {"ids": number[]}: the ids of every contact the spoken name could plausibly refer to, best first. Empty if none.`;

const TRIVIAL_RE = /^(ok(ay)?|k|kk|thanks?|thank you|thx|ty|lol|haha+|np|👍|🙏|❤️|אוקי|אוקיי|בסדר|תודה|תודה רבה|סבבה|חחח+|a dank|dank)[.!\s]*$/iu;
const EMOJI_ONLY_RE = /^[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}‍️\s]+$/u;

/** Cheap pre-check so obvious acks never hit the API. */
export function obviouslyTrivial(text: string): boolean {
  const t = text.trim();
  return !t || TRIVIAL_RE.test(t) || EMOJI_ONLY_RE.test(t);
}

export class Tasks {
  constructor(readonly llm: LLM, private models: () => Models) {}

  async classify(text: string, context: { chat: string; isGroup: boolean }): Promise<Classification> {
    if (obviouslyTrivial(text)) return { is_urgent: false, is_trivial: true };
    const r = await this.llm.json<Partial<Classification>>(
      'classify', this.models().classify, CLASSIFY_SYSTEM,
      `${context.isGroup ? `Group "${context.chat}"` : `Direct chat with ${context.chat}`}:\n${text}`,
    );
    return { is_urgent: r.is_urgent === true, is_trivial: r.is_trivial === true };
  }

  async describeImage(image: Buffer, mime: string, caption: string | null): Promise<string> {
    const r = await this.llm.json<{ description?: string }>('describe', this.models().vision, DESCRIBE_SYSTEM, [
      { type: 'text', text: caption ? `Caption: ${caption}` : 'No caption.' },
      LLM.imagePart(image, mime),
    ], { timeoutMs: 60_000 });
    return (r.description ?? '').trim();
  }

  async transcribe(audio: Buffer, filename: string, seconds: number): Promise<string> {
    return this.llm.transcribe(this.models().transcribe, audio, filename, seconds,
      'WhatsApp voice note. May be Hebrew, English or Yiddish, or a mix.');
  }

  async summaryLine(chatName: string, isGroup: boolean, lines: string[], timeoutMs?: number): Promise<string> {
    const r = await this.llm.json<{ line?: string }>('summary_line', this.models().summarize, SUMMARY_LINE_SYSTEM,
      `${isGroup ? `Group "${chatName}"` : `Chat with ${chatName}`}:\n${lines.join('\n')}`, { timeoutMs, fast: true });
    return (r.line ?? '').trim().replace(/\.$/, '');
  }

  async summaryDetail(chatName: string, isGroup: boolean, lines: string[]): Promise<string> {
    return this.llm.text('summary_detail', this.models().summarize, SUMMARY_DETAIL_SYSTEM,
      `${isGroup ? `Group "${chatName}"` : `Chat with ${chatName}`}:\n${lines.join('\n')}`);
  }

  matchNames: NameMatcher = async (query, candidates) => {
    const r = await this.llm.json<{ ids?: number[] }>('name_match', this.models().classify, NAME_MATCH_SYSTEM,
      `Spoken name: ${query}\nContacts:\n${candidates.map((c) => `${c.id}: ${c.names.join(' / ')}`).join('\n')}`, { timeoutMs: 15_000, fast: true });
    return (r.ids ?? []).filter((i) => Number.isInteger(i)).slice(0, 5);
  };
}

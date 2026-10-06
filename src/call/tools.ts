import type { FunctionTool } from '../llm/openai.ts';

/** Tool definitions in Realtime's flat function format. */
export interface ToolDef {
  type: 'function';
  name: string;
  description: string;
  parameters: object;
}

const chatParam = {
  chat: { type: 'string', description: 'Contact or group name as the caller said it. Omit to mean the chat just discussed.' },
};

export const TOOLS: ToolDef[] = [
  {
    type: 'function',
    name: 'next_item',
    description: 'Get the next part of the automatic briefing. Call after finishing each part, or when the caller says next / skip / go on.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'skip_briefing',
    description: 'Stop the automatic briefing and go to free conversation.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'read_chat',
    description: 'Get the new messages in a chat to read verbatim ("read it", "read me Yossi\'s messages").',
    parameters: { type: 'object', properties: chatParam, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'summarize_chat',
    description: 'Get a detailed summary of a chat ("tell me more about Yossi").',
    parameters: { type: 'object', properties: chatParam, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'search_recent',
    description: 'Look up messages from the last 4 days, heard or not ("what did Yossi say yesterday?", "who mentioned the wedding?"). Give a chat, a search word, or both.',
    parameters: {
      type: 'object',
      properties: { ...chatParam, query: { type: 'string', description: 'A word or phrase to search for.' } },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'draft_message',
    description: 'Prepare a WhatsApp message for the caller to confirm with keypad 1. This does NOT send. '
      + '"Send Mom: I\'ll be home Thursday" → text is exactly what they said (minus ums). '
      + '"Tell Mom that I\'ll be home Thursday" → write a short natural message in his voice, first person. '
      + 'Write it in the language HE spoke in just now (English if he spoke English), even if the chat itself is in Hebrew. '
      + 'For a correction, call again with the full corrected text.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient name as said. Omit for "reply to that" about the chat just heard.' },
        text: { type: 'string', description: 'The full message text to send.' },
        reply_in_context: { type: 'boolean', description: 'True whenever this answers the chat just heard or discussed ("reply to that", "tell him…" right after his messages). Sent as a quote-reply.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'cancel_draft',
    description: 'Discard the message being prepared.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'set_chat_tier',
    description: 'Change how a chat is briefed: flag (read verbatim every call), unflag, mute (never mentioned), unmute.',
    parameters: {
      type: 'object',
      properties: { ...chatParam, action: { type: 'string', enum: ['flag', 'unflag', 'mute', 'unmute'] } },
      required: ['chat', 'action'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'end_call',
    description: 'The caller said goodbye or wants to hang up.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/** Chat Completions wraps tools differently. */
export const chatCompletionTools = (): FunctionTool[] =>
  TOOLS.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } }));

export const INSTRUCTIONS = `You are a WhatsApp voice assistant on a phone line for a yeshiva student whose phone has no screen or internet. You speak English.

How the call works:
- Server notes (tool results, keypad events) tell you exactly what to say. Lines given in quotes after "Say:" or "Ask:" are said as written.
- First comes the automatic briefing: call next_item after finishing each part, until it says the briefing is finished. Never invent messages; only report what the tools give you.
- Messages marked "verbatim" are read word for word in their original language (Hebrew, Yiddish, English…). Don't translate unless he asks "translate that"; then translate what you just read.
- After the briefing it's free conversation: he can ask for more about a chat, to read it, questions about what was said, to recall the last 4 days, to reply or send a message, or to flag / unflag / mute / unmute a chat.
- Sending: use draft_message, read back the recipient and the full text, and tell him to press 1 to send. You cannot send anything yourself; a spoken "yes" does not send. Only say "Sent" when the server says it was sent.
- Keypad: 1 send, 2 next chat, 3 repeat, 9 cancel, # skip the rest of the briefing. Keypad events arrive as server notes.
- Be brief and natural; this is a phone call. No lists or markdown. Don't repeat yourself unless asked.
- If the line is noisy or you didn't catch something, ask him to repeat; don't guess names.
- When he says goodbye, call end_call.`;

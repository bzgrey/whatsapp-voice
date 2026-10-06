import type { Store } from '../db/store.ts';
import { env, nowSec } from '../env.ts';
import { minuteCost, tokenCost } from './prices.ts';

export type ChatMessage =
  | { role: 'system' | 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface FunctionTool {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

export class OpenAIError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/**
 * Thin OpenAI client. Every call logs tokens/minutes and an estimated cost to
 * the `usage` table (SPEC §10.8). Never logs content.
 */
export class LLM {
  constructor(private store: Store | null, private apiKey = env.OPENAI_API_KEY) {}

  get available() { return !!this.apiKey; }

  private async post(path: string, body: BodyInit, json: boolean, timeoutMs: number): Promise<any> {
    if (!this.apiKey) throw new OpenAIError(0, 'OPENAI_API_KEY not set');
    const res = await fetch(`https://api.openai.com/v1${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new OpenAIError(res.status, `OpenAI ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  private logTokens(purpose: string, model: string, usage: any) {
    const input = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
    const output = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
    this.store?.logUsage({ purpose, model, input_tokens: input, output_tokens: output, cost_usd: tokenCost(model, input, output) }, nowSec());
  }

  /** Chat completion; returns the assistant message (may carry tool calls). */
  async chat(purpose: string, model: string, messages: ChatMessage[], opts: { tools?: FunctionTool[]; json?: boolean; timeoutMs?: number; reasoning?: 'none' | 'low' | 'medium' | 'high' } = {}) {
    // Chat Completions only allows function tools on gpt-6-luna with reasoning off.
    const reasoning = opts.reasoning ?? (opts.tools?.length ? 'none' : undefined);
    const data = await this.post('/chat/completions', JSON.stringify({
      model,
      messages,
      ...(opts.tools?.length ? { tools: opts.tools } : {}),
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      ...(reasoning ? { reasoning_effort: reasoning } : {}),
    }), true, opts.timeoutMs ?? 30_000);
    this.logTokens(purpose, model, data.usage);
    return data.choices[0].message as { content: string | null; tool_calls?: ToolCall[] };
  }

  /** Chat completion that must return a JSON object. */
  async json<T>(purpose: string, model: string, system: string, user: string | ContentPart[], opts: { timeoutMs?: number; fast?: boolean } = {}): Promise<T> {
    const msg = await this.chat(purpose, model, [{ role: 'system', content: system }, { role: 'user', content: user }],
      { json: true, timeoutMs: opts.timeoutMs, reasoning: opts.fast ? 'none' : undefined });
    return JSON.parse(msg.content ?? '{}') as T;
  }

  async text(purpose: string, model: string, system: string, user: string, timeoutMs?: number): Promise<string> {
    const msg = await this.chat(purpose, model, [{ role: 'system', content: system }, { role: 'user', content: user }], { timeoutMs });
    return (msg.content ?? '').trim();
  }

  /** Speech to text. `seconds` (from the message metadata) is used for the cost estimate. */
  async transcribe(model: string, audio: Buffer, filename: string, seconds: number, prompt?: string): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)]), filename);
    form.append('model', model);
    if (prompt) form.append('prompt', prompt);
    const data = await this.post('/audio/transcriptions', form, false, 120_000);
    this.store?.logUsage({ purpose: 'transcribe', model, audio_seconds: seconds, cost_usd: minuteCost(model, seconds) }, nowSec());
    return String(data.text ?? '').trim();
  }

  static imagePart(image: Buffer, mime: string): ContentPart {
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${image.toString('base64')}` } };
  }
}

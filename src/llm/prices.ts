/** USD prices used for the usage log. Estimates; check OpenAI's pricing page when switching models. */
interface Price {
  /** per million tokens */
  input?: number;
  output?: number;
  /** per million audio tokens (realtime) */
  audioInput?: number;
  audioOutput?: number;
  /** per minute of audio (transcription, live) */
  perMinute?: number;
}

export const PRICES: Record<string, Price> = {
  'gpt-6-luna': { input: 0.1, output: 0.5 },
  'gpt-4o-mini-transcribe': { perMinute: 0.003 },
  'gpt-4o-transcribe': { perMinute: 0.006 },
  'gpt-realtime-mini': { input: 0.6, output: 2.4, audioInput: 10, audioOutput: 20 },
  'gpt-realtime-2.1-mini': { input: 0.6, output: 2.4, audioInput: 10, audioOutput: 20 },
  'gpt-live-1': { perMinute: 0.05 },
};

const warned = new Set<string>();

function price(model: string): Price {
  const p = PRICES[model];
  if (!p && !warned.has(model)) {
    warned.add(model);
    console.warn(`prices: no price for ${model}; logging cost 0`);
  }
  return p ?? {};
}

export function tokenCost(model: string, input: number, output: number, audioIn = 0, audioOut = 0): number {
  const p = price(model);
  return ((input - audioIn) * (p.input ?? 0) + (output - audioOut) * (p.output ?? 0)
    + audioIn * (p.audioInput ?? p.input ?? 0) + audioOut * (p.audioOutput ?? p.output ?? 0)) / 1e6;
}

export function minuteCost(model: string, seconds: number): number {
  return ((price(model).perMinute ?? 0) * seconds) / 60;
}

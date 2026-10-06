import crypto from 'node:crypto';
import express from 'express';
import WebSocket from 'ws';
import { CallSession, type SessionDeps } from '../briefing/session.ts';
import { callerFromSip } from '../config/phone.ts';
import { env } from '../env.ts';
import { errMsg, log } from '../log.ts';
import { RealtimeCall } from './realtime.ts';
import { INSTRUCTIONS, TOOLS } from './tools.ts';

/** Standard Webhooks signature: HMAC-SHA256 over "id.timestamp.body", within 5 minutes. */
export function verifySignature(headers: Record<string, string | string[] | undefined>, body: string, secret: string, now = Date.now() / 1000): boolean {
  const h = (k: string) => (Array.isArray(headers[k]) ? headers[k]![0] : headers[k]) as string | undefined;
  const id = h('webhook-id'), ts = h('webhook-timestamp'), sigs = h('webhook-signature');
  if (!id || !ts || !sigs || !secret) return false;
  if (Math.abs(now - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest();
  return sigs.split(' ').some((s) => {
    const sig = Buffer.from(s.split(',')[1] ?? '', 'base64');
    return sig.length === expected.length && crypto.timingSafeEqual(sig, expected);
  });
}

const api = (path: string, body?: object) =>
  fetch(`https://api.openai.com/v1${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });

/** The caller's number from the SIP headers (untrusted, per OpenAI; the PIN covers spoofing). */
function callerOf(headers: { name: string; value: string }[] | undefined): string | null {
  const from = headers?.find((x) => x.name.toLowerCase() === 'from')?.value;
  return callerFromSip(from);
}

/**
 * POST /openai/webhook: accept `realtime.call.incoming`, then drive the call
 * over the sideband WebSocket. Mount before express.json() (needs the raw body).
 */
export function callRouter(deps: SessionDeps) {
  const router = express.Router();
  const debug = process.env.CALL_DEBUG_TRANSCRIPTS === '1';

  router.post('/openai/webhook', express.text({ type: '*/*', limit: '1mb' }), (req, res) => {
    const body = typeof req.body === 'string' ? req.body : '';
    if (!verifySignature(req.headers, body, env.OPENAI_WEBHOOK_SECRET)) {
      log.warn('webhook: bad signature');
      return res.status(401).end();
    }
    res.status(200).end();
    const ev = JSON.parse(body);
    if (ev.type !== 'realtime.call.incoming') return; // e.g. live.transport.incoming also fires per call
    void answer(ev.data.call_id, callerOf(ev.data.sip_headers)).catch((err) => log.error(`call accept failed: ${errMsg(err)}`));
  });

  async function answer(callId: string, caller: string | null) {
    const cfg = deps.config.config;
    const model = cfg.models.call;
    const r = await api(`/realtime/calls/${callId}/accept`, {
      type: 'realtime',
      model,
      instructions: INSTRUCTIONS,
      tools: TOOLS,
      tool_choice: 'auto',
      audio: {
        output: { voice: cfg.call_voice },
        input: {
          ...(debug ? { transcription: { model: 'gpt-4o-mini-transcribe' } } : {}),
          // Tuned in the phase 3 test calls.
          turn_detection: { type: 'server_vad', threshold: 0.6, silence_duration_ms: 500, prefix_padding_ms: 300 },
        },
      },
    });
    if (!r.ok) throw new Error(`accept ${r.status}: ${(await r.text()).slice(0, 300)}`);

    const session = new CallSession(deps, caller);
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${callId}`, { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } });
    const call = new RealtimeCall(session, {
      send: (e) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e)); },
      hangup: async () => {
        const h = await api(`/realtime/calls/${callId}/hangup`);
        if (!h.ok) throw new Error(`hangup ${h.status}`);
      },
      later: (fn, ms) => void setTimeout(fn, ms),
    }, deps.store, model, debug);
    const started = Date.now();
    ws.on('open', () => void call.start().catch((err) => log.error(`call ${session.callId}: opening failed: ${errMsg(err)}`)));
    ws.on('message', (raw) => {
      try { void call.onEvent(JSON.parse(String(raw))); } catch (err) { log.warn(`call ${session.callId}: bad event: ${errMsg(err)}`); }
    });
    ws.on('close', () => {
      call.closed();
      log.info(`call ${session.callId}: sideband closed after ${Math.round((Date.now() - started) / 1000)}s`);
    });
    ws.on('error', (err) => log.warn(`call ${session.callId}: sideband error: ${errMsg(err)}`));
  }

  return router;
}

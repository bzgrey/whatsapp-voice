// Phase 3 test: accept OpenAI Realtime SIP calls and log sideband events.
// Throwaway; the real handler lands in src/call/ in the TypeScript rewrite.
import http from 'node:http';
import crypto from 'node:crypto';
import WebSocket from 'ws';

const { OPENAI_API_KEY, OPENAI_WEBHOOK_SECRET, PORT = 3000 } = process.env;
const MODEL = process.env.REALTIME_MODEL || 'gpt-realtime-mini';
// ENGINE=live uses gpt-live-1 (webhook live.transport.incoming); realtime uses MODEL.
const ENGINE = process.env.ENGINE || 'realtime';
const VOICE = process.env.REALTIME_VOICE || 'cedar';
const log = (...a) => console.log(new Date().toISOString(), ...a);

// Standard Webhooks signature: HMAC-SHA256 over "id.timestamp.body".
function verify(headers, body) {
  const id = headers['webhook-id'], ts = headers['webhook-timestamp'], sigs = headers['webhook-signature'];
  if (!id || !ts || !sigs) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(OPENAI_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest();
  return sigs.split(' ').some((s) => {
    const sig = Buffer.from(s.split(',')[1] ?? '', 'base64');
    return sig.length === expected.length && crypto.timingSafeEqual(sig, expected);
  });
}

const api = (path, body) =>
  fetch(`https://api.openai.com/v1${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const INSTRUCTIONS = `You are a test of a WhatsApp voice assistant, speaking English on a phone line.
Greet the caller briefly, say this is a connection test, and ask them to press a few keys on the keypad.
When you are told which key was pressed, say the digit back. Keep every reply to one short sentence.`;

function sideband(url, callId, isRealtime) {
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
  });
  const started = Date.now();
  ws.on('open', () => {
    log('sideband open', callId);
    if (isRealtime) ws.send(JSON.stringify({ type: 'response.create' }));
    else say('The call just connected. Greet the caller now.');
  });
  // Live: speakable context for the model (it may paraphrase).
  const say = (content) => ws.send(JSON.stringify({ type: 'session.commentary.append', delegation_id: null, content }));
  // Live: collect transcript fragments and log them as whole lines.
  const text = { in: '', out: '' };
  const flush = () => {
    for (const k of ['in', 'out']) if (text[k].trim()) { log(k === 'in' ? 'HEARD:' : 'SAID: ', text[k].trim()); text[k] = ''; }
  };
  ws.on('message', (raw) => {
    const ev = JSON.parse(raw);
    if (ev.type === 'session.input_transcript.delta') { if (text.out) flush(); text.in += ev.delta ?? ''; return; }
    if (ev.type === 'session.output_transcript.delta') { if (text.in) flush(); text.out += ev.delta ?? ''; return; }
    if (ev.type === 'session.input_audio.append' || ev.type === 'session.usage.updated') return;
    if (ev.type === 'conversation.item.input_audio_transcription.completed') return log('HEARD:', ev.transcript?.trim());
    if (ev.type === 'response.output_audio_transcript.done') return log('SAID: ', ev.transcript?.trim());
    if (ev.type.includes('dtmf')) {
      log('DTMF', JSON.stringify(ev));
      if (!isRealtime) return say(`The caller pressed key ${ev.event} on the keypad.`);
      const digit = ev.event;
      ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `[The caller pressed key ${digit} on the keypad.]` }] } }));
      ws.send(JSON.stringify({ type: 'response.create' }));
    } else if (ev.type === 'session.closed') {
      log('closed', JSON.stringify(ev).slice(0, 1500));
    } else if (ev.type === 'response.done') {
      log('usage', JSON.stringify(ev.response?.usage));
    } else if (ev.type === 'error') {
      log('error', JSON.stringify(ev));
    } else if (!ev.type.includes('delta')) {
      log('event', ev.type);
    }
  });
  ws.on('close', () => flush() || log('sideband closed', callId, `${((Date.now() - started) / 1000).toFixed(0)}s`));
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    if (req.method !== 'POST' || req.url !== '/openai/webhook') return res.writeHead(404).end();
    if (!verify(req.headers, body)) { log('bad signature'); return res.writeHead(401).end(); }
    res.writeHead(200).end();
    const ev = JSON.parse(body);
    log('webhook', ev.type);
    if (ENGINE === 'live' && (ev.type === 'live.transport.incoming' || ev.type === 'live.call.incoming')) {
      const { session_id, sip_headers } = ev.data;
      log('headers', JSON.stringify(sip_headers));
      const r = await api(`/live/sessions/${session_id}/accept`, { session: {
        type: 'live', model: 'gpt-live-1', instructions: INSTRUCTIONS,
        audio: { output: { voice: VOICE } },
        delegation: { type: 'responses', responses: { model: 'gpt-6-luna', instructions: 'Answer briefly.' } },
      } });
      log('accept live', r.status, r.ok ? '' : await r.text());
      if (r.ok) sideband(`wss://api.openai.com/v1/live/sessions/${session_id}/attach`, session_id, false);
    } else if (ENGINE === 'realtime' && ev.type === 'realtime.call.incoming') {
      const { call_id, sip_headers } = ev.data;
      log('headers', JSON.stringify(sip_headers));
      const r = await api(`/realtime/calls/${call_id}/accept`, { type: 'realtime', model: MODEL, instructions: INSTRUCTIONS, audio: { output: { voice: VOICE }, input: { transcription: { model: 'gpt-4o-mini-transcribe' }, turn_detection: { type: 'server_vad', silence_duration_ms: 300, prefix_padding_ms: 300 } } } });
      log('accept realtime', r.status, r.ok ? '' : await r.text());
      if (r.ok) sideband(`wss://api.openai.com/v1/realtime?call_id=${call_id}`, call_id, true);
    }
  });
}).listen(PORT, '127.0.0.1', () => log(`listening on ${PORT}, model ${MODEL}`));

# WhatsApp Voice Assistant for Kosher Phone: Architecture & Implementation Plan

> Imported from the Google Doc "WhatsApp Voice Assistant Architecture Plan" on 2026-10-05, then updated the same day to match [SPEC.md](SPEC.md). **SPEC.md is the source of truth for behaviour** (briefing format, sending, call flow, code design); this file covers infrastructure, costs, roadmap and the checklist.

## 1. Executive Summary & Objective

### Purpose
Maintain awareness of personal WhatsApp communications while at yeshiva using an ordinary kosher voice phone with no display or internet.

### Core Capabilities
- **Inbound voice briefings:** Dial an Israeli phone line to hear a briefing: urgent messages, then flagged chats read verbatim, then a one-line roll call of every other chat. Drill in, ask questions, or recall the last 4 days.
- **Two-way messaging by voice:** Dictate or describe a message to any contact or group; full read-back, sent only on keypad 1.
- **Voice configuration:** Flag, unflag, mute and unmute chats by voice.
- **Invisible to WhatsApp:** Never marks anything read and never shows me online; my phone's unread state is untouched.

### Not in this version
- **Outbound urgent calls** to the kosher phone. Kept as an optional future phase (§3E).

## 2. End-to-End System Architecture

```
[ Incoming WhatsApp Message ]
              │
              ▼
[ Baileys daemon ]──filter (tier / mention / archived / muted)
              │
              ▼
[ SQLite: store raw immediately ]
              │
              ▼
[ Enrichment queue (gpt-6-luna + transcription) ]
   urgent/trivial · voice-note transcript · image description
              │
              ▼
[ Per-chat summary (debounced, incremental) ]
              │
              ▼
[ Briefing state machine ] ◄──tools── [ OpenAI Realtime SIP agent ]
                                                  ▲
                                                  │ SIP (TLS + SRTP)
                                     [ Yemot 077 number ] ◄── [ Kosher phone ]
```

All server pieces run in **one Node process** (TypeScript via `tsx`) under PM2, sharing one SQLite file.

### Flow Breakdown
1. **Message reception:** A WhatsApp message arrives on the personal account.
2. **Gateway interception:** The Baileys daemon receives it over a companion-device session and filters it by chat tier (SPEC §2.1). My own outgoing messages are stored too, as context.
3. **Store, then enrich:** The raw message is saved immediately. A retrying job queue classifies urgent/trivial, transcribes voice notes and describes images. Each chat's summary is updated a minute or two after its last new message.
4. **Inbound call:** Calling the Israeli number routes via Yemot SIP to OpenAI Realtime SIP. The VPS accepts the webhook, checks caller ID (or PIN), and runs the briefing state machine, handing items to the model via tools.
5. **Sending:** The model drafts; the server sends via Baileys only after a keypad-1 event.

## 3. Component Specifications

### A. Ingestion Layer (Baileys Daemon)
- **Technology & host:** `@whiskeysockets/baileys` on a Hetzner Cloud CX23 (Ubuntu 24.04) under PM2.
- **Authentication:** Paired once as a Multi-Device companion, by QR code or 8-digit pairing code (`PAIRING_PHONE`).
- **Filtering (SPEC §2.1):**
  - DMs: ingested unless muted or archived. Baileys 7 addresses many DMs as `@lid`, so both `@s.whatsapp.net` and `@lid` are accepted.
  - Whitelisted groups: ingested in full. Other groups: only when I'm @mentioned (match my phone JID **and** my LID) or someone quote-replies to me.
  - Archived chats (WhatsApp's own archive state, with *Keep chats archived* turned on) and the mute list: dropped.
  - Status broadcasts dropped. My own outgoing messages stored as context, never reported.
- **Media:** voice notes transcribed, images described (max 2 per chat), other media mentioned by type/caption. Files deleted after processing.
- **Names:** phone address-book names via app-state sync (`contacts.*`), falling back to push name, then number.
- **No read side-effects:** never call `readMessages` or send read receipts; `markOnlineOnConnect: false`; sending a reply must not mark the chat read on my phone (SPEC §3.7, open question 9).
- **Maintenance:** The smartphone must open WhatsApp every 7–12 days to avoid the 14-day inactivity logout.
- **Hosting (Hetzner CX23):**
  - 2 vCPU, 4 GB RAM, 40 GB NVMe, 20 TB traffic, hourly billing. About €3.99/mo plus €0.50 for IPv4 (≈ €4.49). Confirm on Hetzner's site before ordering.
  - 4 GB RAM avoids the Linux OOM killer during sync bursts.
  - Falkenstein (fsn1) or Nuremberg (nbg1): ~50–60 ms to Yemot HaMashiach, <15 ms to OpenAI's EU SIP edge.

### B. Storage, Enrichment & Config
- **Database:** SQLite via `better-sqlite3`, typed queries in `src/db/`, numbered `.sql` migrations.
- **Tables** (details in SPEC §9):

| Table | Purpose |
| --- | --- |
| `messages` | `id`, `chat_jid`, `sender_jid`, `from_me`, `type`, `raw_text`, `transcript` / `media_desc`, `is_urgent`, `is_trivial`, `quoted_id`, `mentions_me`, `heard_at`, `created_at` |
| `chats` | `jid`, `name`, `is_group`, `tier` (flagged / normal / mentions / muted), `archived`, current summary |
| `contacts` | `jid`, `lid`, address-book `name`, `push_name` |
| `jobs` | enrichment/summary queue with retry + backoff |
| `drafts` | unconfirmed messages, offered again on the next call |
| `call_state` | briefing position, for resume after a dropped call |
| `usage` | tokens / minutes / estimated cost per API call |

- **Models:** gpt-6-luna for urgent/trivial classification, chat summaries and image description (verify it accepts images); a cheap OpenAI transcription model for voice notes. $0.10/M input, $0.50/M output for gpt-6-luna. Model names live in config.
- **Config:** `config.yaml` (gitignored; committed `config.example.yaml`) holds the flagged list, mute list, whitelisted groups, my number, PIN, dictation-marker flag (off) and model names. Contacts/groups written **by name**, resolved to JIDs. **Two-way sync:** file edits apply to the DB; voice changes rewrite the file.
- **Retention:** everything older than **4 days** is purged, heard or not. Chat/contact metadata and config are kept. My phone is the full record.

### C. SIP Telephony Layer
- **Provider:** Yemot HaMashiach (free 077 Israeli number), routing SIP directly to OpenAI Realtime SIP. Twilio Israeli DID as a fallback.
- **Port:** 5061 only. OpenAI rejects unencrypted 5060.
- **Encryption:** TLS signaling (`transport=tls`) and SRTP media (`secure: true`). Missing SRTP gives connected, billed calls with silence.
- **Origination URI:** `sip:{OPENAI_PROJECT_ID}@sip.api.openai.com:5061;transport=tls`. The project ID must match the project where the `realtime.call.incoming` webhook is registered.
- **Webhook handshake:** On `realtime.call.incoming`, respond `200 OK` **and** `POST /v1/realtime/calls/{call_id}/accept`.
- **Control WebSocket:** carries tool calls and (if supported) DTMF events.
- **Must verify in phase 3:** DTMF events reach the control socket; my caller ID survives Yemot forwarding; whether input audio can be captured (for voice notes). If any fail, fall back to bridging audio through the VPS (Yemot → VPS → OpenAI Realtime WebSocket), decided then.

### D. Conversational Voice Agent (OpenAI Realtime)
- **Model:** gpt-realtime-mini. Audio priced at $10/M input and $20/M output tokens; per-minute cost to be measured in phase 3.
- **Security:** my kosher phone's caller ID goes straight in; any other number must enter a PIN (3 wrong tries → hang up).
- **Briefing (server-side state machine):** counts greeting (plus a disconnected-WhatsApp warning, resume offer and pending drafts when relevant) → urgent → flagged chats verbatim → roll call (name + count + one-liner) → free conversation. The model never gets the whole inbox at once.
- **Tools:** `next_item`, `read_chat`, `summarize_chat`, `search_recent` (4 days), `draft_message`, `cancel_draft`, `set_chat_tier`, plus `mark_spoken` for heard tracking.
- **Send gate:** read back recipient + full text; **only keypad 1 sends** (enforced server-side). In-context replies are quote-replies. Text by default; voice note on request if feasible.
- **Keypad:** 1 confirm/send, 2 next chat, 3 repeat, 9 cancel, # skip the rest of the briefing.

### E. Outbound Urgent Calls: future phase (not built)
- Currently "urgent" only puts a message first in the briefing. No calls, no auto-replies.
- If revisited: decide triggers, quiet hours (Shabbos/Yom Tov, night, seder), retries, a daily cap, breakthrough contacts, and an outbound-capable provider (Yemot's free line may not support outbound calls).

### Development & Deployment Workflow (Mac → VPS via Git)
- **Local:** Mac, VS Code / Cursor. TypeScript, run with `tsx` (no build step).
- **Layout:** `src/{whatsapp,ingest,briefing,call,config,db,llm}/`, `evals/`, `scripts/`, `test/` (SPEC §10.6).
- **Version control:** Private GitHub repo. `.gitignore` excludes `node_modules/`, `.env`, `auth_session/`, `messages.db`, `*.sqlite`, `config.yaml`, `evals/real/`.
- **VPS auth:** Read-only GitHub deploy key (`ssh-keygen -t ed25519`).
- **Process management:** PM2 (`pm2 start "npx tsx src/server.ts" --name whatsapp-voice`, `pm2 save`, `pm2 startup`).
- **Iteration:** test locally → commit/push → `git pull && npm ci && pm2 restart whatsapp-voice` on the VPS.
- **Logging:** metadata only (chat names, counts, errors, costs), never message text.
- **Backups:** none. If the VPS is lost, re-pair and start fresh.

### Testing
- **Vitest** on core logic: briefing state machine, tier/mention filtering, name resolution, config sync.
- **Text-mode call simulator** (`scripts/simulate`): same state machine and tools, typed input, text model. Real calls only for final checks.
- **Model evals** (`evals/`): a committed synthetic set (Hebrew/English/Yiddish) plus a local-only real set exported from my chats. Checks urgent/trivial classification (urgent recall weighted highest), voice-note transcription and chat one-liners. Run before switching any model.

## 4. Monthly Running Costs

| Component | Provider | Usage | Monthly (USD) |
| --- | --- | --- | --- |
| Cloud VPS (CX23) | Hetzner | 2 vCPU, 4 GB RAM, 40 GB NVMe | ~$5.25 |
| Inbound DID & usage | Yemot | ~100 inbound min | $0.00 |
| Classification + chat summaries | OpenAI gpt-6-luna | ~1,500 messages | ~$0.10 – $0.30 |
| Voice-note transcription + image description | OpenAI | a few hundred items | < $1 |
| Voice interaction | OpenAI gpt-realtime-mini | ~90 min | $2.50 – $4.00 (unverified) |
| WhatsApp egress | Baileys | Unlimited | $0.00 |
| **Total** | | | **~$8 – $10 target** |

- Every API call is logged to the `usage` table; `scripts/costs` shows month-to-date.
- Backstop: a **hard OpenAI project spending limit of ~$20–30/month**.

## 5. Pay-Last Roadmap

- **Phase 1: Local Mac prototyping ($0)**: pair WhatsApp; ingestion into SQLite. **Done** (JS prototype).
- **Phase 1b: Rewrite to the spec ($0–1)**: TypeScript `src/` layout, new schema, filtering, enrichment queue, config sync, briefing state machine, text simulator, evals.
- **Phase 2: Inbound Israeli DID ($0)**: register a free 077/079 number on Yemot HaMashiach.
- **Phase 3: API verification ($5 deposit)**: connect Yemot SIP to OpenAI Realtime SIP via ngrok; verify DTMF, caller ID, input-audio access, no-read-on-send; measure per-minute cost.
- **Phase 4: Production cutover (~$5.25/mo)**: provision Hetzner right before leaving; deploy key, clone, PM2; switch webhooks to the VPS; set the OpenAI spending limit.

## 6. Implementation Checklist

- [x] **1. Local prototyping & gateway**
  - [x] Scaffold Node.js prototype (`db.js`, `whatsapp.js`, `server.js`, `classify.js`)
  - [x] Pair Baileys (pairing code) on Mac
  - [ ] Verify a 1:1 message is intercepted and stored
- [ ] **2. Rewrite to spec (TypeScript, `src/`)**
  - [ ] Project setup: TypeScript, `tsx`, Vitest
  - [ ] DB schema + migrations (SPEC §9)
  - [ ] Config: YAML ↔ SQLite two-way sync, name → JID resolution
  - [ ] Ingest: tier/mention/archive filtering, own messages, contacts/chats sync
  - [ ] No read side-effects: no receipts, `markOnlineOnConnect: false`
  - [ ] Enrichment queue: urgent/trivial, transcription, image description, retries
  - [ ] Debounced per-chat summaries
  - [ ] 4-day purge; metadata-only logging; usage/cost logging
  - [ ] Briefing state machine (greeting, urgent, flagged, roll call, resume, drafts)
  - [ ] Text-mode call simulator
  - [ ] Evals: synthetic set, `export-sample` script, runner
- [ ] **3. Inbound telephony registration**
  - [ ] Register Yemot 077/079 number
  - [ ] Configure SIP trunk to `sip:{OPENAI_PROJECT_ID}@sip.api.openai.com:5061;transport=tls` with TLS + SRTP
- [ ] **4. API verification ($5 deposit)**
  - [ ] Fund OpenAI; add `OPENAI_API_KEY` to `.env`
  - [ ] Point webhook at ngrok; test call from kosher phone
  - [ ] Verify DTMF events, caller ID, input-audio access
  - [ ] Verify sending a reply doesn't mark the chat read or send receipts
  - [ ] Measure realtime cost per minute
  - [ ] Decide: keep direct SIP, or bridge through the VPS
- [ ] **5. Voice agent**
  - [ ] Webhook + control WebSocket, caller ID / PIN check
  - [ ] Tools wired to the briefing state machine
  - [ ] Send gate: full read-back, keypad 1 only; quote-replies; drafts persisted
  - [ ] Voice config commands (flag/unflag/mute/unmute)
  - [ ] Voice notes on request (if feasible)
- [ ] **6. Production cutover**
  - [ ] Provision Hetzner CX23 (fsn1/nbg1)
  - [ ] Deploy key, clone, PM2
  - [ ] Switch webhook URLs from ngrok to VPS
  - [ ] Set OpenAI hard spending limit (~$20–30)
  - [ ] Turn on *Keep chats archived* on the phone
- [ ] **7. Field testing**
  - [ ] Inbound briefing call (flagged verbatim, roll call, drill-in, recall)
  - [ ] Dictated and AI-phrased replies with keypad confirmation
  - [ ] Dropped call → resume + draft recovery
  - [ ] Call from another phone with PIN

## 7. Open Risks
- **Ban risk:** Baileys is unofficial; WhatsApp may ban the number. Test on a secondary number where possible.
- **14-day logout while away:** someone must open WhatsApp on the phone weekly. A disconnected session is announced in the call greeting; no other alerts.
- **Direct SIP limits:** DTMF, caller ID or audio capture may not work over direct SIP (§3C), which would force a VPS audio bridge.
- **Read side-effects:** WhatsApp may mark a chat read when a companion sends; fallback is re-marking it unread (SPEC open question 9).
- **Only one running instance:** two copies of the server sharing `auth_session/` cause 401 logouts.
- **Outbound calling:** deferred (§3E).

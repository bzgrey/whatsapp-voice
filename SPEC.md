# WhatsApp Voice Assistant: Design Spec

> Written 2026-10-05 from a design interview. Supersedes the reporting, urgency and send-message parts of [PLAN.md](PLAN.md). Infrastructure in PLAN.md (Baileys, Hetzner, Yemot → OpenAI Realtime SIP, gpt-6-luna, SQLite) is unchanged unless noted.

## 1. Summary of decisions

| Area | Decision |
| --- | --- |
| Briefing shape | Greeting with counts → urgent → flagged chats (verbatim) → roll call of everything else → free conversation |
| Unit of reporting | The **conversation** (chat), not the individual message |
| Default detail | One-liner per chat; drill in for more |
| Assistant language | English. Verbatim messages are read in their original language, translated only on request |
| "Heard" | Mentioned = heard. Last **4 days** are recallable by voice |
| Outbound calls | **None** for now (future phase) |
| Sending | Verbatim or AI-phrased, full read-back, **keypad 1 to send** |
| Security | Kosher phone's caller ID goes straight in; any other phone needs a PIN |
| Budget | ~$10/month |

## 2. Aggregation model

### 2.1 Chat tiers
Every chat (DM or group) has exactly one tier:

| Tier | Who | Briefing behaviour |
| --- | --- | --- |
| **flagged** | People and groups I mark as important | Read verbatim, automatically, near the start of each call |
| **normal** | All other DMs; whitelisted groups | One line each in the roll call |
| **mentions-only** | Non-whitelisted groups (the default for groups) | Ingested only when I'm @mentioned or someone quote-replies to my message; then treated as normal |
| **muted** | Archived chats + an optional mute list | Not ingested or mentioned at all |

- **Archived = muted.** Uses WhatsApp's own archive state (I will turn on *Keep chats archived* before leaving, so archived chats stay archived when new messages arrive).
- **Mute list:** optional, in config, also editable by voice.
- **Groups:** whitelisted groups are ingested in full; all others are mentions-only.
- Tiers are set in a config file before leaving, and can be changed **by voice**: "flag Yossi", "unflag the shiur group", "mute the building group", "unmute Dovid".

### 2.2 Urgent
- The classifier still marks messages urgent (emergency or truly time-sensitive: illness, accident, someone waiting right now).
- Urgent messages are **not** called out; they are simply announced **first** when I call in, ahead of flagged chats, regardless of tier (except muted).

### 2.3 Per-message processing (at ingest)
Each incoming message is enriched once, cheaply:
- `is_urgent` (boolean)
- `is_trivial`: stickers, "ok", "thanks", lone emoji, reactions
- **Voice notes:** transcribed; the transcript then behaves like text
- **Images:** AI description ("photo of the baby in a sukkah"), plus caption
- **Video, documents, links, contacts, locations:** mentioned by type and caption/filename/title only ("a PDF called invoice.pdf", "a link to a news article")
- No per-message summary is needed any more; summaries are made per conversation at call time (§3.4)

### 2.4 Trivial messages
Collapsed into a tag at the end of a chat's entry ("…plus a couple of reactions and a thumbs-up"). Not counted in message counts.

### 2.5 Media volume
If a chat has many images, describe only a couple (max 2 per chat) and summarize the rest ("…and 6 more photos").

### 2.6 My own messages
Outgoing messages, whether sent by voice or from any other device, are stored as conversation context (so the AI knows "he's answering your question"). They are never read out as news.

## 3. Reporting format (inbound call)

### 3.1 Call opening
1. **Auth** (§6.1).
2. **Health warning** (only if relevant): "Warning: WhatsApp has been disconnected since Tuesday." One sentence, nothing more.
3. **Resume offer** (only if the last call dropped mid-briefing): "Your last call dropped during Yossi. Resume?"
4. **Pending drafts** (only if any): "You had an unsent message to Mom: '…'. Press 1 to send." (§5.6)
5. **Counts greeting**: "You have 1 urgent, 3 flagged chats, and 12 others."

### 3.2 Order
1. **Urgent** messages (any non-muted chat)
2. **Flagged** chats, in order of most recent activity
3. **Roll call** of normal chats (urgent-containing first, then most recent)
4. Free conversation

### 3.3 Flagged chats: verbatim
- Read the unheard messages **verbatim**, in their original language (no translation unless I ask).
- If one chat is longer than **~30 seconds** of reading (~75 words), give a quick summary first, then read it.
- If all flagged content together would exceed **~1 minute**, **ask**: "Mom has 6 messages, about 2 minutes. Read them all or summarize?"

### 3.4 Roll call: the overview
- One entry per chat: **name + count + one-liner**. "Yossi, 3 messages: asking to borrow your sefer."
- Target: the automatic part of the briefing (urgent + flagged-if-short + roll call) is **under 1 minute**.
- One-liners are produced at call time by summarizing each chat's unheard messages together (with the last few days as context), in English.

### 3.5 Drilling in (all modes available)
- "Tell me more about Yossi" → a detailed summary.
- "Read it" → the verbatim messages.
- Free Q&A at any time: "What time did he say?" → answered from the messages.
- "Translate that" → translation of what was just read.

### 3.6 Heard and recall
- A message is **heard** once its chat has been mentioned (roll-call line, verbatim read, or summary) in a call.
- If the call drops, only chats actually spoken count as heard.
- **Recall:** "What did Yossi say yesterday?" works over the last **4 days** of messages, heard or not.
- **Nothing older than 4 days exists** (§10.8). If I haven't called in for longer than that, older messages are gone from the system, heard or not; I can check my phone for them. The briefing doesn't mention them.

### 3.7 Read status on WhatsApp
- The system **never marks messages as read** on WhatsApp: no read receipts (blue ticks), whether or not I've heard them in a call. My phone's unread state stays exactly as if the system weren't there.
- This includes **sending**: a reply sent by voice must not mark that chat read on my phone or send read receipts to the other person.

## 4. Urgency & outbound calls
- **No automatic calls** to the kosher phone in this version. "Urgent" only changes ordering (§2.2).
- No auto-replies to senders.
- **Future phase (optional):** outbound urgent calls. If revisited, still to decide: triggers, quiet hours (Shabbos/Yom Tov, night, seder times), retries, daily cap, breakthrough contacts, and an outbound-capable provider.

## 5. Sending messages

### 5.1 Composing
Two modes, chosen by how I phrase it:
- **Verbatim:** "Send Mom: I'll be home Thursday night." Sends exactly what I said (cleaned of "um"s).
- **AI-phrased:** "Tell Mom that I'll be home Thursday." The AI writes a natural message in my voice.
- Language: **whatever I spoke** in.

### 5.2 Recipients
- Anyone in my **contacts** (phone address-book names synced from WhatsApp), and any **group**.
- **In-context reply:** "Reply to that: …" right after hearing a chat, no name needed.
- **Ambiguous names:** if it's obvious from context (I'm answering the chat just read), don't ask. Otherwise, ask with context: "Dovid Cohen, or Dovid Levi who messaged yesterday?"

### 5.3 Quoting
In-context replies are always sent as a WhatsApp **quote-reply** of the last message in that chat. Messages addressed by name with no context are sent plain.

### 5.4 Confirmation
1. Read back the recipient and the **full text**: "To Mom: 'I'll be home Thursday night.' Press 1 to send."
2. **Keypad 1 = send.** 9 = cancel. Or say a correction ("change Thursday to Friday") → read back again.
3. Speaking "yes" alone does **not** send.
4. After sending: "Sent."

### 5.5 Format
- **Text** by default.
- **Voice note on request:** "Send Mom a voice note" records what I say next and sends my real voice. Play it back before the keypad-1 confirmation, if that's technically easy (see §8, open question 1).
- **Dictation marker: off.** Optional later addition: a small marker (e.g. 🎙️) or a note "(sent by voice)". Keep as a config flag, default off.

### 5.6 Drafts
If the call drops before I confirm, the draft is saved and offered at the start of the next call (§3.1). Never sent without confirmation.

## 6. Call flow

### 6.1 Security
- Caller ID equal to my kosher phone number → straight in.
- Any other caller ID → enter a PIN on the keypad. Wrong PIN 3× → hang up.

### 6.2 Conversation style
After the automatic briefing, it's free conversation. No menus. Voice commands include: next / skip, repeat, more, read it, translate, reply, send to…, flag / unflag / mute / unmute, what did X say…, goodbye.

### 6.3 Keypad shortcuts (DTMF)
Voice always works; the keypad is a fallback for noisy rooms and misrecognition.

| Key | Action |
| --- | --- |
| 1 | Confirm / send |
| 2 | Next chat |
| 3 | Repeat |
| 9 | Cancel |
| # | Skip the rest of the automatic briefing |

### 6.4 Ending and drops
- Ends when I say goodbye or hang up.
- On a drop: record exactly how far the briefing got and any pending draft. The next call offers to resume (§3.1).

## 7. Other

- **Shabbos/Yom Tov:** nothing special. The system keeps ingesting; I won't call.
- **Health:** no notifications to family. Only the one-line warning in the greeting when WhatsApp is disconnected or logged out.
- **Names:** from my phone's contact names (WhatsApp address-book sync). Fall back to push name, then number.
- **Budget:** ~$10/month. Voice-note transcription and image description must fit within this (at ~1,500 messages/month they cost cents, but cap image descriptions per chat as in §2.5).

## 8. Open questions (to verify, mostly in phase 3)

1. **Recording my voice for voice notes.** With direct SIP, audio flows carrier ↔ OpenAI and never reaches the VPS. Need to check whether the Realtime API exposes input audio to the control WebSocket, or whether the call has to be bridged through the VPS. Fallback: drop voice-note sending, or send TTS (not my voice).
2. **DTMF over OpenAI Realtime SIP.** Confirm keypad presses arrive as events. If not, the PIN and keypad-1 confirmation need a Yemot IVR step in front, or a voice fallback.
3. **Caller ID through Yemot.** Confirm the original caller's number reaches OpenAI's `realtime.call.incoming` SIP headers and isn't replaced by the Yemot number.
4. **Contact names in Baileys.** Confirm address-book names arrive via app-state sync (`contacts.upsert` / `contacts.update` `name`) for a linked companion device.
5. **Archive state in Baileys.** Confirm `chats.update` delivers `archived` reliably; snapshot it at startup.
6. **@mention detection under LID.** Mentions may reference my `@lid` rather than my phone JID; match both.
7. **Realtime-mini cost per minute** (from PLAN.md) still to measure; it decides whether the ~$10 budget holds.
8. ~~Data retention~~ Decided in §10.8: everything older than 4 days is deleted.
9. **No read side-effects.** Confirm that Baileys sends no read receipts unless `readMessages` is called, that `markOnlineOnConnect: false` keeps the companion from showing me "online" (and from suppressing notifications on my phone), and whether sending a reply from the companion marks that chat read on my phone. Requirement: it must not (§3.7). If WhatsApp does this on its own, the fallback is to mark the chat unread again straight after sending (Baileys `chatModify({ markRead: false }, jid)`). Also check that no read receipts reach the sender.

## 9. Changes to PLAN.md and the existing code

> The code is being rewritten in TypeScript under `src/` (§10), so the file-level notes below describe *what changes in behaviour*; they land in the new modules, not the current `.js` files.

**PLAN.md** *(done 2026-10-05: PLAN.md now matches this spec)*
- §1 / §2: remove "Outbound urgent alerts" from core capabilities and the architecture diagram; move to a "Future" section.
- §3B: replace the schema (below); drop the "one-sentence summary" design.
- §3D: tools list expands (below); confirmation is keypad 1, not verbal.
- §3E and the outbound-provider risk: mark as future/optional.
- §4: outbound cost row not needed; add transcription/image-description line (cents).
- §6 checklist: replace item 6 (outbound calls) with the new items; add DTMF, caller-ID and voice-note verification to phase 3.

**[db.js](db.js)**
- `messages`: add `chat_jid` (currently only `sender_jid`, so group messages can't be grouped by chat), `from_me`, `type` (text/voice/image/…), `media_desc` / `transcript`, `is_trivial`, `quoted_id`, `mentions_me`, `heard_at`. Drop `summary` and `requires_callback`.
- New `chats` table: `jid`, `name`, `is_group`, `tier` (flagged/normal/mentions/muted), `archived`.
- New `contacts` table: `jid`, `lid`, `name` (address-book), `push_name`.
- New `drafts` table (pending unsent messages) and `call_state` (last call's progress, for resume).
- `getUnheard()` ordering → grouped by chat, tier/urgent ordering per §3.2.

**[whatsapp.js](whatsapp.js)**
- Ingest `fromMe` messages as context instead of skipping them.
- Groups: ingest whitelisted groups fully, others only if they mention me or quote me; skip muted/archived.
- Handle voice notes (download + transcribe), images (download + describe), other media (type + caption), reactions/stickers (trivial).
- Listen to `contacts.*` and `chats.*` for names and archive state.
- `sendWhatsAppMessage` gains `quoted` support and an audio (voice note) variant.
- Track connection status for the greeting warning.
- Never call `readMessages` / `sendReceipt(…, 'read')`; set `markOnlineOnConnect: false`. Sending must not mark the chat read (§3.7, open question 9).

**[classify.js](classify.js)**
- Per-message: `is_urgent`, `is_trivial` only (plus image description as a separate call).
- New per-chat summarizer used at call time for roll-call one-liners and detailed summaries.

**[server.js](server.js)**
- `onUrgent` hook → no outbound call; remove.
- Phase 3: webhook + control WebSocket with tools such as `get_briefing`, `read_chat`, `summarize_chat`, `search_recent` (4 days), `mark_heard`, `draft_message`, `confirm_send` (keypad 1 only), `cancel_draft`, `set_chat_tier`.

**[.env.example](.env.example)**
- Add `MY_PHONE` (caller ID), `CALL_PIN`, `DICTATION_MARKER` (off). `WHITELISTED_GROUPS` stays; add a config file for flagged/mute lists.

## 10. System & code design

### 10.1 Architecture
- **One Node process** under PM2: Baileys, ingest, enrichment worker, webhook, call control. One SQLite file.
- **Audio path: direct SIP** (Yemot → OpenAI Realtime SIP), as in PLAN.md. Phase 3 must test keypad (DTMF) events, caller ID and input-audio access first. If any fail, the fallback is a VPS bridge (Yemot → VPS → OpenAI Realtime WebSocket), decided then.

### 10.2 Ingest pipeline
1. Baileys event → filter (tier, mentions, archived, muted) → **store raw immediately** (including my own outgoing messages).
2. Enrichment job queue (in SQLite): urgent/trivial classification, voice-note transcription, image description.
3. **Per-chat summary updated incrementally**, debounced (e.g. 1–2 min after the last new message in that chat), so the briefing starts with no delay.
4. Failures: jobs retry with backoff. If enrichment is still missing at call time, the briefing falls back to raw text or "a voice note, not yet transcribed".
5. Media files are downloaded to a temp dir and **deleted after processing**; only transcripts and descriptions are kept.

### 10.3 Call control
- **Server-side briefing state machine.** On connect the server builds the queue (greeting → urgent → flagged → roll call) and stores the position in `call_state`.
- The Realtime model gets each item through tools (e.g. `next_item`, `read_chat`, `summarize_chat`, `search_recent`, `draft_message`, `cancel_draft`, `set_chat_tier`). Items are marked heard when the server hands them out and the model confirms they were spoken.
- **Sending is gated server-side:** only a keypad-1 event (or the agreed fallback) can turn a draft into a send. The model cannot send by itself.
- The model is told what to say; it never sees the whole inbox at once (keeps audio-token cost down).

### 10.4 Config
- **YAML file** (`config.yaml`, gitignored, with a committed `config.example.yaml`): flagged list, mute list, whitelisted groups, PIN, my number, dictation-marker flag, model names.
- Contacts and groups are written **by name**; the server resolves them to JIDs and warns on ambiguous or unknown names.
- **Two-way sync with SQLite:** the DB is the live source. The file is watched, and edits apply to the DB. Voice changes ("flag Yossi") rewrite the file. Last change wins. (YAML comments may be lost on rewrite; keep explanations in `config.example.yaml`.)

### 10.5 Models
- **gpt-6-luna** for classification, chat summaries, and image description (if it accepts images; verify).
- A cheap OpenAI transcription model for voice notes.
- **gpt-realtime-mini** for calls.
- Model names live in config so they can be swapped without code changes.

### 10.6 Language & code layout
- **TypeScript, run with `tsx`** (PM2 runs `tsx src/server.ts`; no build step).
- **better-sqlite3** with typed row interfaces, all SQL in `src/db/`, numbered `.sql` migration files.
- Layout:
  ```
  src/
    server.ts          entry: express + startup
    whatsapp/          Baileys socket, contacts/chats sync, send
    ingest/            filtering, storage, job queue, enrichment
    briefing/          state machine, ordering, heard tracking
    call/              Realtime webhook, control WebSocket, tools, DTMF
    config/            YAML load/watch/write, name resolution
    db/                schema, migrations, queries
    llm/               OpenAI clients, prompts, usage logging
  evals/               model test sets + runner
  scripts/             export-sample, simulator, purge, costs
  test/                vitest
  ```

### 10.7 Testing
- **Vitest** unit tests on core logic: briefing state machine, tier/mention filtering, name resolution, config sync. No tests on Baileys glue.
- **Text-mode call simulator** (`scripts/simulate`): drives the same state machine and tools with typed input and a text model. Real phone calls only for final checks.
- **Model evals** (`evals/`):
  - *Synthetic set*, committed: hand-written Hebrew/English/Yiddish cases (emergencies, slang, trivial chatter, mixed language).
  - *Real set*, local only (gitignored): `scripts/export-sample` dumps a sample of real chats to the Mac; I label the expected results.
  - Checks: **urgent/trivial classification** (urgent recall weighted highest), **voice-note transcription** (against hand-corrected transcripts), **chat summaries/one-liners** (LLM judge plus my spot-checks).
  - Image descriptions: not formally evaluated.
  - Run before switching any model.

### 10.8 Operations
- **Retention:** a purge (hourly or nightly) deletes **all messages older than 4 days**, heard or not, along with their transcripts, descriptions, and any chat summary built only from them. Chat/contact metadata and config are kept. My phone remains the full record.
- **Read status:** never mark anything read on WhatsApp (§3.7).
- **Logging:** metadata only (chat names, counts, errors, costs), never message text.
- **Costs:** every API call logs tokens/minutes and estimated cost to a `usage` table; `scripts/costs` (or `/costs`) shows month-to-date. Target ~$10/month. Separately, set a **hard OpenAI project spending limit of ~$20–30/month** as a backstop.
- **Backups:** none. If the VPS is lost, re-pair WhatsApp and start fresh.

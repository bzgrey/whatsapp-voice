# WhatsApp Voice

Hear and answer your WhatsApp from a phone with no screen and no internet: a "kosher phone", a flip phone, a landline.

You call a phone number. An AI voice tells you what's new: urgent messages first, then the people you care about most read word for word, then one line about every other chat. Then you talk to it naturally:

> "Tell me more about the family group." · "What did Dovid say yesterday?" · "Read it." · "Translate that." · "Reply to that: I'll be there at eight." · "Flag Yossi." · "Goodbye."

Messages are only ever sent when you **press 1** on the keypad after hearing the full read-back. Saying "yes" never sends. Nothing is ever marked as read on WhatsApp, so your phone's unread state stays exactly as it was.

## How it works

```
WhatsApp ──► Baileys (linked device) ──► SQLite ──► enrichment queue
                                                    (urgent/trivial, voice-note transcription,
                                                     photo descriptions, per-chat one-liners)
Phone call ──► Israeli number (Yemot) ──► Asterisk relay ──► OpenAI Realtime SIP
                                                              │ tool calls, keypad events
                                                              ▼
                                               briefing state machine (this server)
```

- **Ingest:** a [Baileys](https://github.com/WhiskeySockets/Baileys) companion session (like WhatsApp Web) receives messages. Each chat has a tier: **flagged** chats are read verbatim, **normal** chats get a one-line summary, groups default to **mentions-only** (kept only when you're @mentioned or quote-replied), and **muted** and archived chats are ignored.
- **Enrichment:** voice notes are transcribed, photos described (two per chat), and every message is classified as urgent or trivial. Each chat's one-line summary is refreshed shortly after its last message, so the briefing starts instantly.
- **Calls:** the phone number forwards plain SIP to Asterisk on the server, which bridges to OpenAI's Realtime SIP endpoint with TLS and SRTP. The server accepts the call webhook and drives the conversation over a sideband WebSocket. The model never sees your whole inbox. It asks the server for the next item, a chat to read, a summary, a search, or a draft.
- **Privacy:** messages older than 4 days are deleted automatically. Logs hold only metadata (names, counts, errors, costs), never message text. Your own number skips the PIN; any other caller must enter one.

The behaviour is specified in detail in [SPEC.md](SPEC.md). Infrastructure, costs and the roadmap are in [PLAN.md](PLAN.md), and the server setup is in [deploy/README.md](deploy/README.md).

## Running it

Requires Node ≥ 22 and an OpenAI API key.

```bash
npm install
cp .env.example .env               # OpenAI key, webhook secret, optional pairing phone
cp config.example.yaml config.yaml # your number, PIN, flagged / muted / whitelisted chats
npm start                          # prints a QR code or pairing code to link WhatsApp
```

Then point an OpenAI Realtime SIP project's webhook at `https://<your-host>/openai/webhook`. Receiving real phone calls needs a SIP trunk and the Asterisk relay; see [deploy/README.md](deploy/README.md).

Try a call without a phone, against a sample inbox:

```bash
npm run simulate -- --demo            # type what you'd say; /1 /2 /# for the keypad
```

Other commands:

```bash
npm test                 # unit tests (vitest)
npm run typecheck
npm run evals -- classify   # model checks: classify | summary | transcribe
npm run costs            # month-to-date API spend
```

## Configuration

`config.yaml` is watched while the server runs, and voice commands ("flag Yossi") write back to it. Chats can be written by name, phone number or WhatsApp ID. See [config.example.yaml](config.example.yaml) for every option, including `names:` for choosing what someone is called on the phone.

## Cost

Roughly $10–12 a month for personal use: a small VPS (~$7), about 2¢ per call minute on `gpt-realtime-2.1-mini`, and cents for classification, summaries and transcription. Every API call is logged with its estimated cost.

## Caveats

- **Baileys is unofficial.** WhatsApp may ban numbers that use it. Use at your own risk.
- WhatsApp logs out linked devices after about 14 days if the main phone stays offline, so someone needs to open WhatsApp on it regularly. The call greeting warns you if the connection is down.
- Built for one person's setup (an Israeli number via Yemot HaMashiach, English-speaking assistant, Hebrew/English/Yiddish messages), but the pieces are general.

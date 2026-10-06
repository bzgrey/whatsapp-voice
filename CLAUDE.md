# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A WhatsApp voice assistant for a yeshiva student with a kosher phone (no screen, no internet). A Baileys companion session ingests his WhatsApp. He dials an Israeli number (Yemot → Asterisk relay on the VPS → OpenAI Realtime SIP) and hears a briefing, asks questions, and dictates replies.

- **SPEC.md is the source of truth for behaviour** (briefing format, tiers, sending, call flow, code design).
- **PLAN.md** covers infrastructure, costs, the roadmap and the checklist. Update its checklist when you finish something.
- **This repo is public** (github.com/bzgrey/whatsapp-voice). Never commit real phone numbers, the PIN, family names, the server IP/hostname or the Yemot number; use placeholders. The real values live only in gitignored `config.yaml` and `deploy/LOCAL.md`. Push only `master` (a local `backup/pre-scrub` branch holds unscrubbed history).
- **Deploy:** push, then on the server `git pull --ff-only && npm ci && systemctl restart whatsapp-voice` (see deploy/README.md; SSH details in `deploy/LOCAL.md`).
- **deploy/README.md** describes the VPS call-path test setup (Asterisk, Caddy, `deploy/voice-test/webhook.mjs`). The VPS now runs the full app as `whatsapp-voice.service`; `voice-test` is retired. Restarting drops a live call, so check `asterisk -rx "core show channels"` first.

## Commands

TypeScript run directly with `tsx` (no build step). Node ≥ 22.

```bash
npm start                       # server: Baileys + job worker + express on 127.0.0.1:$PORT
npm test                        # vitest
npx vitest run test/session.test.ts          # one file
npx vitest run -t "only sends on keypad 1"   # one test by name
npm run typecheck               # tsc --noEmit
npm run simulate -- --demo      # text-mode call against a throwaway demo inbox (uses OPENAI_API_KEY)
npm run simulate -- --demo --manual          # no model: type tool calls, e.g. draft_message {"to":"Mom","text":"hi"}
npm run simulate -- --caller 0521234567      # PIN path; keypad as /1 /2 /# , /drop, /quit
npm run evals -- classify|summary|transcribe [--set real] [--model X]   # run before switching any model
npm run export-sample           # dump real chats to evals/real/ (gitignored) for labelling
npm run costs                   # month-to-date API spend from the usage table
```

Without `--demo`, the simulator runs on the real `messages.db` and marks messages heard. Only one process may use `auth_session/` at a time: a second Baileys instance causes 401 logouts. Check nothing else is running before `npm start`.

## Architecture

One Node process (`src/server.ts`) with one SQLite file. Secrets and paths come from `.env` (`src/env.ts`). Behaviour settings live in `config.yaml` (template: `config.example.yaml`).

**Ingest path:** Baileys events (`src/whatsapp/socket.ts`) → `extract()` normalizes a WAMessage (`src/ingest/extract.ts`, typed structurally so tests use plain objects) → `Ingest.handle()` (`src/ingest/ingest.ts`). Ingest canonicalizes the JID (prefers the phone JID over `@lid` and merges LID chats once a mapping is known), filters by chat tier, stores the raw row immediately, then queues jobs. `JobWorker` (`src/ingest/jobs.ts`) polls the `jobs` table with retry and backoff. `Enricher` (`src/ingest/enrich.ts`) does transcription, image description (max 2 per chat), urgent/trivial classification, and debounced per-chat one-liner summaries. Media is downloaded into memory from a serialized `media_ref`, which is cleared after processing.

**Tiers** (`flagged` / `normal` / `mentions` / `muted`) are computed by `computeTier()` in `src/config/sync.ts` from config lists (written as names), the archive state and the group whitelist. `ConfigSync` holds the two-way sync: file edits re-apply to `chats.tier`, and voice commands rewrite the file. Always create or update chats through `ConfigSync.upsertChat()`, never `Store.upsertChat()` directly. Otherwise a new chat gets the default `normal` tier, and mentions-only groups get ingested in full (a real bug found on live data).

**Call path:** `CallSession` (`src/briefing/session.ts`) is the engine-agnostic state machine: PIN or caller-ID auth, then a step queue (WhatsApp-down warning → resume offer → pending draft → counts greeting → items). `buildBriefing()` (`src/briefing/build.ts`) orders items as urgent → flagged (verbatim; summarized first or "read or summarize?" when long) → roll call in batches. Adapters drive it with `opening()`, `tool(name, args)`, `dtmf(digit)`, `confirmSpoken()` (when a model response finishes) and `end()`. Outputs are plain-text instructions for the model. Tool schemas and system instructions live in `src/call/tools.ts`. The call model is **gpt-realtime-2.1-mini**. `src/call/webhook.ts` verifies the OpenAI webhook signature, accepts `realtime.call.incoming` and opens the sideband WebSocket. `src/call/realtime.ts` (`RealtimeCall`) is the only engine-specific code. It runs tool calls from `response.done`, injects server notes as bracketed user messages, and makes keypad events cancel the current response. It confirms heard only on a *completed* spoken response, and hangs up after the goodbye has had time to play, with a 15 s backstop. Set `CALL_DEBUG_TRANSCRIPTS=1` to log what the caller said and what the model said (off by default: it's message content).

Invariants enforced in code:
- **Only keypad 1 sends** (`CallSession.send()`, reached only via `dtmf('1')`). No tool can send.
- **Heard tracking:** message ids handed to the model become heard only on confirmation: the next tool call, `confirmSpoken()`, or keypad 2. A drop leaves them unheard and the call `dropped`, so the next call offers resume.
- **Never mark anything read on WhatsApp:** no `readMessages`/receipts, `markOnlineOnConnect: false`. After a send, the chat is optionally re-marked unread.
- **4-day retention:** `Store.purgeBefore()` runs hourly and deletes messages, drafts and summaries built only from them. Ingest ignores older messages.
- **Logging is metadata only** (`src/log.ts`): names, counts, errors, never message text. `silenceLibsignal()` drops libsignal's console output, which includes session key material.

**DB:** all SQL is in `src/db/store.ts`. The schema is in numbered `src/db/migrations/*.sql`, applied by `PRAGMA user_version`. Times are unix seconds. The prototype's old `messages` table is renamed to `legacy_messages` on first migration.

**LLM:** `src/llm/openai.ts` is a thin fetch client that logs every call's cost to `usage` (prices in `src/llm/prices.ts`). Prompts and task wrappers are in `src/llm/tasks.ts`. Model names come from `config.yaml` `models:`. gpt-6-luna on Chat Completions rejects function tools unless `reasoning_effort: 'none'`; the client sets this automatically when tools are passed.

## Tests

Vitest covers the core logic only (briefing, session, tier/mention filtering, name resolution, config sync, jobs, purge), not the Baileys glue. `test/helpers.ts` provides an in-memory store, a temp `config.yaml`, a fake sender and a seeded address book.

# Server

Copies of what runs on the VPS, so the setup isn't only on the server. Set up 2026-10-06.

## Production service (since 2026-10-06)
- The full app runs from `/opt/whatsapp-voice` as `whatsapp-voice.service` (`systemd/whatsapp-voice.service`, runs `npm start`). It replaced `voice-test`, which is stopped and disabled.
- Deploy from the Mac (no git remote; `.env`, `auth_session/` and `messages.db` live only on the server):
  `rsync -az -e "ssh -i ~/.ssh/whatsapp_voice_vps" --exclude node_modules --exclude auth_session --exclude 'messages.db*' --exclude .env --exclude .git --exclude evals/real --exclude tmp ./ root@SERVER_IP:/opt/whatsapp-voice/`
  then `npm ci` if dependencies changed, and `systemctl restart whatsapp-voice`. Restarting drops a live call: check `asterisk -rx "core show channels"` first.
- `config.yaml` is synced by the rsync above. Voice commands rewrite the server's copy, so pull it back before overwriting it.
- WhatsApp is linked to the VPS (pairing code, 2026-10-06). The Mac's old link is unused. Logs: `journalctl -u whatsapp-voice`; status: `curl localhost:3000/health`.

## Server
- Hetzner Cloud CX23, Falkenstein/Nuremberg, **Ubuntu 26.04**, IP **SERVER_IP**, $7.09/mo.
- SSH: `ssh -i ~/.ssh/whatsapp_voice_vps root@SERVER_IP` (key on the Mac only).
- Firewall (`ufw`): 22/tcp, 80+443/tcp, 5060/udp **from 147.236.146.0/24 only** (Yemot), 10000–20000/udp (RTP).

## Call path
```
Kosher phone → Yemot 077-XXX-XXXX (root ext: type=routing_ip → SERVER_IP:5060, routing_extension=assistant)
  → Asterisk (plain SIP/UDP in; TLS + SDES-SRTP out) → sip:<project>@sip.api.openai.com:5061
  → OpenAI webhook → https://SERVER-IP-DASHED.sslip.io/openai/webhook (Caddy → node :3000)
  → src/call/webhook.ts accepts the call and attaches the sideband WebSocket (voice-test/webhook.mjs before 2026-10-06)
```

## Files
| Repo | Server |
| --- | --- |
| `asterisk/pjsip.conf` | `/etc/asterisk/pjsip.conf` (replace `OPENAI_PROJECT_ID`; originals in `/root/asterisk-orig/`) |
| `asterisk/extensions.conf` | `/etc/asterisk/extensions.conf` (`from-yemot` is the old hello-world/DTMF echo test, unused) |
| `caddy/Caddyfile` | `/etc/caddy/Caddyfile` (`sslip.io` hostname, Let's Encrypt) |
| `systemd/voice-test.service` | `/etc/systemd/system/voice-test.service` |
| `voice-test/webhook.mjs` | `/opt/voice-test/webhook.mjs` (throwaway test handler; `.env` per `voice-test/.env.example`) |

Packages: `asterisk asterisk-core-sounds-en-gsm caddy nodejs npm ufw`; `npm i ws` in `/opt/voice-test`.

## Gotchas found
- Yemot `routing_ip` sends plain SIP to a fixed IP; OpenAI needs TLS 5061 + SRTP, hence Asterisk.
- OpenAI's cert is `*.api.openai.com`: Asterisk needs `allow_wildcard_certs=yes` on the TLS transport.
- Realtime models: webhook `realtime.call.incoming`, accept `POST /v1/realtime/calls/{call_id}/accept`, sideband `wss://api.openai.com/v1/realtime?call_id=…`. DTMF event: `input_audio_buffer.dtmf_event_received` (digit in `event`).
- gpt-live-1: webhook `live.transport.incoming` (must be ticked on the webhook), accept `POST /v1/live/sessions/{session_id}/accept` with a `session` object, sideband `wss://api.openai.com/v1/live/sessions/{id}/attach`. Doesn't speak first. Both webhooks fire for each call; only one may accept.
- Caller ID arrives in `From` (e.g. `sip:05XXXXXXXX@…`); treat as untrusted per OpenAI.
- Free Yemot plan plays an ad before routing (~₪30–50/mo to remove).
- Asterisk `pjsip set logger on` / `core set verbose` reset on restart; `full` log configured in `logger.conf`.

## Yemot
Managed via API (`https://www.call2all.co.il/ym/api`, token `NUMBER:PASSWORD` from `.env`): `GetTextFile` / `UploadTextFile` on `ivr2:/ext.ini`. Root was `type=menu`; extension 5 was `type=playfile` (also now routing_ip).

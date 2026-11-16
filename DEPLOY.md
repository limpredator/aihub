# Deploying to production

Scoped ahead of time so this is a checklist to follow, not a design session,
when you're ready to go live. Nothing here has been executed yet.

## What actually needs deploying

Two separate processes, with very different exposure needs:

1. **The call gateway** (`npm run dev` / `src/index.ts`) — registers
   outbound to `pbx.cerdik.co` as a SIP ring-group member. Per the README,
   it needs **no inbound ports at all** — SIP and RTP media both ride
   through the existing Kamailio proxy, the same way the office softphones
   already work. This means the droplet's firewall can stay outbound-only
   plus SSH; no Caddy/TLS/reverse-proxy is needed for this process.
2. **The dashboard** (`npm run dashboard` / `src/dashboard/server.ts`) —
   plain HTTP, **no auth**. This one *does* need inbound exposure if you
   (or a client) want to check it from outside the box, and that's the
   part that needs a decision before going further (see "Open decision"
   below).

## Droplet

- Ubuntu 22.04/24.04 LTS, smallest size first (1 vCPU / 1 GB) — bump if
  concurrent calls make STT/TTS streaming CPU-bound; nothing here is
  memory-heavy per call.
- Install: `node` (LTS, matching what's in `package.json` engines if
  pinned), `npm`, `pm2` (`npm i -g pm2`).
- `ufw`: `ufw default deny incoming`, `ufw allow 22/tcp` (SSH), `ufw allow
  OpenSSH`, `ufw enable`. No other inbound rule unless the dashboard is
  exposed (see below). All SIP/RTP/API traffic from this box is outbound,
  so nothing else needs opening.

## Getting the code and secrets on

```bash
git clone https://github.com/limpredator/aihub.git
cd aihub
npm install
cp .env.example .env   # then fill in real values — never commit this file
```

Secrets needed in `.env` on the box: `OPENROUTER_API_KEY`,
`SPEECHMATICS_API_KEY`, `TTS_API_KEY` (ElevenLabs), `SIP_EXTENSION` /
`SIP_PASSWORD` for whatever ring-group member this deployment represents.
Copy real values over via `scp`/paste through SSH — never through git.

## Running it with pm2

```bash
pm2 start npm --name aihub-gateway -- run dev
pm2 start npm --name aihub-dashboard -- run dashboard
pm2 save
pm2 startup   # follow the printed command to survive reboots
```

(`npm run dev` currently runs via `tsx` directly rather than a build step —
fine for pm2 to manage as-is; revisit only if cold-start time becomes an
issue.)

## Open decision: exposing the dashboard

The dashboard has no login. Before putting it on the public internet,
pick one:

- **Keep it private** — don't open any port for it; reach it only via SSH
  tunnel (`ssh -L 8080:localhost:3900 user@droplet`) when you need to check
  calls or edit the company profile. Zero extra infra, zero exposure.
- **Expose it properly** — add basic auth (or real auth — this is the
  Phase 2 multi-tenant work mentioned in the README) in front of it, then
  put Caddy on the box as a reverse proxy for free TLS:
  ```
  dashboard.cerdik.co {
      reverse_proxy localhost:3900
  }
  ```
  plus `ufw allow 80,443/tcp`. Caddy only enters the picture for this,
  never for the call path itself.

Default to the SSH-tunnel option until there's an actual second person
(client or staff) who needs dashboard access without you there to tunnel
for them.

## Before the first real call

- Fill in the three API keys above and confirm the health check
  (`src/health/healthCheck.ts`) reports healthy — it deregisters from the
  proxy automatically if any dependency is down, so a healthy state is the
  real smoke test.
- Resolve the still-open phone-number question (which of the two numbers
  on cerdik.co the AI should read out) — the prompt currently blocks
  stating any number until this is settled.
- Watch `pm2 logs aihub-gateway` through the first few real inbound calls;
  the README flags SIP stream framing and realtime STT as unverified
  against actual PBX traffic.

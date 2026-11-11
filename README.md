# aihub

Cerdik AI receptionist gateway — pilot scope: one office, one outside line,
one in-house CD-series PBX ring group. Registers as a SIP member of that
ring group through the existing Kamailio proxy (`pbx.cerdik.co`), runs an
STT &rarr; LLM &rarr; TTS pipeline per call, and deregisters when a dependency
is unhealthy so the ring group's own no-answer timeout falls through to a
human extension (fail-open).

Runs anywhere with outbound internet — no need to be on the office LAN.
Nothing here needs inbound ports: SIP registration and media both go
through the Kamailio proxy / rtpengine, same as the existing softphone app.

## Status

Scaffold only. Not yet able to take a real call. What's blocking that:

1. **SIP media** (`src/sip/sipClient.ts`) — registration (REGISTER + digest
   auth) is implemented against RFC 3261/2617, but untested end-to-end: it
   needs a provisioned `SIP_EXTENSION`/`SIP_PASSWORD` and ring group
   membership on the PBX side before it can be exercised for real. There's
   also no INVITE/media handling yet — once registration is confirmed live,
   the next piece is accepting an INVITE and sending/receiving RTP (G.711 —
   no library needed, it's a simple codec to implement in pure JS).

   Decision made: plain SIP/TLS (port 5061), the same transport the native
   Linphone clients already use against this proxy in production — not WSS,
   which would imply WebRTC media (ICE/DTLS-SRTP) and a native Node WebRTC
   stack for no benefit here.
2. **Realtime STT** (`src/stt/speechmatics.ts`) — targets Speechmatics'
   realtime endpoint with `melia-1`, unverified. The transcriptor app only
   exercises their batch job API; confirm the realtime endpoint actually
   supports this model and config shape against real audio.

What's already real and usable:

- `src/llm/openrouter.ts` — working OpenRouter chat-completions client with
  function calling wired to `src/llm/functions.ts`.
- `src/callStore/callRecordStore.ts` — pluggable store, same pattern as
  `CRM/shared/src/pbx-connector.ts`; starts as a no-op, swap in a CRM-backed
  implementation later without touching call-handling code.
- `src/health/healthCheck.ts` — pre-flight fail-open loop: deregisters from
  the proxy when OpenRouter/Speechmatics/TTS aren't reachable or configured.
  Mid-call failure recovery (SIP REFER) isn't built yet.
- `src/tts/ttsClient.ts` — interface only; vendor (ElevenLabs / Polly /
  Azure) not yet decided — see Cerdik PBX's `docs/research-ai-receptionist.md`
  for the Bahasa Malaysia TTS coverage gap this needs to resolve first.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env` — at minimum `OPENROUTER_API_KEY` and `SPEECHMATICS_API_KEY`
to get past the health check, plus `SIP_EXTENSION`/`SIP_PASSWORD` once the
ring group member is provisioned on the PBX side.

```bash
npm run dev
```

## Multi-machine dev

Secrets live in `.env` (gitignored), never committed. Clone this repo on
both the home PC and the work laptop, copy `.env.example` to `.env` on
each, fill in the same values, and `git pull`/`git push` to sync code —
nothing here is tied to a specific machine or network.

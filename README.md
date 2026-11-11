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

Full call path is wired end-to-end in code (INVITE → RTP media → STT → LLM
→ attempted TTS), typechecks, and runs without crashing locally — but it is
still **unverified against the real PBX/proxy**. What's blocking a live
call:

1. **PBX provisioning** — needs a `SIP_EXTENSION`/`SIP_PASSWORD` and ring
   group membership on the PBX side. Deferred by design (not urgent) until
   the rest of this list is ready to test against.
2. **Realtime STT** (`src/stt/speechmatics.ts`) — targets Speechmatics'
   realtime endpoint with `melia-1`, unverified. The transcriptor app only
   exercises their batch job API; confirm the realtime endpoint actually
   supports this model and config shape against real audio.
3. **TTS vendor** (`src/tts/ttsClient.ts`) — interface only, no
   implementation. `UnconfiguredTtsClient` throws by design; `CallSession`
   catches that and logs what the receptionist *would* have said, so the
   STT→LLM half is exercisable without blocking on this. See Cerdik PBX's
   `docs/research-ai-receptionist.md` for the Bahasa Malaysia TTS coverage
   gap this needs to resolve first.
4. **SIP stream framing is still simplified** (`src/sip/sipMessage.ts` —
   `SipStreamFramer`) — it buffers on `\r\n\r\n` + `Content-Length`, which
   is spec-correct, but has not been exercised against a real proxy's exact
   byte-chunking behavior.

What's implemented:

- `src/sip/sipClient.ts` + `sipMessage.ts` — REGISTER with digest-auth
  challenge/retry (RFC 3261/2617), plain SIP/TLS on port 5061 (same
  transport the native Linphone clients already use against this proxy in
  production — chosen over a Node WebRTC stack for no benefit on a path
  that's already proven). After registering, stays on the socket and
  handles inbound INVITE (emits an event, caller answers/rejects with SDP),
  ACK (silently consumed — UAS doesn't ACK its own 200 OK), and BYE
  (200 OK + event).
- `src/media/g711.ts` — mu-law PCM16↔u-law codec (standard BIAS/CLIP
  table-based algorithm), `sdp.ts` — minimal PCMU/8000 offer parse/answer
  build, `rtpSession.ts` — UDP RTP session (header construction, inbound
  parse).
- `src/call/callSession.ts` — orchestrator: INVITE → RTP session → decoded
  audio → Speechmatics → `runTurn()` (OpenRouter/Haiku) → TTS attempt (logs
  the reply text on failure) → re-encoded RTP back out. Tool calls (route /
  take message / transfer / end call) are logged; routing them to actual
  SIP actions (REFER, hangup) isn't built yet.
- `src/llm/openrouter.ts` — working OpenRouter chat-completions client with
  function calling wired to `src/llm/functions.ts`.
- `src/callStore/callRecordStore.ts` — pluggable store, same pattern as
  `CRM/shared/src/pbx-connector.ts`; starts as a no-op, swap in a CRM-backed
  implementation later without touching call-handling code.
- `src/health/healthCheck.ts` — pre-flight fail-open loop: deregisters from
  the proxy when OpenRouter/Speechmatics/TTS aren't reachable or configured.
  Mid-call failure recovery (SIP REFER) isn't built yet.

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

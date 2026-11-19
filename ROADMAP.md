# Roadmap: multi-tenant console + other verticals

Scoped after seeing TigerTMS's AskTiger demo — a dashboard listing one
deployed agent per hotel, with a "press call" button that live-tests that
specific agent right in the browser. Two separate features below, plus
where else this kind of AI receptionist is sellable beyond the current
PBX-supplier client.

## 1. Live "test call" in the browser

This is the single most impressive thing in that demo, and it's buildable
without touching the phone network at all — it's not actually placing a
call, it's a WebRTC/WebSocket mic↔speaker session talking directly to the
same brain a real call uses.

**Why it's realistic:** `CallSession` (`src/call/callSession.ts`) already
separates "get audio in, decode, run the STT→LLM→TTS turn, encode, send
audio out" from the transport that carries that audio. Right now the only
transport is RTP/SIP (`src/media/rtpSession.ts`). A browser test call is
just a second transport — browser mic → WebSocket → same turn logic → TTS
audio → WebSocket → browser speaker — reusing everything except the wire
format.

**Scope:**
- New endpoint (likely on the dashboard server, or a sibling WS server):
  accepts a WebSocket per test session, receives browser mic audio
  (Opus/PCM via the Web Audio API or `MediaRecorder`), feeds it into the
  same pipeline `CallSession` uses (Speechmatics → OpenRouter turn →
  ElevenLabs), streams the TTS audio back over the same socket.
- Refactor `CallSession`'s audio I/O into an interface both RTP and this
  WebSocket transport implement, so the call-handling logic (tool calls,
  transcript, summary, `CallRecord`) doesn't change at all — a test call
  can even write a normal `CallRecord` tagged `source: "test"` so you see
  it in the dashboard like a real call.
- Dashboard UI: a "Test this agent" button on the Company Profile page
  (or a per-tenant list once multi-tenant exists) that opens a small
  call-style UI — mic permission prompt, live transcript bubbles (reusing
  the existing `.bubble`/`.transcript` CSS from the call detail view),
  hang-up button.
- No telephony cost per test — it never touches the PBX/Kamailio proxy or
  SIP at all, so this is cheap and safe to let a prospect try live during
  a sales call, which is clearly part of what sold *you* on AskTiger.

**Effort:** medium — the audio-transport refactor is the real work; the
STT/LLM/TTS pipeline itself needs zero changes.

## 2. Multi-tenant agent list (the "one row per hotel" screen)

This is Phase 2, already flagged in the README/earlier scoping, now with
a concrete UI target: a dashboard home screen listing every deployed
agent (one per client), each with status (from `healthCheck.ts`), basic
stats, a link into that agent's Company Profile, and the "Test this
agent" button from above.

**Scope (builds directly on what's already shipped):**
- `TenantConfig` becomes `TenantConfig[]` keyed by tenant id — one
  `data/tenant-config/<tenantId>.json` instead of a single file.
- Each tenant needs its own SIP identity (extension/number) so an inbound
  call resolves to the right `TenantConfig`; `CallSession` picks up the
  tenant from which SIP registration/extension received the INVITE.
- Dashboard needs real auth before this is safe to expose at all — right
  now anyone who can reach the dashboard can edit any config. Minimum
  viable: a single shared login for you/staff; per-client logins are a
  later step and only matter once clients get their own access.
- The agent-list screen itself is mostly new dashboard UI reusing patterns
  already built (`.card`, `.pill`, the `renderProfile`/`renderDetail`
  split) — not a new architecture, just a new top-level view plus a
  tenant picker.

**Effort:** larger — this is real infra (data model change, auth, call
routing by tenant), not a UI tweak. Worth doing once there's a second
real client lined up, not before.

## 3. Other situations/verticals this AI fits

The underlying shape — answer the phone, know the business, answer from
confirmed facts only, take an action (route / log a request / take a
message) instead of just talking — isn't hotel-specific or PBX-specific.
Roughly in order of "closest to what's already built" → "needs new tool
calls":

- **Clinics / dental / medical** — appointment booking & reschedule,
  intake notes, strict "never diagnose, never confirm availability of a
  specific slot without checking" rules. Already proven: the Bright Smile
  Dental Clinic test case during the import-feature test fit this
  perfectly with zero code changes — just a `TenantConfig`.
- **Restaurants** — reservations, takeaway order taking, menu Q&A, "kitchen
  closes at X" hours logic. Needs a new tool call (`take_reservation` with
  party size/time) beyond route/message/end-call.
- **Property/strata management** — resident maintenance requests, noise
  complaints, visitor registration. Very close to AskTiger's own
  "housekeeping fault logging" pattern — `take_message` already covers a
  structured request with minor extension (category + urgency fields).
- **Trades/service businesses** (aircon servicing, plumbers, IT support) —
  booking a service call, triaging urgency, quoting callback windows
  instead of prices. Same shape as the current PBX-supplier client, just
  a different `TenantConfig`.
- **Real estate agencies** — viewing bookings, listing Q&A, lead capture
  for an agent to call back.
- **Professional services** (law firms, accountants) — appointment intake,
  conflict-check-style structured questions, strict hand-off-to-human
  rules (never give legal/financial advice — same pattern as "never state
  a price").
- **Retail/e-commerce support lines** — order status lookups, returns
  policy Q&A; this one needs a real integration (order system API) rather
  than just `TenantConfig` content, so it's a step up in effort.

**What's genuinely reusable right now, no new code:** anything where the
job is "answer from known facts + route/take a message" — that's the
current `TenantConfig` + three tools, already working, already provable
in the dashboard with the free-text import flow. **What needs new tool
calls:** anything that needs to *check or change* external state
(book a specific time slot, look up an order) rather than just capture a
request for a human to act on later — that's a case-by-case integration,
not a platform change.

## Suggested order

1. Live test-call console (#1) — cheap, high-impact, reusable in every
   future sales conversation, no infra prerequisites.
2. Keep selling single-tenant deployments into adjacent verticals (#3,
   top of the list) using what's already built — proves demand before
   investing in multi-tenancy.
3. Multi-tenant agent list + auth (#2) — once there's a second paying
   client, not before; this is the point where Phase 2 stops being
   theoretical.

import { SipClient, type IncomingCall } from "../sip/sipClient.js";
import { RtpSession } from "../media/rtpSession.js";
import { parseOffer, buildAnswer } from "../media/sdp.js";
import { encodeMulaw, decodeMulaw } from "../media/g711.js";
import { SpeechmaticsRealtimeClient } from "../stt/speechmatics.js";
import { runTurn, type ChatMessage } from "../llm/openrouter.js";
import { buildSystemPrompt } from "../llm/prompt.js";
import { ElevenLabsTtsClient, UnconfiguredTtsClient, type TtsClient } from "../tts/ttsClient.js";
import type { CallRecordStore } from "../callStore/callRecordStore.js";
import { config } from "../config.js";

// Wires one inbound call together: RTP media <-> STT -> LLM -> (TTS).
// Falls back to UnconfiguredTtsClient (throws by design) until
// TTS_PROVIDER/TTS_API_KEY/TTS_REGION are filled in — caught and logged
// rather than crashing the call, so everything up to "what the receptionist
// would have said" is exercisable without a TTS vendor configured.

function buildTtsClient(): TtsClient {
  if (config.tts.provider === "elevenlabs" && config.tts.apiKey) {
    return new ElevenLabsTtsClient({ apiKey: config.tts.apiKey, voiceId: config.tts.voiceId });
  }
  return new UnconfiguredTtsClient();
}

const tts = buildTtsClient();

export function attachCallHandling(sip: SipClient, store: CallRecordStore): void {
  sip.on("invite", (call) => {
    handleInvite(sip, call, store).catch((err) => {
      console.error(`[call ${call.callId}] failed:`, err);
      call.reject(500, "Server Error");
    });
  });
}

async function handleInvite(sip: SipClient, call: IncomingCall, store: CallRecordStore): Promise<void> {
  console.log(`[call ${call.callId}] incoming INVITE from ${call.callerId}`);
  await store.create({ callId: call.callId, caller: call.callerId, startedAt: new Date() });

  const remote = parseOffer(call.remoteSdp);
  console.log(`[call ${call.callId}] offer wants RTP sent to ${remote.address}:${remote.port}`);
  const rtp = new RtpSession({ localPort: 0, remoteAddress: remote.address, remotePort: remote.port });
  const localPort = await rtp.ready();

  const localAddress = sip.getLocalAddress();
  console.log(`[call ${call.callId}] answering with SDP address ${localAddress}:${localPort}`);
  call.answer(buildAnswer({ localAddress, localPort }));

  const messages: ChatMessage[] = [{ role: "system", content: buildSystemPrompt(config.ringGroup.extensions) }];

  // Guards against double cleanup when both a BYE and a tool-call/fail-open
  // path try to tear down the same call.
  let ended = false;
  let debounceTimer: NodeJS.Timeout | null = null;
  const endMedia = () => {
    if (ended) return;
    ended = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    rtp.close();
    stt.close();
  };

  const speakReply = async (text: string) => {
    console.log(`[call ${call.callId}] replying: "${text}"`);
    messages.push({ role: "assistant", content: text });
    try {
      const audio = await tts.synthesize(text, "en");
      speakMulaw(rtp, audio);
    } catch (err) {
      console.warn(`[call ${call.callId}] TTS unavailable, would have said: "${text}" (${(err as Error).message})`);
    }
  };

  // Speechmatics emits a separate AddTranscript (final) per utterance boundary
  // it detects internally, not one per caller turn — a mid-sentence pause
  // splits what the caller meant as one thought into several finals (seen
  // live 2026-11-16: "8." and "好啊一." arrived as two finals from what was
  // almost certainly one sentence). Running the LLM on every final treats
  // each fragment as the caller's whole turn, producing confused replies.
  // Debounce: buffer finals and only run a turn once the caller's been
  // quiet for a bit, joining anything buffered in the meantime.
  const pendingUtterance: string[] = [];

  const runPendingTurn = async () => {
    debounceTimer = null;
    const text = pendingUtterance.join(" ").trim();
    pendingUtterance.length = 0;
    if (!text || ended) return;

    console.log(`[call ${call.callId}] caller said: "${text}"`);
    messages.push({ role: "user", content: text });

    let turn: Awaited<ReturnType<typeof runTurn>>;
    try {
      turn = await runTurn(messages);
    } catch (err) {
      console.error(`[call ${call.callId}] LLM turn failed, falling back to human:`, err);
      failOpen(sip, call, store, endMedia);
      return;
    }

    if (turn.reply) await speakReply(turn.reply);

    for (const toolCall of turn.toolCalls) {
      console.log(`[call ${call.callId}] tool call: ${toolCall.function.name}(${toolCall.function.arguments})`);
      handleToolCall(sip, call, store, endMedia, toolCall);
    }
  };

  const stt = new SpeechmaticsRealtimeClient();
  await stt.connect((partial) => {
    if (!partial.isFinal || !partial.text.trim() || ended) return;

    pendingUtterance.push(partial.text.trim());
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      runPendingTurn().catch((err) => console.error(`[call ${call.callId}] turn handling failed:`, err));
    }, 900);
  });

  // Speak first so the caller (and whoever's testing) has immediate proof
  // the call connected, instead of silence until they happen to say
  // something — asked for explicitly after a live test where it wasn't
  // obvious the call had gone through (2026-11-16).
  await speakReply("Hello, thank you for calling Cerdik Tech. How can I help you today?");

  rtp.on("audio", (mulawPayload: Buffer) => {
    if (ended) return;
    const pcm16 = decodeMulaw(mulawPayload);
    stt.sendAudio(Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength));
  });

  sip.once("bye", (byeCallId) => {
    if (byeCallId !== call.callId) return;
    endMedia();
    store.update(call.callId, { endedAt: new Date(), outcome: "hangup" }).catch(() => {});
  });
}

function handleToolCall(
  sip: SipClient,
  call: IncomingCall,
  store: CallRecordStore,
  endMedia: () => void,
  toolCall: { function: { name: string; arguments: string } },
): void {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(toolCall.function.arguments || "{}");
  } catch {
    // malformed arguments from the model — proceed with defaults rather than crashing the call
  }

  switch (toolCall.function.name) {
    case "route_to_extension": {
      const extension = String(args.extension ?? "");
      if (!extension) break;
      sip.transferCall(call.callId, extension);
      endMedia();
      store.update(call.callId, { outcome: "routed", routedTo: extension }).catch(() => {});
      break;
    }
    case "transfer_to_human": {
      failOpen(sip, call, store, endMedia);
      break;
    }
    case "take_message": {
      store.update(call.callId, { outcome: "message_taken", transcript: String(args.message ?? "") }).catch(() => {});
      sip.hangupCall(call.callId);
      endMedia();
      break;
    }
    case "end_call": {
      sip.hangupCall(call.callId);
      endMedia();
      break;
    }
    default:
      break;
  }
}

/** Fail-open: blind-transfers the call to the first configured fallback extension, same as a dependency outage caught before the call started. */
function failOpen(sip: SipClient, call: IncomingCall, store: CallRecordStore, endMedia: () => void): void {
  const fallback = config.ringGroup.fallbackExtensions[0];
  if (fallback) {
    sip.transferCall(call.callId, fallback);
  } else {
    console.warn(`[call ${call.callId}] no FALLBACK_EXTENSIONS configured — hanging up instead of transferring.`);
    sip.hangupCall(call.callId);
  }
  endMedia();
  store.update(call.callId, { outcome: "fallback", routedTo: fallback }).catch(() => {});
}

/** Encodes PCM16 (as produced by a TTS vendor) to mu-law and sends it as paced RTP frames. */
function speakMulaw(rtp: RtpSession, pcm16le: Buffer): void {
  const FRAME_BYTES = 160; // 160 samples = 20ms @ 8kHz, one byte per mu-law sample
  const pcm16 = new Int16Array(pcm16le.buffer, pcm16le.byteOffset, pcm16le.byteLength / 2);
  const mulaw = encodeMulaw(pcm16);

  // Schedule each frame against an absolute start time rather than chaining
  // setTimeout(fn, 20) off of itself — the chained version drifts by
  // whatever each tick's actual overhead is (event loop load, STT/LLM work
  // happening concurrently), and that drift accumulates over hundreds of
  // frames into real, audible extra delay between words. Confirmed live
  // (2026-11-16) as the cause of replies sounding "distorted and slow" even
  // after the TTS audio and mu-law encoding were both verified correct.
  const start = Date.now();
  let frameIndex = 0;
  const sendNext = () => {
    const offset = frameIndex * FRAME_BYTES;
    if (offset >= mulaw.length) return;
    const frame = mulaw.subarray(offset, offset + FRAME_BYTES);
    rtp.sendMulawFrame(Buffer.from(frame));
    frameIndex++;
    const target = start + frameIndex * 20;
    setTimeout(sendNext, Math.max(0, target - Date.now()));
  };
  sendNext();
}

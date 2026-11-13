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
  const rtp = new RtpSession({ localPort: 0, remoteAddress: remote.address, remotePort: remote.port });
  const localPort = await rtp.ready();

  call.answer(buildAnswer({ localAddress: sip.getLocalAddress(), localPort }));

  const messages: ChatMessage[] = [{ role: "system", content: buildSystemPrompt(config.ringGroup.extensions) }];

  // Guards against double cleanup when both a BYE and a tool-call/fail-open
  // path try to tear down the same call.
  let ended = false;
  const endMedia = () => {
    if (ended) return;
    ended = true;
    rtp.close();
    stt.close();
  };

  const stt = new SpeechmaticsRealtimeClient();
  await stt.connect(async (partial) => {
    if (!partial.isFinal || !partial.text.trim() || ended) return;

    console.log(`[call ${call.callId}] caller said: "${partial.text}"`);
    messages.push({ role: "user", content: partial.text });

    let turn: Awaited<ReturnType<typeof runTurn>>;
    try {
      turn = await runTurn(messages);
    } catch (err) {
      console.error(`[call ${call.callId}] LLM turn failed, falling back to human:`, err);
      failOpen(sip, call, store, endMedia);
      return;
    }

    if (turn.reply) {
      console.log(`[call ${call.callId}] replying: "${turn.reply}"`);
      messages.push({ role: "assistant", content: turn.reply });
      try {
        const audio = await tts.synthesize(turn.reply, "en");
        speakMulaw(rtp, audio);
      } catch (err) {
        console.warn(`[call ${call.callId}] TTS unavailable, would have said: "${turn.reply}" (${(err as Error).message})`);
      }
    }

    for (const toolCall of turn.toolCalls) {
      console.log(`[call ${call.callId}] tool call: ${toolCall.function.name}(${toolCall.function.arguments})`);
      handleToolCall(sip, call, store, endMedia, toolCall);
    }
  });

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

  let offset = 0;
  const sendNext = () => {
    if (offset >= mulaw.length) return;
    const frame = mulaw.subarray(offset, offset + FRAME_BYTES);
    rtp.sendMulawFrame(Buffer.from(frame));
    offset += FRAME_BYTES;
    setTimeout(sendNext, 20);
  };
  sendNext();
}

import { SipClient, type IncomingCall } from "../sip/sipClient.js";
import { RtpSession } from "../media/rtpSession.js";
import { parseOffer, buildAnswer } from "../media/sdp.js";
import { encodeMulaw, decodeMulaw } from "../media/g711.js";
import { SpeechmaticsRealtimeClient } from "../stt/speechmatics.js";
import { runTurn, type ChatMessage } from "../llm/openrouter.js";
import { buildSystemPrompt } from "../llm/prompt.js";
import { UnconfiguredTtsClient } from "../tts/ttsClient.js";
import type { CallRecordStore } from "../callStore/callRecordStore.js";
import { config } from "../config.js";

// Wires one inbound call together: RTP media <-> STT -> LLM -> (TTS).
// TTS is expected to throw (UnconfiguredTtsClient, vendor undecided) —
// caught and logged rather than crashing the call, so everything up to
// "what the receptionist would have said" is exercisable today.

const tts = new UnconfiguredTtsClient();

export function attachCallHandling(sip: SipClient, store: CallRecordStore): void {
  sip.on("invite", (call) => {
    handleInvite(sip, call, store).catch((err) => {
      console.error(`[call ${call.callId}] failed:`, err);
      call.reject(500, "Server Error");
    });
  });
}

async function handleInvite(sip: SipClient, call: IncomingCall, store: CallRecordStore): Promise<void> {
  console.log(`[call ${call.callId}] incoming INVITE`);
  await store.create({ callId: call.callId, caller: "unknown", startedAt: new Date() });

  const remote = parseOffer(call.remoteSdp);
  const rtp = new RtpSession({ localPort: 0, remoteAddress: remote.address, remotePort: remote.port });
  const localPort = await rtp.ready();

  call.answer(buildAnswer({ localAddress: sip.getLocalAddress(), localPort }));

  const messages: ChatMessage[] = [{ role: "system", content: buildSystemPrompt(config.ringGroup.extensions) }];

  const stt = new SpeechmaticsRealtimeClient();
  await stt.connect(async (partial) => {
    if (!partial.isFinal || !partial.text.trim()) return;

    messages.push({ role: "user", content: partial.text });
    const turn = await runTurn(messages);

    if (turn.reply) {
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
      if (toolCall.function.name === "end_call") {
        rtp.close();
        stt.close();
      }
    }
  });

  rtp.on("audio", (mulawPayload: Buffer) => {
    const pcm16 = decodeMulaw(mulawPayload);
    stt.sendAudio(Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength));
  });

  sip.once("bye", (byeCallId) => {
    if (byeCallId !== call.callId) return;
    rtp.close();
    stt.close();
    store.update(call.callId, { endedAt: new Date(), outcome: "hangup" }).catch(() => {});
  });
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

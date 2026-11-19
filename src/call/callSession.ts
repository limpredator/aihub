import { SipClient, type IncomingCall } from "../sip/sipClient.js";
import { RtpSession } from "../media/rtpSession.js";
import { parseOffer, buildAnswer } from "../media/sdp.js";
import { encodeMulaw, decodeMulaw } from "../media/g711.js";
import { SpeechmaticsRealtimeClient } from "../stt/speechmatics.js";
import { extractVocabTerms } from "../stt/vocab.js";
import { runTurn, summarizeTranscript, type ChatMessage } from "../llm/openrouter.js";
import { buildSystemPrompt } from "../llm/prompt.js";
import { loadTenantConfig } from "../config/tenantConfig.js";
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
    return new ElevenLabsTtsClient({ apiKey: config.tts.apiKey, voiceId: config.tts.voiceId, speed: config.tts.speed });
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

  // Loaded fresh per call (cheap file read) rather than cached at startup, so
  // an edit saved from the dashboard's Company Profile tab takes effect on
  // the next call without restarting the gateway.
  const tenantConfig = await loadTenantConfig();
  const messages: ChatMessage[] = [{ role: "system", content: buildSystemPrompt(tenantConfig, config.ringGroup.extensions) }];

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
    // Written here, once, regardless of how the call ended (hangup, routed,
    // message taken, fail-open) — previously the only record of what a
    // caller actually asked for was console output that scrolled away.
    const transcript = messages
      .filter((m) => m.role !== "system")
      .map((m) => `${m.role === "user" ? "caller" : "ai"}: ${m.content}`)
      .join("\n");
    store.update(call.callId, { transcript }).catch(() => {});

    // Fire-and-forget: a summary is a nice-to-have for the dashboard, not
    // something anything else waits on, and it matters most on exactly the
    // calls that have no other structured record — a hangup before
    // take_message was ever called still has useful details buried in the
    // transcript (seen live 2026-11-16: name/company request was still
    // pending when the caller hung up, with their phone number already given).
    if (messages.some((m) => m.role === "user")) {
      summarizeTranscript(transcript)
        .then((summary) => store.update(call.callId, { summary }))
        .catch((err) => console.error(`[call ${call.callId}] summary generation failed:`, err));
    }
  };

  // Set while a reply's audio is being sent out, so a burst of new caller
  // speech can cut it short (barge-in) instead of talking over them; cleared
  // once that reply finishes or is cancelled.
  let cancelCurrentSpeech: (() => void) | null = null;

  const speakReply = async (text: string) => {
    console.log(`[call ${call.callId}] replying: "${text}"`);
    messages.push({ role: "assistant", content: text });
    try {
      const audio = await tts.synthesize(text, "en");
      // Must await: speakMulaw paces frames over time rather than sending
      // them all at once, so a caller who speaks again — or two finals that
      // each trigger a turn — can otherwise start a second reply's frames
      // before the first reply's are done going out, interleaving both
      // replies' audio on the wire ("cross pathing", heard live 2026-11-16).
      const speech = speakMulaw(rtp, audio);
      cancelCurrentSpeech = speech.cancel;
      await speech.done;
      cancelCurrentSpeech = null;
    } catch (err) {
      // A caller who hears nothing is stuck either way, whether TTS errored
      // or (seen live 2026-11-16, before the timeout above existed) just
      // hung forever — so treat it the same as a dropped STT connection and
      // hand off to a human rather than leaving them in silence.
      console.warn(`[call ${call.callId}] TTS failed, would have said: "${text}" (${(err as Error).message})`);
      if (!ended) failOpen(sip, call, store, endMedia);
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

  // Speechmatics detects language per word in multi-language mode, so this
  // tracks whatever it last detected the caller speaking — used to pick a
  // single matching closing line instead of reciting all three languages
  // every time (asked for live, 2026-11-16).
  let lastCallerLanguage: string | undefined;
  const CLOSING_LINES: Record<string, string> = {
    en: "Thank you, someone will contact you shortly.",
    ms: "Terima kasih, kami akan menghubungi anda tidak lama lagi.",
    cmn: "谢谢,我们会尽快联系您。",
  };
  const ALL_LANGUAGES_CLOSING_LINE = Object.values(CLOSING_LINES).join(" ");

  // Serializes turns so a debounce fire that lands while the previous
  // turn's LLM call or reply audio is still in flight queues behind it
  // instead of running concurrently — the other half of the "cross
  // pathing" overlapping-audio fix above.
  let turnChain: Promise<void> = Promise.resolve();
  const scheduleTurn = () => {
    turnChain = turnChain.then(runPendingTurn).catch((err) => {
      console.error(`[call ${call.callId}] turn handling failed:`, err);
    });
  };

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

    if (turn.reply) {
      await speakReply(turn.reply);
    } else if (turn.toolCalls.some((tc) => tc.function.name === "take_message" || tc.function.name === "end_call")) {
      // The prompt tells the model to always include a closing line with
      // these two tool calls, but it doesn't always (seen live 2026-11-16:
      // call ended right on the take_message tool call, no reply text, so
      // the caller just heard the line go dead). Don't let a missed reply
      // mean dead silence before hangup — say a closing line as a safety
      // net, in whichever language we last detected the caller speaking,
      // or all three if we never detected one.
      await speakReply(
        (lastCallerLanguage && CLOSING_LINES[lastCallerLanguage]) || ALL_LANGUAGES_CLOSING_LINE,
      );
    }

    for (const toolCall of turn.toolCalls) {
      console.log(`[call ${call.callId}] tool call: ${toolCall.function.name}(${toolCall.function.arguments})`);
      handleToolCall(sip, call, store, endMedia, toolCall);
    }
  };

  const stt = new SpeechmaticsRealtimeClient();
  await stt.connect(
    (partial) => {
    if (ended || !partial.text.trim()) return;

    // Barge-in: the caller started talking again while a reply was still
    // playing out — stop it immediately rather than talking over them, then
    // fall through to handle their new speech normally.
    if (cancelCurrentSpeech) {
      cancelCurrentSpeech();
      cancelCurrentSpeech = null;
    }

    // Reset the debounce timer on every transcript event, not just finals.
    // A final can arrive noticeably after the caller actually said it (STT
    // finalization lag over the websocket), so resetting only on finals lets
    // that lag masquerade as a real pause and split one thought into separate
    // turns (seen live 2026-11-16: "have." and a lone "." each treated as
    // their own turn even with the finals-only debounce below). Partials prove
    // the caller is still mid-utterance, so they push the quiet-period back
    // too — only finals get buffered as actual text.
    if (debounceTimer) clearTimeout(debounceTimer);
    // 900ms, then 1800ms, were both still too short when only finals reset
    // the timer — a live caller's mid-sentence pause ("Can I" ... pause ...
    // "know what brand of PBX you are offering?") exceeded it and got split
    // into two turns anyway (2026-11-16). 1800ms costs a bit more latency
    // before the AI responds but matches normal conversational thinking-pauses
    // better, and now resetting on partials too should absorb finalization lag.
    debounceTimer = setTimeout(scheduleTurn, 1800);

    if (partial.language && partial.language in CLOSING_LINES) {
      lastCallerLanguage = partial.language;
    }

    if (partial.isFinal) {
      pendingUtterance.push(partial.text.trim());
    }
    },
    () => {
      // The STT connection dropped out from under us mid-call (seen live
      // 2026-11-16, Speechmatics close code 1005) — without this, sendAudio()
      // keeps silently discarding frames forever and the caller just sits in
      // silence. The AI can't function without transcripts, so hand off to a
      // human instead of leaving them stuck.
      if (ended) return;
      console.error(`[call ${call.callId}] STT connection dropped unexpectedly — falling back to human.`);
      failOpen(sip, call, store, endMedia);
    },
    extractVocabTerms(tenantConfig),
  );

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
      store.update(call.callId, { outcome: "message_taken", message: String(args.message ?? "") }).catch(() => {});
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

/** A speakMulaw() in progress — cancel() stops it mid-reply for barge-in. */
interface SpeechHandle {
  done: Promise<void>;
  cancel: () => void;
}

/** Encodes PCM16 (as produced by a TTS vendor) to mu-law and sends it as paced RTP frames. `done` resolves once the last frame is sent, or immediately once cancel() is called. */
function speakMulaw(rtp: RtpSession, pcm16le: Buffer): SpeechHandle {
  const FRAME_BYTES = 160; // 160 samples = 20ms @ 8kHz, one byte per mu-law sample
  const pcm16 = new Int16Array(pcm16le.buffer, pcm16le.byteOffset, pcm16le.byteLength / 2);
  const mulaw = encodeMulaw(pcm16);

  let cancelled = false;
  let timer: NodeJS.Timeout | null = null;
  let resolveDone: () => void = () => {};

  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
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
      if (cancelled) {
        resolve();
        return;
      }
      const offset = frameIndex * FRAME_BYTES;
      if (offset >= mulaw.length) {
        resolve();
        return;
      }
      const frame = mulaw.subarray(offset, offset + FRAME_BYTES);
      rtp.sendMulawFrame(Buffer.from(frame));
      frameIndex++;
      const target = start + frameIndex * 20;
      timer = setTimeout(sendNext, Math.max(0, target - Date.now()));
    };
    sendNext();
  });

  const cancel = () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    // Must resolve here, not rely on sendNext noticing `cancelled` — clearing
    // the timer above means sendNext never runs again, so without this the
    // `done` promise hung forever on every barge-in and deadlocked the whole
    // call (seen live 2026-11-16: interrupting the AI mid-reply froze it with
    // no further turns ever processed).
    resolveDone();
  };

  return { done, cancel };
}

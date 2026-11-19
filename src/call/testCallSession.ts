import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { SpeechmaticsRealtimeClient } from "../stt/speechmatics.js";
import { extractVocabTerms } from "../stt/vocab.js";
import { runTurn, summarizeTranscript, type ChatMessage } from "../llm/openrouter.js";
import { buildSystemPrompt } from "../llm/prompt.js";
import { loadTenantConfig } from "../config/tenantConfig.js";
import { tts } from "./callSession.js";
import type { CallRecord, CallRecordStore } from "../callStore/callRecordStore.js";
import { config } from "../config.js";

// Browser test-call sessions reuse the exact same STT -> LLM -> TTS turn
// logic a real RTP call uses (see callSession.ts) — only the transport
// differs: a WebSocket carrying raw PCM16LE @ 8kHz mono both ways instead
// of RTP/mu-law. That happens to already be exactly what both Speechmatics
// (in) and ElevenLabs (out) use, so no codec work is needed here at all —
// this lets a sales call or an STT tweak (e.g. additional_vocab) be tried
// live without ever touching the phone network.

type ServerMsg =
  | { type: "status"; text: string }
  | { type: "transcript"; role: "caller" | "ai"; text: string; isFinal: boolean }
  | { type: "cancel" }
  | { type: "ended"; reason: string };

export function attachTestCallHandling(server: Server, store: CallRecordStore): void {
  const wss = new WebSocketServer({ server, path: "/api/test-call" });
  wss.on("connection", (socket) => {
    runTestCall(socket, store).catch((err) => {
      console.error("[test-call] session failed:", err);
      try {
        socket.close();
      } catch {
        // already closing
      }
    });
  });
}

async function runTestCall(socket: WebSocket, store: CallRecordStore): Promise<void> {
  const callId = `test-${randomUUID()}`;
  await store.create({ callId, caller: "Test call console", startedAt: new Date(), source: "test" });

  const send = (msg: ServerMsg) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  };

  const tenantConfig = await loadTenantConfig();
  const messages: ChatMessage[] = [{ role: "system", content: buildSystemPrompt(tenantConfig, config.ringGroup.extensions) }];

  let ended = false;
  let debounceTimer: NodeJS.Timeout | null = null;

  const endSession = (outcome: CallRecord["outcome"], extra: Partial<CallRecord> = {}) => {
    if (ended) return;
    ended = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    stt.close();

    const transcript = messages
      .filter((m) => m.role !== "system")
      .map((m) => `${m.role === "user" ? "caller" : "ai"}: ${m.content}`)
      .join("\n");
    store.update(callId, { transcript, endedAt: new Date(), outcome, ...extra }).catch(() => {});

    if (messages.some((m) => m.role === "user")) {
      summarizeTranscript(transcript)
        .then((summary) => store.update(callId, { summary }))
        .catch((err) => console.error(`[test-call ${callId}] summary generation failed:`, err));
    }

    send({ type: "ended", reason: outcome ?? "hangup" });
    if (socket.readyState === WebSocket.OPEN) socket.close();
  };

  const speakReply = async (text: string) => {
    messages.push({ role: "assistant", content: text });
    send({ type: "transcript", role: "ai", text, isFinal: true });
    try {
      const audio = await tts.synthesize(text, "en");
      if (socket.readyState === WebSocket.OPEN) socket.send(audio);
    } catch (err) {
      console.warn(`[test-call ${callId}] TTS failed, would have said: "${text}" (${(err as Error).message})`);
      send({ type: "status", text: "(voice reply failed — see server logs for what it would have said)" });
    }
  };

  const pendingUtterance: string[] = [];
  let lastCallerLanguage: string | undefined;
  const CLOSING_LINES: Record<string, string> = {
    en: "Thank you, someone will contact you shortly.",
    ms: "Terima kasih, kami akan menghubungi anda tidak lama lagi.",
    cmn: "谢谢,我们会尽快联系您。",
  };
  const ALL_LANGUAGES_CLOSING_LINE = Object.values(CLOSING_LINES).join(" ");

  let turnChain: Promise<void> = Promise.resolve();
  const scheduleTurn = () => {
    turnChain = turnChain.then(runPendingTurn).catch((err) => {
      console.error(`[test-call ${callId}] turn handling failed:`, err);
    });
  };

  const runPendingTurn = async () => {
    debounceTimer = null;
    const text = pendingUtterance.join(" ").trim();
    pendingUtterance.length = 0;
    if (!text || ended) return;

    messages.push({ role: "user", content: text });

    let turn: Awaited<ReturnType<typeof runTurn>>;
    try {
      turn = await runTurn(messages);
    } catch (err) {
      console.error(`[test-call ${callId}] LLM turn failed:`, err);
      send({ type: "status", text: "(the AI backend failed — see server logs)" });
      return;
    }

    if (turn.reply) {
      await speakReply(turn.reply);
    } else if (turn.toolCalls.some((tc) => tc.function.name === "take_message" || tc.function.name === "end_call")) {
      await speakReply((lastCallerLanguage && CLOSING_LINES[lastCallerLanguage]) || ALL_LANGUAGES_CLOSING_LINE);
    }

    for (const toolCall of turn.toolCalls) {
      handleTestToolCall(endSession, send, toolCall);
    }
  };

  const stt = new SpeechmaticsRealtimeClient();
  await stt.connect(
    (partial) => {
      if (ended || !partial.text.trim()) return;

      // No server-side audio pacing to track "still speaking" against (the
      // whole TTS reply is sent in one message and the browser paces
      // playback itself) — so just always tell the client to stop whatever
      // it's playing when the caller starts talking again; a no-op if
      // nothing was playing.
      send({ type: "cancel" });
      send({ type: "transcript", role: "caller", text: partial.text, isFinal: partial.isFinal });

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(scheduleTurn, 1800);

      if (partial.language && partial.language in CLOSING_LINES) {
        lastCallerLanguage = partial.language;
      }

      if (partial.isFinal) {
        pendingUtterance.push(partial.text.trim());
      }
    },
    () => {
      if (ended) return;
      console.error(`[test-call ${callId}] STT connection dropped unexpectedly.`);
      send({ type: "status", text: "(speech recognition dropped — ending test call)" });
      endSession("fallback");
    },
    extractVocabTerms(tenantConfig),
  );

  socket.on("message", (data, isBinary) => {
    if (ended) return;
    if (isBinary) {
      stt.sendAudio(data as Buffer);
      return;
    }
    let msg: { type?: string };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "hangup") endSession("hangup");
  });

  socket.on("close", () => endSession("hangup"));

  await speakReply(`Hello, thank you for calling ${tenantConfig.companyName}. How can I help you today?`);
}

function handleTestToolCall(
  endSession: (outcome: CallRecord["outcome"], extra?: Partial<CallRecord>) => void,
  send: (msg: ServerMsg) => void,
  toolCall: { function: { name: string; arguments: string } },
): void {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(toolCall.function.arguments || "{}");
  } catch {
    // malformed arguments from the model — proceed with defaults rather than crashing the session
  }

  switch (toolCall.function.name) {
    case "route_to_extension": {
      const extension = String(args.extension ?? "");
      send({ type: "status", text: `(on a real call, this would transfer to extension ${extension})` });
      endSession("routed", { routedTo: extension });
      break;
    }
    case "transfer_to_human": {
      send({ type: "status", text: "(on a real call, this would hand off to a human)" });
      endSession("fallback");
      break;
    }
    case "take_message": {
      const message = String(args.message ?? "");
      send({ type: "status", text: "Message noted." });
      endSession("message_taken", { message });
      break;
    }
    case "end_call": {
      endSession("hangup");
      break;
    }
    default:
      break;
  }
}

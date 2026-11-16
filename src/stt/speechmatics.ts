import WebSocket from "ws";
import { required } from "../config.js";

// Realtime WS endpoint. Server-side auth per Speechmatics docs: the API key goes in an
// `Authorization: Bearer` header on the WS upgrade request — the `?jwt=`
// query param is documented for browser/client-side use only (and the
// native WebSocket global can't set custom headers anyway, same
// restriction as a browser), hence the `ws` package here instead.
const REALTIME_URL = "wss://eu2.rt.speechmatics.com/v2";

export interface PartialTranscript {
  text: string;
  isFinal: boolean;
}

export class SpeechmaticsRealtimeClient {
  private socket: WebSocket | null = null;
  private closedByUs = false;

  /**
   * `onDisconnected` fires if the socket closes for any reason other than us
   * calling close() ourselves. Without it, a dropped connection (seen live
   * 2026-11-16: code 1005, no reason given) left sendAudio() silently
   * discarding every further audio frame — no transcripts, no LLM turns, no
   * reply, just the caller stuck in silence until they gave up and hung up.
   */
  async connect(onTranscript: (t: PartialTranscript) => void, onDisconnected: () => void): Promise<void> {
    const apiKey = required("SPEECHMATICS_API_KEY");
    this.socket = new WebSocket(REALTIME_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    this.socket.on("open", () => {
      this.socket?.send(
        JSON.stringify({
          message: "StartRecognition",
          audio_format: { type: "raw", encoding: "pcm_s16le", sample_rate: 8000 },
          transcription_config: {
            // melia-1 is selected via operating_point directly, not a
            // separate "model" field — the realtime API rejected that
            // shape with "additional properties 'model'/'max_delay' not
            // allowed" when first tried against a live call (2026-11-16).
            operating_point: "melia-1",
            language: "multi",
            language_hints: ["ms", "en", "cmn"],
            enable_partials: true,
          },
        }),
      );
    });

    this.socket.on("message", (raw) => {
      const data = JSON.parse(raw.toString());
      if (data.message === "AddPartialTranscript") {
        onTranscript({ text: data.metadata?.transcript ?? "", isFinal: false });
      } else if (data.message === "AddTranscript") {
        onTranscript({ text: data.metadata?.transcript ?? "", isFinal: true });
      } else if (data.message === "Error") {
        console.error("[stt] Speechmatics rejected the session:", data.type, data.reason);
      }
    });

    this.socket.on("error", (err) => {
      console.error("[stt] WebSocket error:", err);
    });

    this.socket.on("close", (code, reason) => {
      if (code !== 1000 && !this.closedByUs) {
        console.warn(`[stt] WebSocket closed unexpectedly: code=${code} reason=${reason.toString()}`);
        onDisconnected();
      }
    });
  }

  sendAudio(chunk: Buffer): void {
    // RTP (and so audio) can start arriving before the WebSocket finishes
    // connecting/handshaking — WebSocket.send() throws synchronously (not
    // an "error" event) when called on a socket that isn't OPEN yet, which
    // crashed the whole process on a live call (2026-11-16). Drop frames
    // until the socket is actually open rather than losing the call.
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(chunk);
  }

  close(): void {
    this.closedByUs = true;
    this.socket?.close();
    this.socket = null;
  }
}

import { required } from "../config.js";

// UNVERIFIED: transcriptor's lib/transcribe.ts only exercises Speechmatics'
// batch job API (POST /v2/jobs). This targets their realtime WS endpoint
// instead, which a live call needs. Confirm against real audio before
// trusting this: message framing, StartRecognition payload shape, and
// whether melia-1 is actually available on the realtime endpoint are all
// unconfirmed as of this scaffold.
const REALTIME_URL = "wss://eu2.rt.speechmatics.com/v2";

export interface PartialTranscript {
  text: string;
  isFinal: boolean;
}

export class SpeechmaticsRealtimeClient {
  private socket: WebSocket | null = null;

  async connect(onTranscript: (t: PartialTranscript) => void): Promise<void> {
    const apiKey = required("SPEECHMATICS_API_KEY");
    this.socket = new WebSocket(`${REALTIME_URL}?jwt=${apiKey}`);

    this.socket.addEventListener("open", () => {
      this.socket?.send(
        JSON.stringify({
          message: "StartRecognition",
          audio_format: { type: "raw", encoding: "pcm_s16le", sample_rate: 8000 },
          transcription_config: {
            model: "melia-1",
            language: "multi",
            language_hints: ["ms", "en", "cmn"],
            max_delay: 1,
            enable_partials: true,
          },
        }),
      );
    });

    this.socket.addEventListener("message", (event) => {
      const data = JSON.parse(typeof event.data === "string" ? event.data : "{}");
      if (data.message === "AddPartialTranscript") {
        onTranscript({ text: data.metadata?.transcript ?? "", isFinal: false });
      } else if (data.message === "AddTranscript") {
        onTranscript({ text: data.metadata?.transcript ?? "", isFinal: true });
      }
    });
  }

  sendAudio(chunk: Buffer): void {
    this.socket?.send(chunk);
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}

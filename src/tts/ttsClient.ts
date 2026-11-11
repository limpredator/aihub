// Vendor not yet decided (ElevenLabs vs AWS Polly vs Azure — see
// docs/research-ai-receptionist.md on the Bahasa Malaysia TTS gap).
// Code against this interface so swapping the vendor later only means
// writing a new implementation, not touching call-handling logic.

export interface TtsClient {
  synthesize(text: string, language: "en" | "ms" | "cmn"): Promise<Buffer>;
}

export class UnconfiguredTtsClient implements TtsClient {
  async synthesize(): Promise<Buffer> {
    throw new Error("No TTS_PROVIDER configured — pick a vendor (see .env.example) before taking live calls.");
  }
}

// TTS vendor: ElevenLabs. Switched from an earlier Azure attempt after the
// Azure sign-up got stuck behind a tenant-restricted account error — not
// worth fighting. ElevenLabs' eleven_multilingual_v2 model officially lists
// Malay as a supported language, covering the Bahasa Malaysia gap flagged
// in docs/research-ai-receptionist.md, and signup is just an API key (no
// cloud-project/tenant setup). Requested in pcm_8000 (raw PCM16LE @ 8kHz)
// to match the existing mu-law pipeline's input — ElevenLabs can also
// return ulaw_8000 directly, but pcm_8000 keeps this client's output
// consistent with the TtsClient contract below, so callSession.ts's
// encode step doesn't need a vendor-specific branch.

export interface TtsClient {
  /** Returns PCM16LE audio sampled at 8kHz, ready for g711 mu-law encoding. */
  synthesize(text: string, language: "en" | "ms" | "cmn"): Promise<Buffer>;
}

export class UnconfiguredTtsClient implements TtsClient {
  async synthesize(_text: string, _language: "en" | "ms" | "cmn"): Promise<Buffer> {
    throw new Error("No TTS_PROVIDER configured — pick a vendor (see .env.example) before taking live calls.");
  }
}

export interface ElevenLabsTtsOptions {
  apiKey: string;
  /** Voice to speak with — any ElevenLabs voice ID works across languages with eleven_multilingual_v2. */
  voiceId: string;
}

export class ElevenLabsTtsClient implements TtsClient {
  constructor(private readonly opts: ElevenLabsTtsOptions) {}

  async synthesize(text: string, _language: "en" | "ms" | "cmn"): Promise<Buffer> {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.opts.voiceId}?output_format=pcm_8000`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": this.opts.apiKey,
        "Content-Type": "application/json",
      },
      // No language_code: eleven_multilingual_v2 doesn't support that
      // parameter — language is inferred from the text itself.
      body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
    });

    if (!res.ok) {
      throw new Error(`ElevenLabs TTS request failed: ${res.status} ${res.statusText}`);
    }

    return Buffer.from(await res.arrayBuffer());
  }
}

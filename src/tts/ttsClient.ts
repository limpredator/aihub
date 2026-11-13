// Azure Cognitive Services Speech (Neural TTS) — chosen over ElevenLabs/AWS
// Polly for the one thing they don't have: a native ms-MY neural voice, to
// cover the Bahasa Malaysia gap flagged in docs/research-ai-receptionist.md.
// Also asks it to render straight to raw-8khz-16bit-mono-pcm, matching what
// callSession.ts needs for mu-law encoding — no resampling step required.

export interface TtsClient {
  synthesize(text: string, language: "en" | "ms" | "cmn"): Promise<Buffer>;
}

export class UnconfiguredTtsClient implements TtsClient {
  async synthesize(_text: string, _language: "en" | "ms" | "cmn"): Promise<Buffer> {
    throw new Error("No TTS_PROVIDER configured — pick a vendor (see .env.example) before taking live calls.");
  }
}

// One neural voice per language this receptionist needs to speak. "cmn"
// (Mandarin) is mapped to a Malaysia-market voice where Azure has one, to
// keep the accent consistent with local callers rather than defaulting to a
// mainland China voice.
const VOICE_BY_LANGUAGE: Record<"en" | "ms" | "cmn", { locale: string; voice: string }> = {
  en: { locale: "en-MY", voice: "en-MY-YasminNeural" },
  ms: { locale: "ms-MY", voice: "ms-MY-YasminNeural" },
  cmn: { locale: "zh-CN", voice: "zh-CN-XiaoxiaoNeural" },
};

function escapeSsml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface AzureTtsOptions {
  apiKey: string;
  /** Azure region the Speech resource was created in, e.g. "southeastasia". */
  region: string;
}

export class AzureTtsClient implements TtsClient {
  constructor(private readonly opts: AzureTtsOptions) {}

  async synthesize(text: string, language: "en" | "ms" | "cmn"): Promise<Buffer> {
    const { locale, voice } = VOICE_BY_LANGUAGE[language];
    const ssml =
      `<speak version="1.0" xml:lang="${locale}">` +
      `<voice name="${voice}">${escapeSsml(text)}</voice>` +
      `</speak>`;

    const res = await fetch(`https://${this.opts.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": this.opts.apiKey,
        "Content-Type": "application/ssml+xml",
        // Raw PCM straight out, at the same 8kHz callSession.ts/g711.ts
        // already assume for RTP — no resampling needed before mu-law.
        "X-Microsoft-OutputFormat": "raw-8khz-16bit-mono-pcm",
      },
      body: ssml,
    });

    if (!res.ok) {
      throw new Error(`Azure TTS request failed: ${res.status} ${res.statusText}`);
    }

    return Buffer.from(await res.arrayBuffer());
  }
}

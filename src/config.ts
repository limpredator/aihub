import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

export const config = {
  sip: {
    proxyHost: process.env.SIP_PROXY_HOST || "pbx.cerdik.co",
    proxyTlsPort: Number(process.env.SIP_PROXY_TLS_PORT || 5061),
    extension: process.env.SIP_EXTENSION || "",
    password: process.env.SIP_PASSWORD || "",
  },
  ringGroup: {
    extensions: (process.env.RING_GROUP_EXTENSIONS || "").split(",").map((s) => s.trim()).filter(Boolean),
    fallbackExtensions: (process.env.FALLBACK_EXTENSIONS || "").split(",").map((s) => s.trim()).filter(Boolean),
  },
  speechmatics: {
    apiKey: process.env.SPEECHMATICS_API_KEY || "",
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || "",
    model: process.env.OPENROUTER_MODEL || "anthropic/claude-haiku-5-5",
  },
  tts: {
    provider: process.env.TTS_PROVIDER || "",
    apiKey: process.env.TTS_API_KEY || "",
    // ElevenLabs voice ID (any premade or cloned voice works across
    // languages with eleven_multilingual_v2). Defaults to "Rachel", one of
    // ElevenLabs' standard premade voices.
    voiceId: process.env.TTS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM",
  },
  healthCheckIntervalMs: Number(process.env.HEALTH_CHECK_INTERVAL_MS || 15000),
};

export { required };

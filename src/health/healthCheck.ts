import { config } from "../config.js";
import { SipClient } from "../sip/sipClient.js";

// Pre-flight health check: if any dependency is unreachable, deregister
// from Kamailio so the ring group's own no-answer timeout falls through to
// a human extension — no PBX dialplan access needed for this to work.
// Mid-call failure (a dependency dies while a call is already connected)
// still needs the gateway to issue a SIP REFER, which isn't built yet —
// this loop only covers the pre-flight half of fail-open.

async function checkOpenRouter(): Promise<boolean> {
  if (!config.openrouter.apiKey) return false;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${config.openrouter.apiKey}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

function checkSpeechmaticsConfigured(): boolean {
  return Boolean(config.speechmatics.apiKey);
}

function checkTtsConfigured(): boolean {
  return Boolean(config.tts.provider && config.tts.apiKey);
}

export async function isHealthy(): Promise<boolean> {
  const [openrouterOk] = await Promise.all([checkOpenRouter()]);
  return openrouterOk && checkSpeechmaticsConfigured() && checkTtsConfigured();
}

export function startHealthLoop(sip: SipClient): void {
  setInterval(async () => {
    const healthy = await isHealthy();
    const state = sip.getState();

    if (healthy && state === "unregistered") {
      console.log("[health] dependencies healthy, registering");
      sip.register().catch((err) => console.error("[health] register failed:", err));
    } else if (!healthy && state === "registered") {
      console.warn("[health] a dependency is unreachable, deregistering (fail-open)");
      sip.deregister();
    }
  }, config.healthCheckIntervalMs);
}

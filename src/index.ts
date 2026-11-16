import { config } from "./config.js";
import { SipClient } from "./sip/sipClient.js";
import { startHealthLoop, isHealthy } from "./health/healthCheck.js";
import { attachCallHandling } from "./call/callSession.js";
import { FileCallRecordStore } from "./callStore/callRecordStore.js";

async function main() {
  console.log("aihub — Cerdik AI receptionist gateway starting");
  console.log(`ring group: ${config.ringGroup.extensions.join(", ") || "(none configured)"}`);

  const sip = new SipClient();
  // Writes one JSON file per call under data/calls/ — open that folder to
  // see each call's outcome, who it was routed to, and the full transcript.
  attachCallHandling(sip, new FileCallRecordStore());

  const healthy = await isHealthy();
  if (healthy) {
    await sip.register();
    console.log("[startup] registered with pbx.cerdik.co — ready for calls.");
  } else {
    console.warn("[startup] dependencies not healthy yet — staying unregistered until they are.");
  }

  startHealthLoop(sip);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});

import { config } from "./config.js";
import { SipClient } from "./sip/sipClient.js";
import { startHealthLoop, isHealthy } from "./health/healthCheck.js";
import { attachCallHandling } from "./call/callSession.js";
import { NoopCallRecordStore } from "./callStore/callRecordStore.js";

async function main() {
  console.log("aihub — Cerdik AI receptionist gateway starting");
  console.log(`ring group: ${config.ringGroup.extensions.join(", ") || "(none configured)"}`);

  const sip = new SipClient();
  attachCallHandling(sip, new NoopCallRecordStore());

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

import { config } from "./config.js";
import { SipClient } from "./sip/sipClient.js";
import { startHealthLoop, isHealthy } from "./health/healthCheck.js";

async function main() {
  console.log("aihub — Cerdik AI receptionist gateway starting");
  console.log(`ring group: ${config.ringGroup.extensions.join(", ") || "(none configured)"}`);

  const sip = new SipClient();

  const healthy = await isHealthy();
  if (healthy) {
    await sip.register();
  } else {
    console.warn("[startup] dependencies not healthy yet — staying unregistered until they are.");
  }

  startHealthLoop(sip);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});

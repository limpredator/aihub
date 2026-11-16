// Standalone web dashboard for looking at call records — run with
// `npm run dashboard` alongside the gateway (`npm run dev`). Reads the same
// data/calls/*.json files FileCallRecordStore writes, so there's nothing to
// configure or sync. No login yet: this is the local/testing version: see
// its README note for why a cloud multi-customer deployment needs auth and
// per-tenant isolation added on top before going further than this.
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { CallRecord } from "../callStore/callRecordStore.js";
import { FileCallRecordStore } from "../callStore/callRecordStore.js";
import { loadTenantConfig, saveTenantConfig, type TenantConfig } from "../config/tenantConfig.js";

const CALLS_DIR = join(process.cwd(), "data", "calls");
const PORT = Number(process.env.DASHBOARD_PORT || 3900);
const store = new FileCallRecordStore(CALLS_DIR);
const EDITABLE_OUTCOMES = ["routed", "message_taken", "fallback", "hangup"];
const EDITABLE_FOLLOWUP_STATUSES = ["pending", "contacted", "done"];
const TENANT_CONFIG_FIELDS = [
  "companyName",
  "companyDescription",
  "languages",
  "companyFacts",
  "products",
  "howItFitsTogether",
  "simpleTerms",
  "quickAnswers",
  "neverDoThis",
] as const;

async function listCalls(): Promise<CallRecord[]> {
  let files: string[];
  try {
    files = await readdir(CALLS_DIR);
  } catch {
    return [];
  }

  const records = await Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => {
        try {
          return JSON.parse(await readFile(join(CALLS_DIR, f), "utf8")) as CallRecord;
        } catch {
          return null;
        }
      }),
  );

  return records
    .filter((r): r is CallRecord => r !== null)
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

const PAGE_PATH = join(import.meta.dirname, "public", "index.html");

const server = createServer(async (req, res) => {
  if (req.url === "/api/calls") {
    const calls = await listCalls();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(calls));
    return;
  }

  if (req.method === "PATCH" && req.url?.startsWith("/api/calls/")) {
    const callId = decodeURIComponent(req.url.slice("/api/calls/".length));
    // callId becomes a filename on disk (callRecordStore.pathFor) — reject
    // anything that could escape data/calls/ via a path separator.
    if (!callId || /[\\/]/.test(callId)) {
      res.writeHead(400);
      res.end("Invalid call id");
      return;
    }

    let body = "";
    for await (const chunk of req) body += chunk;

    let patch: { outcome?: string; followUpStatus?: string };
    try {
      patch = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end("Invalid JSON body");
      return;
    }

    if (patch.outcome === undefined && patch.followUpStatus === undefined) {
      res.writeHead(400);
      res.end("Provide outcome and/or followUpStatus");
      return;
    }
    if (patch.outcome !== undefined && !EDITABLE_OUTCOMES.includes(patch.outcome)) {
      res.writeHead(400);
      res.end(`outcome must be one of: ${EDITABLE_OUTCOMES.join(", ")}`);
      return;
    }
    if (patch.followUpStatus !== undefined && !EDITABLE_FOLLOWUP_STATUSES.includes(patch.followUpStatus)) {
      res.writeHead(400);
      res.end(`followUpStatus must be one of: ${EDITABLE_FOLLOWUP_STATUSES.join(", ")}`);
      return;
    }

    await store.update(callId, {
      ...(patch.outcome !== undefined ? { outcome: patch.outcome as CallRecord["outcome"] } : {}),
      ...(patch.followUpStatus !== undefined ? { followUpStatus: patch.followUpStatus as CallRecord["followUpStatus"] } : {}),
    });
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/api/tenant-config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(await loadTenantConfig()));
    return;
  }

  if (req.method === "PUT" && req.url === "/api/tenant-config") {
    let body = "";
    for await (const chunk of req) body += chunk;

    let patch: Record<string, unknown>;
    try {
      patch = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end("Invalid JSON body");
      return;
    }

    const cleaned: Partial<TenantConfig> = {};
    for (const field of TENANT_CONFIG_FIELDS) {
      const value = patch[field];
      if (value === undefined) continue;
      if (typeof value !== "string" || !value.trim()) {
        res.writeHead(400);
        res.end(`${field} must be a non-empty string`);
        return;
      }
      cleaned[field] = value;
    }

    const saved = await saveTenantConfig(cleaned);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(saved));
    return;
  }

  if (req.url === "/" || req.url === "/index.html") {
    try {
      const html = await readFile(PAGE_PATH, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      res.writeHead(500);
      res.end(`Failed to load dashboard page: ${(err as Error).message}`);
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`[dashboard] call dashboard listening on http://localhost:${PORT}`);
  console.log(`[dashboard] reading call records from ${CALLS_DIR}`);
});

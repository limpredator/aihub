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

const CALLS_DIR = join(process.cwd(), "data", "calls");
const PORT = Number(process.env.DASHBOARD_PORT || 3900);

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

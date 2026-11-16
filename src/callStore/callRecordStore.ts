// Same pluggable-interface pattern as CRM/shared/src/pbx-connector.ts and
// auth-provider.ts — start with NoopCallRecordStore, swap in a CRM-backed
// implementation later without touching the gateway's call-handling code.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CallRecord {
  callId: string;
  caller: string;
  startedAt: Date;
  endedAt?: Date;
  /** Full turn-by-turn conversation, written once the call ends. */
  transcript?: string;
  /** Short LLM-generated summary of what the caller wanted and what to do next, written once the call ends. */
  summary?: string;
  /** The message text handed to take_message, when the outcome is message_taken. */
  message?: string;
  outcome?: "routed" | "message_taken" | "fallback" | "hangup";
  routedTo?: string;
}

export interface CallRecordStore {
  create(record: CallRecord): Promise<void>;
  update(callId: string, patch: Partial<CallRecord>): Promise<void>;
}

export class NoopCallRecordStore implements CallRecordStore {
  async create(record: CallRecord): Promise<void> {
    console.log(`[callStore] create (noop): ${record.callId} from ${record.caller}`);
  }

  async update(callId: string, patch: Partial<CallRecord>): Promise<void> {
    console.log(`[callStore] update (noop): ${callId}`, patch);
  }
}

/**
 * Writes one JSON file per call to disk (data/calls/<callId>.json by
 * default) so a finished call's outcome and transcript can actually be
 * looked at afterwards — before this, the only record was console output
 * that scrolled away once the terminal buffer filled or the process
 * restarted (raised live, 2026-11-16: "where can we see a summary of what
 * happened / what the caller was looking for").
 *
 * One file per callId means create() and update() never race each other
 * across different calls, and a human can just open the file for a given
 * call — no DB setup needed for this call volume.
 */
export class FileCallRecordStore implements CallRecordStore {
  constructor(private readonly dir: string = join(process.cwd(), "data", "calls")) {}

  // update() is read-modify-write, so two updates for the same call fired
  // close together (e.g. take_message's write and endMedia's transcript
  // write, which land within milliseconds of each other) can otherwise both
  // read the same on-disk content and the second write clobbers the first's
  // change. One promise chain per callId forces them to run in turn.
  private readonly queues = new Map<string, Promise<void>>();

  private pathFor(callId: string): string {
    return join(this.dir, `${callId}.json`);
  }

  private enqueue(callId: string, task: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(callId) ?? Promise.resolve()).then(task, task);
    this.queues.set(callId, next);
    return next;
  }

  create(record: CallRecord): Promise<void> {
    return this.enqueue(record.callId, async () => {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.pathFor(record.callId), JSON.stringify(record, null, 2));
    });
  }

  update(callId: string, patch: Partial<CallRecord>): Promise<void> {
    return this.enqueue(callId, async () => {
      const path = this.pathFor(callId);
      let existing: Partial<CallRecord> = {};
      try {
        existing = JSON.parse(await readFile(path, "utf8"));
      } catch {
        // create() should always run first, but don't lose the patch if it didn't
      }
      await writeFile(path, JSON.stringify({ ...existing, ...patch }, null, 2));
    });
  }
}

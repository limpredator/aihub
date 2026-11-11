// Same pluggable-interface pattern as CRM/shared/src/pbx-connector.ts and
// auth-provider.ts — start with NoopCallRecordStore, swap in a CRM-backed
// implementation later without touching the gateway's call-handling code.

export interface CallRecord {
  callId: string;
  caller: string;
  startedAt: Date;
  endedAt?: Date;
  transcript?: string;
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

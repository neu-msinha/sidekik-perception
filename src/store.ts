import type { Logger } from "@sidekik/contracts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** One `screen_events` row (SCHEMA.md 0004_capture.sql, owned by perception). */
export type ScreenEventRow = {
  org_id: string;
  session_id: string;
  event_id: string;
  t_ms: number;
  type: string;
  entity_kind: string | null;
  entity_id: string | null;
  field: string | null;
  before_val: string | null;
  after_val: string | null;
  state: unknown;
  bbox: unknown;
  confidence: number;
  source: "vision" | "dom";
  keyframe_id?: string | null;
};

/** Perception's tables and Storage files. Supabase in production, memory for dev:mock and tests. */
export interface PerceptionStore {
  /** Idempotent on event_id: a redelivered event doesn't insert twice. */
  insertScreenEvents(rows: ScreenEventRow[]): Promise<void>;
}

export class SupabaseStore implements PerceptionStore {
  readonly db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async insertScreenEvents(rows: ScreenEventRow[]): Promise<void> {
    if (rows.length === 0) return;
    const { error } = await this.db.from("screen_events").upsert(rows, { onConflict: "event_id", ignoreDuplicates: true });
    if (error) throw new Error(`screen_events insert failed: ${error.message}`);
  }
}

export class MemoryStore implements PerceptionStore {
  readonly screenEvents: ScreenEventRow[] = [];

  constructor(private readonly log?: Logger) {}

  async insertScreenEvents(rows: ScreenEventRow[]): Promise<void> {
    for (const row of rows) {
      if (this.screenEvents.some((r) => r.event_id === row.event_id)) continue;
      this.screenEvents.push(row);
      this.log?.debug({ session_id: row.session_id, org_id: row.org_id, event_id: row.event_id, type: row.type }, "screen_events row");
    }
  }
}

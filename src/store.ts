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

/** One `keyframes` row. `storage_path` includes the bucket: `captures/org/{org}/sessions/{sid}/keyframes/{t_ms}.webp`. */
export type KeyframeRow = {
  id: string;
  org_id: string;
  session_id: string;
  t_ms: number;
  storage_path: string;
  phash: string;
  redacted: boolean;
};

export const CAPTURES_BUCKET = "captures";

/** Splits "captures/org/..." into bucket and object path. */
export function splitStoragePath(path: string): { bucket: string; object: string } {
  const i = path.indexOf("/");
  return { bucket: path.slice(0, i), object: path.slice(i + 1) };
}

/** Perception's tables and Storage files. Supabase in production, memory for dev:mock and tests. */
export interface PerceptionStore {
  /** Idempotent on event_id: a redelivered event doesn't insert twice. */
  insertScreenEvents(rows: ScreenEventRow[]): Promise<void>;
  /** Uploads a file; `path` includes the bucket. */
  upload(path: string, bytes: Buffer, contentType: string): Promise<void>;
  insertKeyframe(row: KeyframeRow): Promise<void>;
  /** Points screen_events at the keyframe taken for them. */
  attachKeyframe(eventIds: string[], keyframeId: string): Promise<void>;
  getKeyframe(id: string): Promise<KeyframeRow | undefined>;
  signedUrl(path: string, ttlSec: number): Promise<string>;
  /** orgs.settings.store_learner_keyframes (SCHEMA 0001; default false). */
  storeLearnerKeyframes(orgId: string): Promise<boolean>;
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

  async upload(path: string, bytes: Buffer, contentType: string): Promise<void> {
    const { bucket, object } = splitStoragePath(path);
    const { error } = await this.db.storage.from(bucket).upload(object, bytes, { contentType, upsert: true });
    if (error) throw new Error(`upload ${path} failed: ${error.message}`);
  }

  async insertKeyframe(row: KeyframeRow): Promise<void> {
    const { error } = await this.db.from("keyframes").insert(row);
    if (error) throw new Error(`keyframes insert failed: ${error.message}`);
  }

  async attachKeyframe(eventIds: string[], keyframeId: string): Promise<void> {
    if (eventIds.length === 0) return;
    const { error } = await this.db.from("screen_events").update({ keyframe_id: keyframeId }).in("event_id", eventIds);
    if (error) throw new Error(`screen_events keyframe update failed: ${error.message}`);
  }

  async getKeyframe(id: string): Promise<KeyframeRow | undefined> {
    const { data, error } = await this.db.from("keyframes").select("id, org_id, session_id, t_ms, storage_path, phash, redacted").eq("id", id).maybeSingle();
    if (error) throw new Error(`keyframes read failed: ${error.message}`);
    return (data as KeyframeRow | null) ?? undefined;
  }

  async signedUrl(path: string, ttlSec: number): Promise<string> {
    const { bucket, object } = splitStoragePath(path);
    const { data, error } = await this.db.storage.from(bucket).createSignedUrl(object, ttlSec);
    if (error || !data) throw new Error(`sign ${path} failed: ${error?.message ?? "no url"}`);
    return data.signedUrl;
  }

  private readonly learnerKeyframes = new Map<string, boolean>();

  async storeLearnerKeyframes(orgId: string): Promise<boolean> {
    const cached = this.learnerKeyframes.get(orgId);
    if (cached !== undefined) return cached;
    const { data, error } = await this.db.from("orgs").select("settings").eq("id", orgId).maybeSingle();
    if (error) return false;
    const on = (data as { settings?: { store_learner_keyframes?: boolean } } | null)?.settings?.store_learner_keyframes === true;
    this.learnerKeyframes.set(orgId, on);
    return on;
  }
}

export class MemoryStore implements PerceptionStore {
  readonly screenEvents: ScreenEventRow[] = [];
  readonly keyframes: KeyframeRow[] = [];
  readonly files = new Map<string, { bytes: Buffer; contentType: string }>();
  learnerKeyframes = false;

  constructor(private readonly log?: Logger) {}

  async insertScreenEvents(rows: ScreenEventRow[]): Promise<void> {
    for (const row of rows) {
      if (this.screenEvents.some((r) => r.event_id === row.event_id)) continue;
      this.screenEvents.push(row);
      this.log?.debug({ session_id: row.session_id, org_id: row.org_id, event_id: row.event_id, type: row.type }, "screen_events row");
    }
  }

  async upload(path: string, bytes: Buffer, contentType: string): Promise<void> {
    this.files.set(path, { bytes, contentType });
  }

  async insertKeyframe(row: KeyframeRow): Promise<void> {
    this.keyframes.push(row);
    this.log?.debug({ session_id: row.session_id, org_id: row.org_id, keyframe_id: row.id, t_ms: row.t_ms }, "keyframes row");
  }

  async attachKeyframe(eventIds: string[], keyframeId: string): Promise<void> {
    for (const r of this.screenEvents) if (eventIds.includes(r.event_id)) r.keyframe_id = keyframeId;
  }

  async getKeyframe(id: string): Promise<KeyframeRow | undefined> {
    return this.keyframes.find((k) => k.id === id);
  }

  async signedUrl(path: string, ttlSec: number): Promise<string> {
    return `memory://${path}?ttl=${ttlSec}`;
  }

  async storeLearnerKeyframes(): Promise<boolean> {
    return this.learnerKeyframes;
  }
}

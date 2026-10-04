/**
 * Keyframes (DESIGN §3): redacted stills of the moments that matter, stored as webp. Raw frames are
 * never stored; they live only in a 20-second in-memory ring buffer per session.
 *
 * A keyframe is taken for:
 * - a field, record or button change (the frame that showed it, or the nearest buffered frame for DOM events);
 * - the first frame after navigation (a nav frame or a new screen);
 * - every second from 5 s before to 5 s after a brain `ask`.
 */
import { randomUUID } from "node:crypto";
import { sessionLogger, type Logger } from "@sidekik/contracts";
import { analyzeFrame, type Rect } from "./diff.js";
import type { IncomingFrame } from "./frames/routes.js";
import type { PublishedEvent } from "./publisher.js";
import { isPiiField, type ImageRedactor } from "./redact-image.js";
import type { Session } from "./sessions.js";
import { CAPTURES_BUCKET, type PerceptionStore } from "./store.js";
import sharp from "sharp";

export const RING_MS = 20_000;
export const ASK_WINDOW_MS = 5_000;
/** At most one keyframe per this much session time, unless the screen looks different. */
export const MIN_GAP_MS = 1_000;
/** How far a DOM event may be from the frame used for it. */
const DOM_MATCH_MS = 2_000;
const KEYFRAME_TYPES = new Set(["field_changed", "record_opened", "button_clicked", "app_opened", "navigation"]);

export type KeyframeDeps = { store: PerceptionStore; redactor: ImageRedactor; log: Logger };

/** The raw-frame ring buffer: frames from the last 20 s of session time, in memory only. */
export class RingBuffer {
  private frames: IncomingFrame[] = [];

  push(f: IncomingFrame): void {
    this.frames.push(f);
    const cutoff = f.t_ms - RING_MS;
    while (this.frames.length && this.frames[0]!.t_ms < cutoff) this.frames.shift();
  }

  /** The buffered frame closest to `t`, within `maxDist` ms. */
  nearest(t: number, maxDist = Infinity): IncomingFrame | undefined {
    let best: IncomingFrame | undefined;
    for (const f of this.frames) if (Math.abs(f.t_ms - t) <= maxDist && (!best || Math.abs(f.t_ms - t) < Math.abs(best.t_ms - t))) best = f;
    return best;
  }

  between(from: number, to: number): IncomingFrame[] {
    return this.frames.filter((f) => f.t_ms >= from && f.t_ms <= to);
  }

  clear(): void {
    this.frames = [];
  }

  get size(): number {
    return this.frames.length;
  }
}

export class Keyframer {
  readonly ring = new RingBuffer();
  private readonly log: Logger;
  /** Field → where it is on screen, for fields holding personal data (blurred on every keyframe). */
  private readonly piiBoxes = new Map<string, Rect>();
  private readonly taken: { t_ms: number; phash: string }[] = [];
  /** Asks whose ±5 s window is still open (session time). */
  private askUntil = -Infinity;
  private lastAskShot = -Infinity;
  private epoch = 0;
  private chain: Promise<void> = Promise.resolve();
  private enabled: Promise<boolean>;
  readonly stats = { stored: 0, skipped: 0, presidio: 0, failed: 0 };

  constructor(
    private readonly session: Session,
    private readonly deps: KeyframeDeps,
  ) {
    this.log = sessionLogger(deps.log, session);
    // Learner screens are kept only when the org opted in (orgs.settings.store_learner_keyframes).
    this.enabled = session.kind === "tutor" ? deps.store.storeLearnerKeyframes(session.org_id).catch(() => false) : Promise.resolve(true);
  }

  /** Every accepted frame passes through here before diffing. */
  onFrame(f: IncomingFrame): void {
    this.ring.push(f);
    if (f.reason === "nav") this.take(f, []);
    else if (f.t_ms <= this.askUntil && f.t_ms - this.lastAskShot >= MIN_GAP_MS) {
      this.lastAskShot = f.t_ms;
      this.take(f, []);
    }
  }

  /** The diff saw a different screen without a nav frame: the first frame of it. */
  onNewScreen(f: IncomingFrame): void {
    if (f.reason !== "nav") this.take(f, []);
  }

  /** Published events: keep where personal data sits, and keyframe the changes. */
  onEvents(published: PublishedEvent[], frame?: IncomingFrame): void {
    for (const { tracked } of published) {
      if (tracked.bbox && isPiiField(tracked.field, tracked.after)) this.piiBoxes.set(tracked.field ?? "?", tracked.bbox);
    }
    const ids = published.filter((p) => KEYFRAME_TYPES.has(p.event.type)).map((p) => p.event.event_id);
    if (ids.length === 0) return;
    const t = published[published.length - 1]!.t_ms;
    const f = frame ?? this.ring.nearest(t, DOM_MATCH_MS);
    if (f) this.take(f, ids);
  }

  /** Brain asked: keyframe the 5 s before (from the buffer) and the 5 s after (as frames arrive). */
  onAsk(t: number): void {
    this.askUntil = Math.max(this.askUntil, t + ASK_WINDOW_MS);
    let last = -Infinity;
    for (const f of this.ring.between(t - ASK_WINDOW_MS, t)) {
      if (f.t_ms - last < MIN_GAP_MS) continue;
      last = f.t_ms;
      this.take(f, []);
    }
    this.lastAskShot = Math.max(this.lastAskShot, last);
  }

  /** Off-record or end: forget every raw frame and drop keyframes not yet stored. */
  clear(): void {
    this.epoch++;
    this.ring.clear();
    this.askUntil = -Infinity;
  }

  /** Waits for queued keyframes (tests, shutdown). */
  idle(): Promise<void> {
    return this.chain;
  }

  private take(f: IncomingFrame, eventIds: string[]): void {
    const epoch = this.epoch;
    const boxes = [...this.piiBoxes.values()];
    this.chain = this.chain
      .then(() => this.store(f, eventIds, boxes, epoch))
      .catch((err: unknown) => {
        this.stats.failed++;
        this.log.error({ err, t_ms: f.t_ms }, "keyframe failed");
      });
  }

  private async store(f: IncomingFrame, eventIds: string[], boxes: Rect[], epoch: number): Promise<void> {
    if (!(await this.enabled) || epoch !== this.epoch || this.session.offRecord) return;
    const started = Date.now();
    const { phash } = await analyzeFrame(f.jpeg);
    const dup = this.taken.find((k) => Math.abs(k.t_ms - f.t_ms) < MIN_GAP_MS && k.phash === phash);
    if (dup) {
      this.stats.skipped++;
      return;
    }
    const redacted = await this.deps.redactor.redact(f.jpeg, boxes);
    // Off-record may have started while Presidio was working.
    if (epoch !== this.epoch || this.session.offRecord) return;
    const webp = await sharp(redacted.image).webp({ quality: 80 }).toBuffer();
    const path = `${CAPTURES_BUCKET}/org/${this.session.org_id}/sessions/${this.session.session_id}/keyframes/${f.t_ms}.webp`;
    await this.deps.store.upload(path, webp, "image/webp");
    const id = randomUUID();
    await this.deps.store.insertKeyframe({ id, org_id: this.session.org_id, session_id: this.session.session_id, t_ms: f.t_ms, storage_path: path, phash, redacted: redacted.presidio });
    await this.deps.store.attachKeyframe(eventIds, id);
    this.taken.push({ t_ms: f.t_ms, phash });
    if (this.taken.length > 50) this.taken.shift();
    this.stats.stored++;
    if (redacted.presidio) this.stats.presidio++;
    this.log.info({ keyframe_id: id, t_ms: f.t_ms, events: eventIds.length, presidio: redacted.presidio, pii_boxes: boxes.length, latency_ms: Date.now() - started }, "keyframe stored");
  }
}

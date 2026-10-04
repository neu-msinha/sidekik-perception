/**
 * The per-session frame pipeline (DESIGN §3):
 *   frame → diff (drop | crop | full) → Claude vision → normalize + merge with DOM → ScreenEvents → persist + publish → ctx
 * At most 2 vision calls in flight per session; while they run only the latest frame waits.
 * Results are applied in the order the frames were sent, so the state never goes backwards.
 */
import { sessionLogger, type DomEvent, type Envelope, type Logger } from "@sidekik/contracts";
import { CtxBatcher } from "./ctx.js";
import { analyzeFrame, decide, type FrameAnalysis } from "./diff.js";
import type { FrameSink, IncomingFrame } from "./frames/routes.js";
import { Keyframer, type KeyframeDeps } from "./keyframes.js";
import type { Publisher } from "./publisher.js";
import type { Session } from "./sessions.js";
import { ScreenTracker, type TrackedEvent } from "./state.js";
import { anthropicUsage } from "./usage.js";
import { prepareImage } from "./vision/image.js";
import { VisionError, type Vision, type VisionCall } from "./vision/vision.js";

export const MAX_IN_FLIGHT = 2;

export type PipelineDeps = {
  vision: Vision;
  publisher: Publisher;
  log: Logger;
  now?: () => number;
  /** ctx throttle (DESIGN: 5 s); tests shorten it. */
  ctxEveryMs?: number;
  /** Keyframes and the raw-frame ring buffer; without it no frame is kept at all. */
  keyframes?: KeyframeDeps;
};

/** Called with every batch of events a session publishes (keyframes hook in here). */
export type EventsListener = (session: Session, published: Awaited<ReturnType<Publisher["screenEvents"]>>, frame?: IncomingFrame) => void;

export class SessionPipeline {
  readonly tracker: ScreenTracker;
  readonly keyframer: Keyframer | undefined;
  private readonly ctx: CtxBatcher;
  private readonly log: Logger;
  private readonly now: () => number;

  private latest: IncomingFrame | undefined;
  private analyzing = false;
  private inFlight = 0;
  private baseline: FrameAnalysis | undefined;
  /** Last frame whose vision call succeeded: the baseline goes back to it when a call fails. */
  private lastGood: FrameAnalysis | undefined;
  private dispatchSeq = 0;
  private lastFullT: number | undefined;
  /** Results are applied in dispatch order. */
  private applyChain: Promise<void> = Promise.resolve();
  /** Bumped by off-record and end: results from before it are thrown away. */
  private epoch = 0;
  /** Session clock: latest t_ms seen and the wall time it arrived. */
  private lastT = 0;
  private lastWall = 0;
  readonly stats = { frames: 0, dropped_still: 0, dropped_busy: 0, partial: 0, full: 0, vision_failed: 0, events: 0 };

  constructor(
    readonly session: Session,
    private readonly deps: PipelineDeps,
    private readonly onEvents?: EventsListener,
  ) {
    this.now = deps.now ?? Date.now;
    this.tracker = new ScreenTracker(session.language);
    this.keyframer = deps.keyframes ? new Keyframer(session, deps.keyframes) : undefined;
    this.log = sessionLogger(deps.log, session);
    this.ctx = new CtxBatcher((text, t) => deps.publisher.ctx(session, text, t).catch((err: unknown) => this.log.error({ err }, "ctx publish failed")), this.now, deps.ctxEveryMs);
  }

  /** Session time now, projected from the last frame or DOM event. */
  nowT(): number {
    return this.lastT + Math.max(0, this.now() - this.lastWall);
  }

  onFrame(frame: IncomingFrame): void {
    if (this.session.offRecord) return;
    this.stats.frames++;
    this.seeT(frame.t_ms);
    this.keyframer?.onFrame(frame);
    if (this.latest) this.stats.dropped_busy++;
    this.latest = frame;
    void this.pump();
  }

  async onDom(ev: Envelope<DomEvent>): Promise<void> {
    if (this.session.offRecord) return;
    this.seeT(ev.t_ms);
    await this.emit(this.tracker.applyDom(ev.data, ev.t_ms));
  }

  /** Commits settled edits; called on a timer. */
  async tick(): Promise<void> {
    if (this.session.offRecord || !this.tracker.hasPending()) return;
    await this.emit(this.tracker.tick(this.nowT()));
  }

  /** Brain asked a question: keyframes around it. */
  onAsk(t_ms: number): void {
    if (!this.session.offRecord) this.keyframer?.onAsk(t_ms);
  }

  /** Off-record: forget the waiting frame, the ring buffer and everything in flight; stop ctx. */
  pause(): void {
    this.epoch++;
    this.latest = undefined;
    this.ctx.clear();
    this.keyframer?.clear();
  }

  /** Session ended: commit what's settled-enough, send the last ctx, stop. */
  async close(): Promise<void> {
    if (!this.session.offRecord) {
      await this.applyChain;
      await this.emit(this.tracker.tick(this.nowT() + 60_000));
      await this.ctx.flush();
    }
    await this.keyframer?.idle();
    this.epoch++;
    this.latest = undefined;
    this.ctx.clear();
    this.keyframer?.clear();
    this.log.info({ ...this.stats, keyframes: this.keyframer?.stats }, "pipeline closed");
  }

  /** Waits until no frame is waiting, analyzing or in flight (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.latest || this.analyzing || this.inFlight > 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await this.applyChain;
    await this.keyframer?.idle();
  }

  private seeT(t: number): void {
    if (t >= this.lastT) {
      this.lastT = t;
      this.lastWall = this.now();
    }
  }

  private async pump(): Promise<void> {
    if (this.analyzing || this.inFlight >= MAX_IN_FLIGHT || !this.latest) return;
    const frame = this.latest;
    this.latest = undefined;
    this.analyzing = true;
    const epoch = this.epoch;
    try {
      const analysis = await analyzeFrame(frame.jpeg);
      if (epoch !== this.epoch || this.session.offRecord) return;
      const d = decide(this.baseline, analysis, { reason: frame.reason, t_ms: frame.t_ms, ...(this.lastFullT !== undefined ? { lastFullT: this.lastFullT } : {}) });
      if (d.kind === "drop") {
        this.stats.dropped_still++;
        return;
      }
      this.stats[d.kind]++;
      if (d.kind === "full" && d.why === "dist") this.keyframer?.onNewScreen(frame);
      const previousBaseline = this.baseline;
      this.baseline = analysis;
      if (d.kind === "full") this.lastFullT = frame.t_ms;
      const seq = ++this.dispatchSeq;
      const image = await prepareImage(frame.jpeg, analysis, d.kind === "partial" ? d.crop : undefined);
      const previous = this.tracker.previousForVision();
      this.inFlight++;
      const call = this.deps.vision.see({ image, previous }).then(
        (res) => ({ ok: true as const, res }),
        (err: unknown) => ({ ok: false as const, err }),
      );
      // Apply in dispatch order, whatever order the calls finish in.
      this.applyChain = this.applyChain.then(async () => {
        const r = await call;
        this.inFlight--;
        const calls: VisionCall[] = r.ok ? r.res.calls : r.err instanceof VisionError ? r.err.calls : [];
        await this.deps.publisher.usage(this.session, frame.t_ms, calls.flatMap((c) => anthropicUsage(c.model, c.usage)));
        if (epoch !== this.epoch || this.session.offRecord) return;
        if (!r.ok) {
          this.stats.vision_failed++;
          this.log.warn({ t_ms: frame.t_ms, err: r.err }, "vision failed, frame skipped");
          // Compare the next frame with what vision last saw, so the change isn't lost.
          if (seq === this.dispatchSeq) this.baseline = this.lastGood ?? previousBaseline;
          return;
        }
        this.lastGood = analysis;
        this.log.debug({ t_ms: frame.t_ms, kind: d.kind, dist: d.dist, model: r.res.model, escalated: r.res.escalated, latency_ms: r.res.latency_ms }, "vision");
        await this.emit(this.tracker.applyVision(r.res.output, { t_ms: frame.t_ms, reason: frame.reason, image, lang: this.session.language }), frame);
        void this.pump();
      });
    } catch (err) {
      this.log.warn({ err, t_ms: frame.t_ms }, "frame could not be processed");
    } finally {
      this.analyzing = false;
      void this.pump();
    }
  }

  private async emit(events: TrackedEvent[], frame?: IncomingFrame): Promise<void> {
    if (events.length === 0) return;
    this.stats.events += events.length;
    const published = await this.deps.publisher.screenEvents(this.session, events);
    this.ctx.add(events);
    this.keyframer?.onEvents(published, frame);
    this.onEvents?.(this.session, published, frame);
  }
}

/** Owns one SessionPipeline per live session; it is the frames sink and the bus hooks. */
export class PipelineManager implements FrameSink {
  private readonly pipelines = new Map<string, SessionPipeline>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly deps: PipelineDeps,
    private readonly onEvents?: EventsListener,
    tickMs = 250,
  ) {
    this.timer = setInterval(() => {
      for (const p of this.pipelines.values()) void p.tick().catch((err: unknown) => deps.log.error({ err }, "tick failed"));
    }, tickMs);
    this.timer.unref();
  }

  get(session: Session): SessionPipeline {
    let p = this.pipelines.get(session.session_id);
    if (!p) {
      p = new SessionPipeline(session, this.deps, this.onEvents);
      this.pipelines.set(session.session_id, p);
    }
    return p;
  }

  peek(sessionId: string): SessionPipeline | undefined {
    return this.pipelines.get(sessionId);
  }

  onFrame(session: Session, frame: IncomingFrame): void {
    this.get(session).onFrame(frame);
  }

  async onDom(session: Session, ev: Envelope<DomEvent>): Promise<void> {
    await this.get(session).onDom(ev);
  }

  onAsk(session: Session, t_ms: number): void {
    this.pipelines.get(session.session_id)?.onAsk(t_ms);
  }

  onOffRecord(session: Session, on: boolean): void {
    if (on) this.pipelines.get(session.session_id)?.pause();
  }

  async onEnded(session: Session): Promise<void> {
    const p = this.pipelines.get(session.session_id);
    this.pipelines.delete(session.session_id);
    this.deps.publisher.forget(session.session_id);
    await p?.close();
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await Promise.all([...this.pipelines.values()].map((p) => p.idle()));
  }
}

/**
 * Clips job (DESIGN §5): a short MP4 per Work Map step, cut from the session's redacted keyframes,
 * for the Work Map page and the tutor's replay. POST /internal/clips answers 202 {job_id} at once.
 *
 * Keyframes are sparse (taken on changes), so the clip is a time-aligned slideshow: at 2 fps, each
 * slot shows the latest keyframe at or before its time. With fewer than 3 keyframes in the window,
 * the 3 nearest keyframes in the session share the clip equally instead (DESIGN §5 step 4).
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { sessionLogger, type Logger } from "@sidekik/contracts";
import sharp from "sharp";
import type { SessionDirectory } from "./directory.js";
import { CAPTURES_BUCKET, type KeyframeRow, type PerceptionStore } from "./store.js";

const run = promisify(execFile);

export const CLIP_FPS = 2;
export const MIN_KEYFRAMES = 3;
/** Clip frame width; heights follow the keyframes' aspect ratio. */
const CLIP_WIDTH = 1280;

export type ClipItem = { step_id: string; t_ms: number; before_s: number; after_s: number };
export type ClipsRequest = { session_id: string; items: ClipItem[] };

export type ItemStatus = { step_id: string; status: "pending" | "done" | "failed"; clip_id?: string; storage_path?: string; duration_s?: number; keyframes?: number; error?: string };
export type ClipJob = { job_id: string; session_id: string; status: "queued" | "running" | "done" | "failed"; items: ItemStatus[]; error?: string };

/** Which keyframe each 2 fps slot of [from, to] shows. */
export function slideshow(keyframes: KeyframeRow[], from: number, to: number): KeyframeRow[] {
  if (keyframes.length === 0) return [];
  const sorted = [...keyframes].sort((a, b) => a.t_ms - b.t_ms);
  const slots = Math.max(1, Math.round(((to - from) / 1000) * CLIP_FPS));
  const out: KeyframeRow[] = [];
  for (let i = 0; i < slots; i++) {
    const t = from + (i * 1000) / CLIP_FPS;
    let pick = sorted[0]!;
    for (const k of sorted) if (k.t_ms <= t) pick = k;
    out.push(pick);
  }
  return out;
}

/** Each of `keyframes` (in time order) for an equal share of the clip: the sparse-window slideshow. */
export function evenSlideshow(keyframes: KeyframeRow[], from: number, to: number): KeyframeRow[] {
  const sorted = [...keyframes].sort((a, b) => a.t_ms - b.t_ms);
  const slots = Math.max(1, Math.round(((to - from) / 1000) * CLIP_FPS));
  return Array.from({ length: slots }, (_, i) => sorted[Math.min(sorted.length - 1, Math.floor((i * sorted.length) / slots))]!);
}

/**
 * The clip's frames: time-aligned over the window's keyframes, or, with fewer than 3 in the window,
 * the 3 keyframes nearest to `t`, each shown for an equal share.
 */
export function clipFrames(all: KeyframeRow[], t: number, from: number, to: number): KeyframeRow[] {
  const inWindow = all.filter((k) => k.t_ms >= from && k.t_ms <= to);
  if (inWindow.length >= MIN_KEYFRAMES) return slideshow(inWindow, from, to);
  const nearest = [...all].sort((a, b) => Math.abs(a.t_ms - t) - Math.abs(b.t_ms - t)).slice(0, MIN_KEYFRAMES);
  return nearest.length ? evenSlideshow(nearest, from, to) : [];
}

export type ClipsDeps = { store: PerceptionStore; directory: SessionDirectory; log: Logger; ffmpeg?: string };

export class ClipsService {
  private readonly jobs = new Map<string, ClipJob>();
  /** One job at a time: ffmpeg is CPU-heavy and Work Map publishing isn't latency-critical. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ClipsDeps) {}

  submit(req: ClipsRequest): ClipJob {
    const job: ClipJob = { job_id: randomUUID(), session_id: req.session_id, status: "queued", items: req.items.map((i) => ({ step_id: i.step_id, status: "pending" })) };
    this.jobs.set(job.job_id, job);
    this.queue = this.queue.then(() => this.run(job, req)).catch(() => {});
    // Keep the last 200 jobs for status lookups.
    if (this.jobs.size > 200) this.jobs.delete(this.jobs.keys().next().value!);
    return job;
  }

  get(jobId: string): ClipJob | undefined {
    return this.jobs.get(jobId);
  }

  idle(): Promise<void> {
    return this.queue;
  }

  private async run(job: ClipJob, req: ClipsRequest): Promise<void> {
    job.status = "running";
    const org = await this.deps.directory.orgOf(req.session_id).catch(() => undefined);
    if (!org) {
      job.status = "failed";
      job.error = "unknown session";
      for (const i of job.items) Object.assign(i, { status: "failed", error: "unknown session" });
      this.deps.log.warn({ session_id: req.session_id, job_id: job.job_id }, "clips: unknown session");
      return;
    }
    const log = sessionLogger(this.deps.log, { session_id: req.session_id, org_id: org });
    const all = await this.deps.store.listKeyframes(req.session_id);
    for (const [n, item] of req.items.entries()) {
      const status = job.items[n]!;
      const started = Date.now();
      try {
        Object.assign(status, await this.cut(org, req.session_id, item, all));
        status.status = "done";
        log.info({ job_id: job.job_id, step_id: item.step_id, keyframes: status.keyframes, latency_ms: Date.now() - started }, "clip stored");
      } catch (err) {
        status.status = "failed";
        status.error = err instanceof Error ? err.message : String(err);
        log.error({ job_id: job.job_id, step_id: item.step_id, err }, "clip failed");
      }
    }
    job.status = job.items.every((i) => i.status === "failed") ? "failed" : "done";
  }

  private async cut(org: string, sessionId: string, item: ClipItem, all: KeyframeRow[]): Promise<Omit<ItemStatus, "step_id" | "status">> {
    const from = Math.max(0, item.t_ms - item.before_s * 1000);
    const to = item.t_ms + item.after_s * 1000;
    const frames = clipFrames(all, item.t_ms, from, to);
    if (frames.length === 0) throw new Error("no keyframes for this session");
    const duration_s = frames.length / CLIP_FPS;

    const dir = await mkdtemp(join(tmpdir(), "sk-clip-"));
    try {
      // Every keyframe once, scaled to one even size (x264 needs even dimensions and a constant size).
      const first = await this.deps.store.download(frames[0]!.storage_path);
      const meta = await sharp(first).metadata();
      const height = 2 * Math.round(((meta.height ?? 720) * CLIP_WIDTH) / (meta.width ?? CLIP_WIDTH) / 2);
      const rendered = new Map<string, Buffer>();
      for (const k of new Set(frames)) {
        const bytes = k === frames[0] ? first : await this.deps.store.download(k.storage_path);
        // PNG, not JPEG: a JPEG input makes ffmpeg keep full-range yuvj420p, which some players reject.
        rendered.set(k.id, await sharp(bytes).resize(CLIP_WIDTH, height, { fit: "contain", background: "#000" }).png({ compressionLevel: 1 }).toBuffer());
      }
      await Promise.all(frames.map((k, i) => writeFile(join(dir, `frame_${String(i).padStart(4, "0")}.png`), rendered.get(k.id)!)));
      const out = join(dir, "out.mp4");
      await run(this.deps.ffmpeg ?? "ffmpeg", [
        "-y", "-loglevel", "error",
        "-framerate", String(CLIP_FPS),
        "-i", join(dir, "frame_%04d.png"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-t", String(duration_s),
        "-movflags", "+faststart",
        out,
      ]);
      const path = `${CAPTURES_BUCKET}/org/${org}/sessions/${sessionId}/clips/${item.step_id}.mp4`;
      await this.deps.store.upload(path, await readFile(out), "video/mp4");
      const id = randomUUID();
      await this.deps.store.insertClip({ id, org_id: org, session_id: sessionId, step_id: item.step_id, t_ms: item.t_ms, storage_path: path, duration_s });
      return { clip_id: id, storage_path: path, duration_s, keyframes: new Set(frames).size };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

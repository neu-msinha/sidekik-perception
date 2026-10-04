import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { clipFrames, ClipsService, slideshow } from "../src/clips.js";
import { buildServer } from "../src/server.js";
import { MemoryStore, type KeyframeRow } from "../src/store.js";
import { invoiceSvg, jpeg, listSvg } from "./fixtures/screens.js";
import { INTERNAL, ORG, SID, silentLogger } from "./helpers.js";

const STEP = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const HAS_FFMPEG = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const kf = (t_ms: number): KeyframeRow => ({ id: `k${t_ms}`, org_id: ORG, session_id: SID, t_ms, storage_path: `captures/org/${ORG}/sessions/${SID}/keyframes/${t_ms}.webp`, phash: "0".repeat(16), redacted: true });

describe("clip frame selection", () => {
  it("shows the latest keyframe at or before each 2 fps slot", () => {
    const frames = slideshow([kf(1000), kf(4000), kf(6000)], 0, 10_000);
    expect(frames).toHaveLength(20);
    expect(frames.map((f) => f.t_ms).slice(0, 3)).toEqual([1000, 1000, 1000]); // before the first: the first
    expect(frames[8]?.t_ms).toBe(4000);
    expect(frames[19]?.t_ms).toBe(6000);
  });

  it("uses the window's keyframes, or spreads the 3 nearest when it has fewer than 3", () => {
    const all = [kf(1000), kf(20_000), kf(21_000), kf(22_000), kf(40_000), kf(41_000)];
    const distinct = (ks: KeyframeRow[]) => [...new Set(ks.map((k) => k.t_ms))];
    expect(distinct(clipFrames(all, 21_000, 15_000, 25_000))).toEqual([20_000, 21_000, 22_000]);
    const sparse = clipFrames(all, 34_000, 28_000, 38_000);
    expect(distinct(sparse)).toEqual([22_000, 40_000, 41_000]);
    expect(sparse.filter((k) => k.t_ms === 40_000)).toHaveLength(7);
    expect(clipFrames([], 0, 0, 1)).toEqual([]);
  });
});

async function seeded() {
  const store = new MemoryStore();
  const shots = [await jpeg(invoiceSvg({ invoice: "4471", amount: "6350", costCenter: "4711" })), await jpeg(listSvg())];
  for (const [i, t] of [1000, 3000, 5000, 7000, 30_000].entries()) {
    const row = kf(t);
    await store.upload(row.storage_path, await sharp(shots[i % 2]!).webp().toBuffer(), "image/webp");
    await store.insertKeyframe(row);
  }
  return store;
}

const directory = { orgOf: async (sid: string) => (sid === SID ? ORG : undefined) };

describe.skipIf(!HAS_FFMPEG)("ClipsService (ffmpeg)", () => {
  it("cuts a 10 s MP4 around a step, uploads it and writes the clips row", async () => {
    const store = await seeded();
    const svc = new ClipsService({ store, directory, log: silentLogger() });
    const job = svc.submit({ session_id: SID, items: [{ step_id: STEP, t_ms: 6000, before_s: 6, after_s: 4 }] });
    await svc.idle();
    expect(svc.get(job.job_id)).toMatchObject({ status: "done", items: [{ step_id: STEP, status: "done", duration_s: 10, keyframes: 4 }] });

    const path = `captures/org/${ORG}/sessions/${SID}/clips/${STEP}.mp4`;
    const file = store.files.get(path)!;
    expect(file.contentType).toBe("video/mp4");
    expect(store.clips).toEqual([expect.objectContaining({ session_id: SID, org_id: ORG, step_id: STEP, t_ms: 6000, storage_path: path, duration_s: 10 })]);

    const tmp = join(mkdtempSync(join(tmpdir(), "sk-clip-test-")), "c.mp4");
    writeFileSync(tmp, file.bytes);
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height,pix_fmt:format=duration", "-of", "json", tmp]).toString());
    expect(probe.streams[0]).toMatchObject({ codec_name: "h264", width: 1280, height: 720, pix_fmt: "yuv420p" });
    expect(Number(probe.format.duration)).toBeCloseTo(10, 0);
  });

  it("builds a slideshow from the nearest keyframes when the window is sparse", async () => {
    const store = await seeded();
    const svc = new ClipsService({ store, directory, log: silentLogger() });
    const job = svc.submit({ session_id: SID, items: [{ step_id: STEP, t_ms: 25_000, before_s: 6, after_s: 4 }] });
    await svc.idle();
    expect(svc.get(job.job_id)?.items[0]).toMatchObject({ status: "done", keyframes: 3 });
  });
});

describe("ClipsService failures", () => {
  it("fails the job for an unknown session and an item without keyframes", async () => {
    const svc = new ClipsService({ store: new MemoryStore(), directory, log: silentLogger() });
    const a = svc.submit({ session_id: "other", items: [{ step_id: STEP, t_ms: 0, before_s: 6, after_s: 4 }] });
    const b = svc.submit({ session_id: SID, items: [{ step_id: STEP, t_ms: 0, before_s: 6, after_s: 4 }] });
    await svc.idle();
    expect(svc.get(a.job_id)).toMatchObject({ status: "failed", error: "unknown session" });
    expect(svc.get(b.job_id)).toMatchObject({ status: "failed", items: [{ status: "failed", error: "no keyframes for this session" }] });
  });
});

describe("POST /internal/clips", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it("validates, answers 202 {job_id} and reports job status", async () => {
    const store = await seeded();
    const clips = new ClipsService({ store, directory, log: silentLogger() });
    const app = buildServer({ version: "t", logger: silentLogger(), checks: {}, internal: { token: INTERNAL, store, clips } });
    close = () => app.close();
    const headers = { "x-internal-token": INTERNAL };
    expect((await app.inject({ method: "POST", url: "/internal/clips", payload: { session_id: SID, items: [] }, headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/internal/clips", payload: { session_id: SID, items: [{ step_id: STEP, t_ms: 6000 }] } })).statusCode).toBe(401);
    const res = await app.inject({ method: "POST", url: "/internal/clips", payload: { session_id: SID, items: [{ step_id: STEP, t_ms: 6000 }] }, headers });
    expect(res.statusCode).toBe(202);
    const { job_id } = res.json() as { job_id: string };
    await clips.idle();
    const status = await app.inject({ method: "GET", url: `/internal/clips/${job_id}`, headers });
    // Defaults from the contract: 6 s before, 4 s after.
    expect(status.json()).toMatchObject({ job_id, status: HAS_FFMPEG ? "done" : "failed", items: [{ step_id: STEP }] });
    expect((await app.inject({ method: "GET", url: "/internal/clips/nope", headers })).statusCode).toBe(404);
  });
});

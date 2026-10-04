import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import type { IncomingFrame } from "../src/frames/routes.js";
import { Keyframer, RingBuffer } from "../src/keyframes.js";
import type { PublishedEvent } from "../src/publisher.js";
import { blurBoxes, isPiiField, PresidioImageRedactor, type ImageRedactor } from "../src/redact-image.js";
import type { Session } from "../src/sessions.js";
import { MemoryStore } from "../src/store.js";
import { invoiceSvg, jpeg, listSvg } from "./fixtures/screens.js";
import { ORG, SID, silentLogger } from "./helpers.js";

let A: Buffer;
let B: Buffer;
beforeAll(async () => {
  A = await jpeg(invoiceSvg({ invoice: "4471", amount: "6350", costCenter: "4711" }));
  B = await jpeg(listSvg());
});

const frame = (t_ms: number, img = A, reason: IncomingFrame["reason"] = "tick"): IncomingFrame => ({ t_ms, reason, jpeg: img, source: "browser", received_ms: 0 });
const session = (kind: "capture" | "tutor" = "capture"): Session => ({ session_id: SID, org_id: ORG, kind, mode: "browser", phase: "capture", language: "de", offRecord: false });

class SpyRedactor implements ImageRedactor {
  readonly boxes: number[] = [];
  async redact(img: Buffer, boxes: { left: number }[]) {
    this.boxes.push(boxes.length);
    return { image: img, presidio: true };
  }
}

function published(type: string, t_ms: number, event_id: string, extra: Partial<PublishedEvent["tracked"]> = {}): PublishedEvent {
  const tracked = { type: type as never, t_ms, confidence: 1, source: "vision" as const, state: {}, ...extra };
  return { event: { event_id, type: type as never, state: {}, confidence: 1, source: "vision" }, t_ms, tracked };
}

function keyframer(kind: "capture" | "tutor" = "capture") {
  const store = new MemoryStore();
  const redactor = new SpyRedactor();
  const s = session(kind);
  return { store, redactor, s, k: new Keyframer(s, { store, redactor, log: silentLogger() }) };
}

describe("RingBuffer", () => {
  it("keeps 20 s of frames and finds the nearest", () => {
    const r = new RingBuffer();
    for (let t = 0; t <= 30_000; t += 1000) r.push(frame(t));
    expect(r.size).toBe(21);
    expect(r.nearest(25_400)?.t_ms).toBe(25_000);
    expect(r.nearest(5_000, 2000)).toBeUndefined();
    expect(r.between(27_000, 29_000).map((f) => f.t_ms)).toEqual([27_000, 28_000, 29_000]);
    r.clear();
    expect(r.size).toBe(0);
  });
});

describe("Keyframer", () => {
  it("stores a redacted webp for a field change and links the event, never the raw JPEG", async () => {
    const { k, store } = keyframer();
    await store.insertScreenEvents([{ org_id: ORG, session_id: SID, event_id: "ev1", t_ms: 7000, type: "field_changed", entity_kind: null, entity_id: null, field: "cost_center", before_val: "4711", after_val: "0400", state: {}, bbox: null, confidence: 1, source: "vision" }]);
    k.onFrame(frame(7000));
    k.onEvents([published("field_changed", 7000, "ev1")], frame(7000));
    await k.idle();
    expect(store.keyframes).toHaveLength(1);
    const kf = store.keyframes[0]!;
    expect(kf).toMatchObject({ t_ms: 7000, redacted: true, storage_path: `captures/org/${ORG}/sessions/${SID}/keyframes/7000.webp` });
    expect(kf.phash).toMatch(/^[0-9a-f]{16}$/);
    expect(store.screenEvents[0]?.keyframe_id).toBe(kf.id);
    const files = [...store.files.values()];
    expect(files.every((f) => f.contentType === "image/webp")).toBe(true);
    expect((await sharp(files[0]!.bytes).metadata()).format).toBe("webp");
    expect(files.some((f) => f.bytes.equals(A))).toBe(false);
  });

  it("uses the nearest buffered frame for DOM events and skips duplicates within a second", async () => {
    const { k, store } = keyframer();
    k.onFrame(frame(6000));
    k.onEvents([published("field_changed", 7200, "ev1", { source: "dom" })]);
    k.onEvents([published("button_clicked", 7300, "ev2", { source: "dom" })]);
    await k.idle();
    expect(store.keyframes.map((x) => x.t_ms)).toEqual([6000]);
    // Typing and values read don't take keyframes; DOM events with no frame nearby don't either.
    k.onEvents([published("typing_in_progress", 7400, "ev3")], frame(7400));
    k.onEvents([published("field_changed", 60_000, "ev4", { source: "dom" })]);
    await k.idle();
    expect(store.keyframes).toHaveLength(1);
  });

  it("takes the first frame after navigation", async () => {
    const { k, store } = keyframer();
    k.onFrame(frame(1000, B, "nav"));
    k.onNewScreen(frame(5000, A));
    await k.idle();
    expect(store.keyframes.map((x) => x.t_ms)).toEqual([1000, 5000]);
  });

  it("keeps one frame a second from 5 s before to 5 s after an ask", async () => {
    const { k, store } = keyframer();
    for (let t = 0; t <= 10_000; t += 500) k.onFrame(frame(t, t % 1000 ? A : B));
    k.onAsk(10_000);
    for (let t = 10_500; t <= 17_000; t += 500) k.onFrame(frame(t));
    await k.idle();
    const ts = store.keyframes.map((x) => x.t_ms);
    expect(Math.min(...ts)).toBe(5000);
    expect(Math.max(...ts)).toBe(15_000);
    expect(ts).toHaveLength(11);
  });

  it("blurs fields holding personal data on every later keyframe", async () => {
    const { k, redactor } = keyframer();
    k.onEvents([published("field_changed", 1000, "e1", { field: "approver", after: "<PERSON_1>", bbox: { left: 10, top: 10, width: 50, height: 20 } })], frame(1000));
    k.onFrame(frame(3000, B, "nav"));
    await k.idle();
    expect(redactor.boxes).toEqual([1, 1]);
  });

  it("stores nothing for learners unless the org opted in", async () => {
    const { k, store } = keyframer("tutor");
    k.onFrame(frame(1000, A, "nav"));
    await k.idle();
    expect(store.keyframes).toHaveLength(0);

    const opted = new MemoryStore();
    opted.learnerKeyframes = true;
    const k2 = new Keyframer(session("tutor"), { store: opted, redactor: new SpyRedactor(), log: silentLogger() });
    k2.onFrame(frame(1000, A, "nav"));
    await k2.idle();
    expect(opted.keyframes).toHaveLength(1);
  });

  it("clear() empties the ring buffer and drops keyframes not yet stored", async () => {
    const { k, store } = keyframer();
    k.onFrame(frame(1000, A, "nav"));
    k.onFrame(frame(2000, B, "nav"));
    k.clear();
    await k.idle();
    expect(k.ring.size).toBe(0);
    expect(store.keyframes).toHaveLength(0);
  });
});

describe("image redaction", () => {
  it("knows which fields hold personal data", () => {
    expect(isPiiField("approver")).toBe(true);
    expect(isPiiField("Ansprechpartner")).toBe(true);
    expect(isPiiField("comment", "Bitte <PERSON_2> fragen")).toBe(true);
    expect(isPiiField("cost_center", "0400")).toBe(false);
    expect(isPiiField("supplier", "Kranbau GmbH")).toBe(false);
  });

  it("blurs only inside the boxes", async () => {
    const out = await blurBoxes(A, [{ left: 420, top: 360, width: 200, height: 40 }]);
    const [before, after] = await Promise.all([sharp(A).raw().toBuffer({ resolveWithObject: true }), sharp(out).raw().toBuffer({ resolveWithObject: true })]);
    const px = (b: Buffer, x: number, y: number) => b[(y * before.info.width + x) * before.info.channels]!;
    // Outside: the header bar is untouched (allowing for JPEG re-encoding).
    expect(Math.abs(px(before.data, 100, 20) - px(after.data, 100, 20))).toBeLessThan(10);
    // Inside: the digit strokes are smeared.
    let diff = 0;
    for (let x = 430; x < 520; x++) diff += Math.abs(px(before.data, x, 380) - px(after.data, x, 380));
    expect(diff / 90).toBeGreaterThan(10);
  });

  it("posts the frame to Presidio as multipart and uses the image it returns", async () => {
    const seen: FormData[] = [];
    const redacted = await sharp({ create: { width: 64, height: 36, channels: 3, background: "#000" } }).jpeg().toBuffer();
    const fetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe("http://presidio:3000/redact");
      seen.push(init.body as FormData);
      return new Response(new Uint8Array(redacted), { status: 200, headers: { "content-type": "application/octet-stream" } });
    }) as typeof globalThis.fetch;
    const res = await new PresidioImageRedactor({ url: "http://presidio:3000/", fetch }).redact(A, []);
    expect(res.presidio).toBe(true);
    expect(res.image.equals(redacted)).toBe(true);
    expect(seen[0]?.get("data")).toBe('{"color_fill":"0,0,0"}');
    expect((seen[0]?.get("image") as Blob).type).toBe("image/jpeg");
  });

  it("falls back to blurring known boxes when Presidio fails or isn't set", async () => {
    const down = (async () => new Response("no", { status: 500 })) as typeof globalThis.fetch;
    const box = [{ left: 420, top: 360, width: 200, height: 40 }];
    const a = await new PresidioImageRedactor({ url: "http://presidio:3000", fetch: down }).redact(A, box);
    expect(a.presidio).toBe(false);
    expect(a.image.equals(A)).toBe(false);
    const garbage = (async () => new Response("<html>oops</html>", { status: 200 })) as typeof globalThis.fetch;
    expect((await new PresidioImageRedactor({ url: "http://presidio:3000", fetch: garbage }).redact(A, [])).presidio).toBe(false);
    expect((await new PresidioImageRedactor({}).redact(A, [])).presidio).toBe(false);
  });
});

import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeFrame, changedTiles, decide, GRID, hamming, phash32, tilesBBox, type FrameAnalysis } from "../src/diff.js";
import { COST_CENTER_BOX, H, invoiceSvg, jpeg, listSvg, W } from "./fixtures/screens.js";

const base = { invoice: "4471", amount: "6350", costCenter: "4711" };
let A: FrameAnalysis; // invoice 4471 on 4711
let A2: FrameAnalysis; // same screen, re-encoded at another quality
let B: FrameAnalysis; // cost center 0400
let L: FrameAnalysis; // list view

beforeAll(async () => {
  A = await analyzeFrame(await jpeg(invoiceSvg(base)));
  A2 = await analyzeFrame(await jpeg(invoiceSvg(base), 55));
  B = await analyzeFrame(await jpeg(invoiceSvg({ ...base, costCenter: "0400" })));
  L = await analyzeFrame(await jpeg(listSvg()));
});

describe("phash", () => {
  it("is 16 hex chars and stable", async () => {
    expect(A.phash).toMatch(/^[0-9a-f]{16}$/);
    expect((await analyzeFrame(await jpeg(invoiceSvg(base)))).phash).toBe(A.phash);
  });

  it("hamming counts differing bits", () => {
    expect(hamming("0000000000000000", "0000000000000000")).toBe(0);
    expect(hamming("ffffffffffffffff", "0000000000000000")).toBe(64);
    expect(hamming("000000000000000f", "0000000000000001")).toBe(3);
  });

  it("separates different screens and ignores JPEG noise", () => {
    expect(hamming(A.phash, A2.phash)).toBeLessThanOrEqual(4);
    expect(hamming(A.phash, L.phash)).toBeGreaterThan(12);
  });

  it("has only the DC bit for a uniform image", () => {
    expect(phash32(new Uint8Array(32 * 32).fill(128))).toBe("8000000000000000");
  });
});

describe("tiles", () => {
  it("finds no changed tile between re-encodes of one screen", () => {
    expect(changedTiles(A, A2).filter(Boolean)).toHaveLength(0);
  });

  it("finds the cost center edit that the global pHash can't see", () => {
    expect(hamming(A.phash, B.phash)).toBeLessThanOrEqual(4);
    const tiles = changedTiles(A, B);
    expect(tiles.filter(Boolean).length).toBeGreaterThan(0);
    const box = tilesBBox(tiles, W, H)!;
    // The crop covers the field and stays small.
    expect(box.left).toBeLessThanOrEqual(COST_CENTER_BOX.left);
    expect(box.top).toBeLessThanOrEqual(COST_CENTER_BOX.top);
    expect(box.left + box.width).toBeGreaterThanOrEqual(COST_CENTER_BOX.left + 60);
    expect(box.top + box.height).toBeGreaterThanOrEqual(COST_CENTER_BOX.top + COST_CENTER_BOX.height);
    expect(box.width * box.height).toBeLessThan(0.1 * W * H);
  });

  it("pads and clamps the bounding box", () => {
    const tiles = new Array<boolean>(GRID * GRID).fill(false);
    tiles[0] = true;
    expect(tilesBBox(tiles, W, H)).toEqual({ left: 0, top: 0, width: W / GRID + 32, height: H / GRID + 32 });
    expect(tilesBBox(new Array<boolean>(GRID * GRID).fill(false), W, H)).toBeUndefined();
  });

  it("treats a size change as everything changed", async () => {
    const small = await analyzeFrame(await sharp(Buffer.from(invoiceSvg(base))).resize(640, 360).jpeg().toBuffer());
    expect(changedTiles(A, small).every(Boolean)).toBe(true);
  });
});

describe("decide", () => {
  const tick = (t_ms: number, lastFullT = 0) => ({ reason: "tick" as const, t_ms, lastFullT });

  it("sends the first frame in full", () => {
    expect(decide(undefined, A, tick(0))).toMatchObject({ kind: "full", why: "first" });
  });

  it("drops an unchanged frame", () => {
    expect(decide(A, A2, tick(1000))).toMatchObject({ kind: "drop" });
  });

  it("crops a small edit", () => {
    const d = decide(A, B, tick(1000));
    expect(d.kind).toBe("partial");
  });

  it("sends a new screen in full", () => {
    expect(decide(A, L, tick(1000))).toMatchObject({ kind: "full", why: "dist" });
  });

  it("sends blur, save and nav frames in full even when unchanged", () => {
    for (const reason of ["blur", "save", "nav"] as const) {
      expect(decide(A, A2, { reason, t_ms: 1000, lastFullT: 0 })).toMatchObject({ kind: "full", why: "reason" });
    }
  });

  it("upgrades a change to a full frame 15 s after the last one", () => {
    expect(decide(A, B, tick(15_000, 0))).toMatchObject({ kind: "full", why: "periodic" });
    expect(decide(A, A2, tick(15_000, 0))).toMatchObject({ kind: "drop" });
  });
});

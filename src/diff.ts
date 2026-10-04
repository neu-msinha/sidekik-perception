/**
 * Frame diffing (DESIGN §3): a 64-bit pHash of the whole frame plus a 16×16 tile grid.
 *
 * A global 64-bit pHash only sees large changes: re-typing a four-digit cost center in a 1280×720
 * frame doesn't flip a single bit. So each tile is also compared cell by cell on a 4× grayscale
 * downsample, and changed tiles decide whether there is anything to send. The pHash distance keeps
 * its DESIGN meaning for how much changed: ≤ 4 with no changed tile → drop; > 12 → full frame.
 */
import sharp from "sharp";

/** Tiles per side. */
export const GRID = 16;
/** Downsample factor for the change map: one cell is a 4×4 pixel block. */
export const CELL_PX = 4;
/** A cell has changed when its mean gray level moved by at least this much (JPEG noise stays well below). */
export const CELL_DELTA = 28;
/** A tile has changed when at least this many of its cells have. */
export const TILE_MIN_CELLS = 2;
/** Padding around the changed tiles' bounding box, in frame pixels. */
export const CROP_PAD_PX = 32;
/** pHash distance thresholds (DESIGN §3). */
export const STILL_MAX_DIST = 4;
export const PARTIAL_MAX_DIST = 12;
/** Changed area above which a crop saves little: send the full frame. */
export const FULL_AREA_FRACTION = 0.5;
/** Send a full frame at least this often while things change (DESIGN §3). */
export const FULL_EVERY_MS = 15_000;

export type FrameAnalysis = {
  width: number;
  height: number;
  /** 64-bit DCT perceptual hash, 16 hex chars (keyframes.phash). */
  phash: string;
  /** Grayscale change map: one byte per CELL_PX×CELL_PX block, row-major. */
  cells: Uint8Array;
  cellCols: number;
  cellRows: number;
};

export type Rect = { left: number; top: number; width: number; height: number };

export type DiffDecision =
  | { kind: "drop"; dist: number }
  | { kind: "partial"; dist: number; crop: Rect; tiles: number }
  | { kind: "full"; dist: number; tiles: number; why: "first" | "reason" | "dist" | "area" | "periodic" };

export async function analyzeFrame(jpeg: Buffer): Promise<FrameAnalysis> {
  const meta = await sharp(jpeg).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error("frame has no dimensions");
  const cellCols = Math.max(GRID, Math.round(width / CELL_PX));
  const cellRows = Math.max(GRID, Math.round(height / CELL_PX));
  const [cells, small] = await Promise.all([
    sharp(jpeg).greyscale().resize(cellCols, cellRows, { fit: "fill", kernel: "linear" }).raw().toBuffer(),
    sharp(jpeg).greyscale().resize(32, 32, { fit: "fill" }).raw().toBuffer(),
  ]);
  return { width, height, phash: phash32(small), cells: new Uint8Array(cells), cellCols, cellRows };
}

/** pHash of a 32×32 grayscale image: 2-D DCT, top-left 8×8, each bit = coefficient above the median (DC excluded). */
export function phash32(gray: Uint8Array | Buffer): string {
  const N = 32;
  const cos = new Float64Array(N * N);
  for (let k = 0; k < N; k++) for (let n = 0; n < N; n++) cos[k * N + n] = Math.cos(((2 * n + 1) * k * Math.PI) / (2 * N));
  // Separable DCT: rows, then columns, only the first 8 coefficients of each.
  const rows = new Float64Array(N * 8);
  for (let y = 0; y < N; y++)
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += (gray[y * N + x] ?? 0) * cos[u * N + x]!;
      rows[y * 8 + u] = s;
    }
  const coeffs: number[] = [];
  for (let v = 0; v < 8; v++)
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += rows[y * 8 + u]! * cos[v * N + y]!;
      coeffs.push(s);
    }
  const median = [...coeffs.slice(1)].sort((a, b) => a - b)[31]!;
  let bits = 0n;
  // The epsilon keeps floating-point noise in flat regions from flipping bits.
  for (const c of coeffs) bits = (bits << 1n) | (c > median + 1e-6 ? 1n : 0n);
  return bits.toString(16).padStart(16, "0");
}

export function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}

/** Changed tiles between two frames of the same size, as a GRID×GRID boolean map (row-major). */
export function changedTiles(prev: FrameAnalysis, cur: FrameAnalysis): boolean[] {
  const out = new Array<boolean>(GRID * GRID).fill(false);
  if (prev.cellCols !== cur.cellCols || prev.cellRows !== cur.cellRows) return out.fill(true);
  const counts = new Array<number>(GRID * GRID).fill(0);
  for (let r = 0; r < cur.cellRows; r++) {
    const tr = Math.min(GRID - 1, Math.floor((r * GRID) / cur.cellRows));
    for (let c = 0; c < cur.cellCols; c++) {
      const i = r * cur.cellCols + c;
      if (Math.abs(cur.cells[i]! - prev.cells[i]!) >= CELL_DELTA) {
        const t = tr * GRID + Math.min(GRID - 1, Math.floor((c * GRID) / cur.cellCols));
        counts[t]!++;
      }
    }
  }
  for (let t = 0; t < counts.length; t++) out[t] = counts[t]! >= TILE_MIN_CELLS;
  return out;
}

/** Bounding box of the changed tiles in frame pixels, padded and clamped to the frame. */
export function tilesBBox(tiles: boolean[], width: number, height: number, pad = CROP_PAD_PX): Rect | undefined {
  let minR = GRID, minC = GRID, maxR = -1, maxC = -1;
  tiles.forEach((on, t) => {
    if (!on) return;
    const r = Math.floor(t / GRID), c = t % GRID;
    minR = Math.min(minR, r); maxR = Math.max(maxR, r);
    minC = Math.min(minC, c); maxC = Math.max(maxC, c);
  });
  if (maxR < 0) return undefined;
  const left = Math.max(0, Math.floor((minC * width) / GRID) - pad);
  const top = Math.max(0, Math.floor((minR * height) / GRID) - pad);
  const right = Math.min(width, Math.ceil(((maxC + 1) * width) / GRID) + pad);
  const bottom = Math.min(height, Math.ceil(((maxR + 1) * height) / GRID) + pad);
  return { left, top, width: right - left, height: bottom - top };
}

export type DecideContext = {
  /** Frame reason from the header; anything but "tick" means navigation, blur or save: always full. */
  reason: "tick" | "blur" | "save" | "nav";
  /** Session time of this frame and of the last full frame sent to vision. */
  t_ms: number;
  lastFullT?: number;
};

/**
 * What to do with a frame, compared with the last frame sent to vision (`baseline`), so slow changes
 * accumulate instead of slipping under the threshold one frame at a time.
 */
export function decide(baseline: FrameAnalysis | undefined, cur: FrameAnalysis, ctx: DecideContext): DiffDecision {
  if (!baseline) return { kind: "full", dist: 64, tiles: GRID * GRID, why: "first" };
  const dist = hamming(baseline.phash, cur.phash);
  const tiles = changedTiles(baseline, cur);
  const changed = tiles.filter(Boolean).length;

  if (ctx.reason !== "tick") return { kind: "full", dist, tiles: changed, why: "reason" };
  if (changed === 0 && dist <= STILL_MAX_DIST) return { kind: "drop", dist };
  if (dist > PARTIAL_MAX_DIST) return { kind: "full", dist, tiles: changed, why: "dist" };
  if (ctx.lastFullT === undefined || ctx.t_ms - ctx.lastFullT >= FULL_EVERY_MS) return { kind: "full", dist, tiles: changed, why: "periodic" };

  const crop = tilesBBox(tiles, cur.width, cur.height);
  if (!crop || (crop.width * crop.height) / (cur.width * cur.height) > FULL_AREA_FRACTION) {
    return { kind: "full", dist, tiles: changed, why: "area" };
  }
  return { kind: "partial", dist, crop, tiles: changed };
}

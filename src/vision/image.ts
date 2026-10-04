import sharp from "sharp";
import type { Rect } from "../diff.js";

/** DESIGN §4: send at most 1280 px wide. */
export const MAX_VISION_WIDTH = 1280;

/** The image sent to vision and how to map its pixels back onto the full frame. */
export type VisionImage = {
  jpeg: Buffer;
  width: number;
  height: number;
  /** The frame region shown, in frame pixels (the whole frame when not cropped). */
  region: Rect;
  frameWidth: number;
  frameHeight: number;
  /** Image pixels per frame pixel (≤ 1). */
  scale: number;
};

/** Crops the frame to `crop` (if any) and caps the width at 1280 px. */
export async function prepareImage(jpeg: Buffer, frame: { width: number; height: number }, crop?: Rect): Promise<VisionImage> {
  const region = crop ?? { left: 0, top: 0, width: frame.width, height: frame.height };
  const scale = Math.min(1, MAX_VISION_WIDTH / region.width);
  let img = sharp(jpeg);
  if (crop) img = img.extract(crop);
  if (scale < 1) img = img.resize(Math.round(region.width * scale));
  const out = await img.jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
  return {
    jpeg: out.data,
    width: out.info.width,
    height: out.info.height,
    region,
    frameWidth: frame.width,
    frameHeight: frame.height,
    scale,
  };
}

/** Maps a bbox the model gave in image pixels onto frame pixels, clamped to the frame. */
export function toFrameBBox(bbox: number[] | null, img: VisionImage): Rect | undefined {
  if (!bbox || bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) return undefined;
  const [x, y, w, h] = bbox as [number, number, number, number];
  const left = Math.max(0, Math.round(img.region.left + x / img.scale));
  const top = Math.max(0, Math.round(img.region.top + y / img.scale));
  const right = Math.min(img.frameWidth, Math.round(img.region.left + (x + w) / img.scale));
  const bottom = Math.min(img.frameHeight, Math.round(img.region.top + (y + h) / img.scale));
  if (right <= left || bottom <= top) return undefined;
  return { left, top, width: right - left, height: bottom - top };
}

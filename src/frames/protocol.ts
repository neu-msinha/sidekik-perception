import { FrameHeaderSchema, type FrameHeader } from "@sidekik/contracts";

/** Largest JSON header accepted; real headers are ~40 bytes. */
export const MAX_HEADER_BYTES = 1024;
/** Largest frame message accepted (a 1280 px JPEG at q0.7 is ~100–300 KB). */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export type Frame = FrameHeader & { jpeg: Buffer };

export type ParseResult = { ok: true; frame: Frame } | { ok: false; error: string };

/**
 * Parses one binary frame message (DESIGN §2): a 4-byte big-endian header length, the JSON header
 * `{t_ms, reason}`, then the JPEG bytes. Used by /ws/frames (browser) and /internal/frames (meetbot).
 */
export function parseFrame(buf: Buffer): ParseResult {
  if (buf.length < 4) return { ok: false, error: "too short" };
  const headerLen = buf.readUInt32BE(0);
  if (headerLen === 0 || headerLen > MAX_HEADER_BYTES) return { ok: false, error: `bad header length ${headerLen}` };
  if (buf.length < 4 + headerLen + 3) return { ok: false, error: "truncated" };

  let header: FrameHeader;
  try {
    header = FrameHeaderSchema.parse(JSON.parse(buf.subarray(4, 4 + headerLen).toString("utf8")));
  } catch {
    return { ok: false, error: "bad header" };
  }

  const jpeg = buf.subarray(4 + headerLen);
  // Every JPEG starts with the SOI marker FF D8 FF.
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) return { ok: false, error: "not a JPEG" };
  return { ok: true, frame: { t_ms: header.t_ms, reason: header.reason, jpeg } };
}

/** Builds a frame message (tests, bench and dev tools; the browser and meetbot do the same). */
export function encodeFrame(header: FrameHeader, jpeg: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length, 0);
  return Buffer.concat([len, json, jpeg]);
}

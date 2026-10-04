/**
 * Keyframe redaction (DESIGN §3): Presidio's image redactor (OCR + PII recognizers) when configured,
 * plus a blur over every field the pipeline knows holds personal data. When Presidio is missing or
 * fails, the blur alone is the fallback DESIGN ticket 8 asks for.
 */
import sharp from "sharp";
import type { Rect } from "./diff.js";

/** Fields whose values identify people (by name), blurred on every keyframe. */
const PII_FIELD = /name|person|contact|kontakt|ansprech|email|e-mail|phone|telefon|mobile|iban|bic|bank|approver|freigeber|owner|user|signature|unterschrift/i;
/** Placeholders the vision prompt puts in place of personal data. */
const PII_PLACEHOLDER = /<(PERSON|IBAN|EMAIL|PHONE)[_A-Z0-9]*>/i;

export function isPiiField(field: string | undefined, value?: string): boolean {
  return (!!field && PII_FIELD.test(field)) || (!!value && PII_PLACEHOLDER.test(value));
}

export type Redacted = { image: Buffer; presidio: boolean };

export interface ImageRedactor {
  redact(jpeg: Buffer, piiBoxes: Rect[]): Promise<Redacted>;
}

/** Blurs each box (clamped to the image) hard enough that text can't be read back. */
export async function blurBoxes(image: Buffer, boxes: Rect[]): Promise<Buffer> {
  if (boxes.length === 0) return image;
  const meta = await sharp(image).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const overlays = [];
  for (const b of boxes) {
    const left = Math.max(0, Math.floor(b.left));
    const top = Math.max(0, Math.floor(b.top));
    const width = Math.min(W - left, Math.ceil(b.width));
    const height = Math.min(H - top, Math.ceil(b.height));
    if (width < 1 || height < 1) continue;
    const patch = await sharp(image).extract({ left, top, width, height }).blur(Math.max(8, Math.min(width, height) / 2)).toBuffer();
    overlays.push({ input: patch, left, top });
  }
  return overlays.length ? sharp(image).composite(overlays).toBuffer() : image;
}

export type PresidioImageOptions = { url?: string; timeoutMs?: number; fetch?: typeof fetch };

export class PresidioImageRedactor implements ImageRedactor {
  constructor(private readonly opts: PresidioImageOptions) {}

  async redact(jpeg: Buffer, piiBoxes: Rect[]): Promise<Redacted> {
    let image = jpeg;
    let presidio = false;
    if (this.opts.url) {
      try {
        image = await this.presidio(jpeg);
        presidio = true;
      } catch {
        image = jpeg;
      }
    }
    return { image: await blurBoxes(image, piiBoxes), presidio };
  }

  /** POST /redact, multipart `image` + `data` (presidio-image-redactor app.py); answers with the image bytes. */
  private async presidio(jpeg: Buffer): Promise<Buffer> {
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "frame.jpg");
    form.append("data", JSON.stringify({ color_fill: "0,0,0" }));
    const f = this.opts.fetch ?? fetch;
    const res = await f(`${this.opts.url!.replace(/\/+$/, "")}/redact`, {
      method: "POST",
      body: form,
      // OCR takes seconds; keyframes are off the latency path.
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8000),
    });
    if (!res.ok) throw new Error(`presidio image redactor: HTTP ${res.status}`);
    const out = Buffer.from(await res.arrayBuffer());
    // It must be an image back; anything else means the frame wasn't redacted.
    await sharp(out).metadata();
    return out;
  }
}

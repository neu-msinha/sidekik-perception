/**
 * Synthetic MiniERP-style screens for diff tests. Values are drawn as seven-segment digits from
 * rectangles, so rendering needs no fonts and is identical on every machine.
 */
import sharp from "sharp";

export const W = 1280;
export const H = 720;

/** Where the cost center value sits on the invoice screen (for crop assertions). */
export const COST_CENTER_BOX = { left: 420, top: 360, width: 200, height: 40 };

const SEGMENTS: Record<string, string> = {
  "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc",
  "5": "afgcd", "6": "afgedc", "7": "abc", "8": "abcdefg", "9": "abcdfg",
};

function digits(text: string, x: number, y: number, h = 24): string {
  const w = h * 0.55, t = 3;
  let out = "";
  [...text].forEach((ch, i) => {
    const ox = x + i * (w + 8);
    const seg = SEGMENTS[ch] ?? "";
    const r = (sx: number, sy: number, sw: number, sh: number) => `<rect x="${ox + sx}" y="${y + sy}" width="${sw}" height="${sh}" fill="#111"/>`;
    if (seg.includes("a")) out += r(0, 0, w, t);
    if (seg.includes("b")) out += r(w - t, 0, t, h / 2);
    if (seg.includes("c")) out += r(w - t, h / 2, t, h / 2);
    if (seg.includes("d")) out += r(0, h - t, w, t);
    if (seg.includes("e")) out += r(0, h / 2, t, h / 2);
    if (seg.includes("f")) out += r(0, 0, t, h / 2);
    if (seg.includes("g")) out += r(0, h / 2 - t / 2, w, t);
  });
  return out;
}

export type InvoiceScreen = { invoice: string; amount: string; costCenter: string; asset?: string };

function field(label: number, top: number, value: string): string {
  return (
    `<rect x="250" y="${top + 12}" width="${label}" height="12" fill="#999"/>` +
    `<rect x="${COST_CENTER_BOX.left}" y="${top}" width="${COST_CENTER_BOX.width}" height="${COST_CENTER_BOX.height}" fill="#fff" stroke="#888" stroke-width="2"/>` +
    digits(value, COST_CENTER_BOX.left + 10, top + 8)
  );
}

export function invoiceSvg(s: InvoiceScreen): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#f4f5f7"/>
  <rect width="${W}" height="56" fill="#1f3a5f"/>
  <rect x="24" y="18" width="140" height="20" fill="#fff"/>
  <rect y="56" width="210" height="${H - 56}" fill="#e3e7ed"/>
  ${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="24" y="${90 + i * 44}" width="${120 + (i % 3) * 20}" height="14" fill="#7a8699"/>`).join("")}
  <rect x="240" y="80" width="${W - 280}" height="${H - 120}" fill="#fff" stroke="#d0d4da"/>
  ${digits(s.invoice, 260, 100, 36)}
  ${field(120, 200, s.amount)}
  ${field(90, 280, s.invoice)}
  ${field(110, COST_CENTER_BOX.top, s.costCenter)}
  ${field(130, 440, s.asset ?? "")}
  <rect x="${W - 200}" y="${H - 90}" width="140" height="40" rx="4" fill="#2d7d46"/>
</svg>`;
}

/** A different screen entirely (a list view), for navigation. */
export function listSvg(): string {
  const rows = Array.from({ length: 12 }, (_, i) =>
    `<rect x="40" y="${120 + i * 46}" width="${W - 80}" height="40" fill="${i % 2 ? "#fff" : "#eef1f5"}"/>` + digits(String(4471 + i * 9), 60, 128 + i * 46, 22),
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#ffffff"/><rect width="${W}" height="90" fill="#5f1f3a"/>${rows}</svg>`;
}

export function jpeg(svg: string, quality = 70): Promise<Buffer> {
  return sharp(Buffer.from(svg)).jpeg({ quality }).toBuffer();
}

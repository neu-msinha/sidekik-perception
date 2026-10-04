/**
 * Turns on-screen strings into InvoiceState values (DESIGN §3): German and English amounts and dates.
 * Pure functions; `lang` is the session language ("de", "en-GB", …) and only breaks ties that the
 * string itself can't (is 03/12/2026 March or December?).
 */
import type { InvoiceState } from "@sidekik/contracts";
import type { VisionRecord } from "./vision/schema.js";

const isGerman = (lang: string) => lang.toLowerCase().startsWith("de");

const CURRENCY_SYMBOLS: [RegExp, string][] = [
  [/€/, "EUR"],
  [/\bK[čc]\b|Kč/i, "CZK"],
  [/£/, "GBP"],
  [/CHF/i, "CHF"],
  [/\$/, "USD"],
];

/** ISO currency from a code ("EUR", "eur") or a symbol in an amount ("6.350,00 €"). */
export function parseCurrency(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const code = raw.match(/\b([A-Z]{3})\b/i)?.[1]?.toUpperCase();
  if (code && /^(EUR|USD|GBP|CHF|CZK|PLN|SEK|DKK|NOK|HUF)$/.test(code)) return code;
  for (const [re, iso] of CURRENCY_SYMBOLS) if (re.test(raw)) return iso;
  return undefined;
}

/**
 * Amount in major units: "6.350,00" → 6350, "6,350.00" → 6350, "€6,350" → 6350, "1.980" → 1980,
 * "6 350,50 €" → 6350.5, "-1.234,56" → -1234.56. A single separator followed by exactly three
 * digits is a thousands separator in both languages; otherwise the last separator is the decimal point.
 */
export function parseAmount(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const negative = /^\s*[-−(]/.test(raw) || /-\s*$/.test(raw);
  // Keep digits and separators; spaces, NBSPs and apostrophes group thousands.
  const s = raw.replace(/[\s  '’]/g, "").replace(/[^\d.,]/g, "");
  if (!/\d/.test(s)) return undefined;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let intPart: string;
  let frac = "";
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = Math.max(lastDot, lastComma);
    intPart = s.slice(0, dec);
    frac = s.slice(dec + 1);
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const parts = s.split(sep);
    const tail = parts[parts.length - 1]!;
    if (parts.length > 2 || tail.length === 3) {
      intPart = parts.join("");
    } else {
      intPart = parts.slice(0, -1).join("");
      frac = tail;
    }
  } else {
    intPart = s;
  }
  const digits = intPart.replace(/[.,]/g, "") || "0";
  const value = Number(`${digits}.${frac.replace(/[.,]/g, "") || "0"}`);
  if (!Number.isFinite(value)) return undefined;
  const rounded = Math.round(value * 100) / 100;
  return negative ? -rounded : rounded;
}

const MONTHS: Record<string, number> = {
  jan: 1, januar: 1, january: 1, jän: 1, jänner: 1,
  feb: 2, februar: 2, february: 2,
  mär: 3, mar: 3, märz: 3, march: 3, maerz: 3,
  apr: 4, april: 4,
  mai: 5, may: 5,
  jun: 6, juni: 6, june: 6,
  jul: 7, juli: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  okt: 10, oct: 10, oktober: 10, october: 10,
  nov: 11, november: 11,
  dez: 12, dec: 12, dezember: 12, december: 12,
};

export type ParsedDate = { iso?: string; year?: number; month: number };

/**
 * "03.12.2026" → 2026-12-03 · "2026-12-03" · "12/2026" → month 12 · "3. Dezember 2026" · "Dec 3, 2026".
 * Slashed day/month order: a part over 12 decides; otherwise German reads day first, English month first.
 */
export function parseDate(raw: string | null | undefined, lang = "en"): ParsedDate | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase();
  let m: RegExpMatchArray | null;

  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return ymd(+m[1]!, +m[2]!, +m[3]!);
  if ((m = s.match(/^(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{2,4})$/))) return ymd(year(m[3]!), +m[2]!, +m[1]!);
  if ((m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/))) {
    const a = +m[1]!, b = +m[2]!;
    const dayFirst = a > 12 ? true : b > 12 ? false : isGerman(lang);
    return dayFirst ? ymd(year(m[3]!), b, a) : ymd(year(m[3]!), a, b);
  }
  if ((m = s.match(/^(\d{1,2})[/.-](\d{4})$/))) return month(+m[2]!, +m[1]!);
  if ((m = s.match(/^(\d{4})[/-](\d{1,2})$/))) return month(+m[1]!, +m[2]!);
  // Named months: "3. Dezember 2026", "3 Dec 2026", "December 3, 2026", "Dez 2026".
  if ((m = s.match(/^(\d{1,2})\.?\s+([a-zäöü]+)\.?\s+(\d{4})$/))) {
    const mon = MONTHS[m[2]!];
    if (mon) return ymd(+m[3]!, mon, +m[1]!);
  }
  if ((m = s.match(/^([a-zäöü]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/))) {
    const mon = MONTHS[m[1]!];
    if (mon) return ymd(+m[3]!, mon, +m[2]!);
  }
  if ((m = s.match(/^([a-zäöü]+)\.?\s+(\d{4})$/))) {
    const mon = MONTHS[m[1]!];
    if (mon) return month(+m[2]!, mon);
  }
  return undefined;
}

function year(y: string): number {
  const n = Number(y);
  return y.length === 2 ? 2000 + n : n;
}

function ymd(y: number, mo: number, d: number): ParsedDate | undefined {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (mo < 1 || mo > 12 || dt.getUTCDate() !== d || dt.getUTCMonth() !== mo - 1) return undefined;
  return { iso: dt.toISOString().slice(0, 10), year: y, month: mo };
}

function month(y: number, mo: number): ParsedDate | undefined {
  return mo >= 1 && mo <= 12 ? { year: y, month: mo } : undefined;
}

const trimmed = (v: string | null | undefined) => {
  const t = v?.replace(/\s+/g, " ").trim();
  return t ? t : undefined;
};
const compact = (v: string | null | undefined) => trimmed(v)?.replace(/\s+/g, "");

/** Canonical string for one field value, so DOM and vision readings of the same value compare equal. */
export function canonicalValue(field: string, raw: string | null | undefined, lang = "en"): string | undefined {
  switch (field) {
    case "net_amount": {
      const n = parseAmount(raw);
      return n === undefined ? trimmed(raw) : String(n);
    }
    case "invoice_date": {
      const d = parseDate(raw, lang);
      return d?.iso ?? (d ? `${d.year}-${String(d.month).padStart(2, "0")}` : trimmed(raw));
    }
    case "invoice_id":
      return compact(raw)?.replace(/^#/, "");
    case "cost_center":
    case "asset_number":
      return compact(raw);
    case "company_code":
    case "currency":
      return compact(raw)?.toUpperCase();
    case "category":
      return trimmed(raw)?.toLowerCase();
    default:
      return trimmed(raw);
  }
}

/** A vision `state.record` as InvoiceState. Fields that weren't visible are left out. */
export function normalizeRecord(r: VisionRecord, lang = "en"): InvoiceState {
  const out: InvoiceState = {};
  const set = <K extends keyof InvoiceState>(k: K, v: InvoiceState[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set("invoice_id", canonicalValue("invoice_id", r.invoice_id, lang));
  set("supplier", trimmed(r.supplier));
  set("net_amount", parseAmount(r.net_amount));
  set("currency", parseCurrency(r.currency) ?? parseCurrency(r.net_amount));
  const date = parseDate(r.invoice_date, lang);
  set("invoice_date", date?.iso);
  set("invoice_month", date?.month);
  set("company_code", canonicalValue("company_code", r.company_code, lang));
  set("category", canonicalValue("category", r.category, lang));
  set("cost_center", canonicalValue("cost_center", r.cost_center, lang));
  set("asset_number", canonicalValue("asset_number", r.asset_number, lang));
  return out;
}

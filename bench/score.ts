import type { VisionRecord } from "../src/vision/schema.js";

/** Fields the benchmark scores: the ones guardrails read and escalation watches. */
export const SCORED_FIELDS = ["invoice_id", "cost_center", "net_amount", "invoice_date", "company_code"] as const;
export type ScoredField = (typeof SCORED_FIELDS)[number];
export type Truth = Partial<Record<ScoredField, string>>;

/** Exact digits: "6.350,00", "€6,350.00" and "6350,00" all read as 635000; a dropped or swapped digit fails. */
export function digits(v: string | null | undefined): string {
  return (v ?? "").replace(/\D/g, "");
}

export type FieldScore = { field: ScoredField; expected: string; got: string | null; ok: boolean };

export function scoreRecord(truth: Truth, got: VisionRecord | null): FieldScore[] {
  return SCORED_FIELDS.filter((f) => truth[f] !== undefined).map((field) => {
    const expected = truth[field]!;
    const value = got?.[field] ?? null;
    return { field, expected, got: value, ok: digits(value) !== "" && digits(value) === digits(expected) };
  });
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

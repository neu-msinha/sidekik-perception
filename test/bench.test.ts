import { describe, expect, it } from "vitest";
import { digits, percentile, scoreRecord } from "../bench/score.js";

const record = { invoice_id: "4471", supplier: null, net_amount: "6.350,00 €", currency: "EUR", invoice_date: "14.09.2026", company_code: "DE01", category: null, cost_center: "0400", asset_number: null };

describe("bench scoring", () => {
  it("compares exact digits regardless of number format", () => {
    expect(digits("€6,350.00")).toBe(digits("6.350,00 €"));
    const s = scoreRecord({ invoice_id: "4471", net_amount: "6350.00", cost_center: "0400", company_code: "DE01", invoice_date: "14.09.2026" }, record);
    expect(s.every((x) => x.ok)).toBe(true);
  });

  it("fails a dropped digit or a missing value", () => {
    const s = scoreRecord({ cost_center: "4711", net_amount: "63500.00" }, record);
    expect(s.map((x) => x.ok)).toEqual([false, false]);
    expect(scoreRecord({ invoice_id: "4471" }, null)[0]?.ok).toBe(false);
  });

  it("computes percentiles", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { canonicalValue, normalizeRecord, parseAmount, parseCurrency, parseDate } from "../src/normalize.js";

describe("parseAmount", () => {
  it.each([
    ["6.350,00", 6350],
    ["6,350.00", 6350],
    ["€6,350", 6350],
    ["6.350,00 €", 6350],
    ["EUR 6,350.00", 6350],
    ["6350", 6350],
    ["6 350,50", 6350.5],
    ["6 350,50 €", 6350.5],
    ["1.980", 1980],
    ["1,980", 1980],
    ["240,00", 240],
    ["240.5", 240.5],
    ["7.200", 7200],
    ["1.234.567,89", 1234567.89],
    ["1,234,567.89", 1234567.89],
    ["12'500.00", 12500],
    ["-1.234,56", -1234.56],
    ["(1,234.56)", -1234.56],
    ["0,5", 0.5],
  ])("%s → %d", (raw, expected) => {
    expect(parseAmount(raw)).toBe(expected);
  });

  it("returns undefined without digits", () => {
    expect(parseAmount("")).toBeUndefined();
    expect(parseAmount("—")).toBeUndefined();
    expect(parseAmount(null)).toBeUndefined();
  });
});

describe("parseDate", () => {
  it.each([
    ["03.12.2026", "de", "2026-12-03", 12],
    ["03.12.2026", "en", "2026-12-03", 12],
    ["3.12.26", "de", "2026-12-03", 12],
    ["2026-12-03", "en", "2026-12-03", 12],
    ["12/03/2026", "en", "2026-12-03", 12],
    ["03/12/2026", "de", "2026-12-03", 12],
    ["25/12/2026", "en", "2026-12-25", 12],
    ["12/25/2026", "de", "2026-12-25", 12],
    ["3. Dezember 2026", "de", "2026-12-03", 12],
    ["3 Dec 2026", "en", "2026-12-03", 12],
    ["December 3, 2026", "en", "2026-12-03", 12],
    ["14. März 2026", "de", "2026-03-14", 3],
  ])("%s (%s) → %s", (raw, lang, iso, month) => {
    expect(parseDate(raw, lang)).toMatchObject({ iso, month });
  });

  it.each([
    ["12/2026", 12],
    ["12.2026", 12],
    ["2026-12", 12],
    ["Dez 2026", 12],
    ["September 2026", 9],
  ])("month only: %s → %d", (raw, month) => {
    const d = parseDate(raw, "de");
    expect(d).toEqual({ year: 2026, month });
  });

  it("rejects impossible dates", () => {
    expect(parseDate("31.02.2026", "de")).toBeUndefined();
    expect(parseDate("13/2026")).toBeUndefined();
    expect(parseDate("soon")).toBeUndefined();
  });
});

describe("parseCurrency", () => {
  it.each([
    ["EUR", "EUR"],
    ["eur", "EUR"],
    ["6.350,00 €", "EUR"],
    ["$1,200.00", "USD"],
    ["3 400 Kč", "CZK"],
    ["CZK 3400", "CZK"],
  ])("%s → %s", (raw, iso) => {
    expect(parseCurrency(raw)).toBe(iso);
  });
});

describe("normalizeRecord", () => {
  it("turns a German MiniERP reading into InvoiceState", () => {
    expect(
      normalizeRecord(
        {
          invoice_id: "#4471",
          supplier: " Präzisionswerk  Ulm ",
          net_amount: "6.350,00 €",
          currency: null,
          invoice_date: "14.09.2026",
          company_code: "de01",
          category: "Equipment",
          cost_center: "04 00",
          asset_number: null,
        },
        "de",
      ),
    ).toEqual({
      invoice_id: "4471",
      supplier: "Präzisionswerk Ulm",
      net_amount: 6350,
      currency: "EUR",
      invoice_date: "2026-09-14",
      invoice_month: 9,
      company_code: "DE01",
      category: "equipment",
      cost_center: "0400",
    });
  });

  it("keeps leading zeros in cost centers and leaves out what wasn't visible", () => {
    const empty = { invoice_id: null, supplier: null, net_amount: null, currency: null, invoice_date: null, company_code: null, category: null, cost_center: "0400", asset_number: null };
    expect(normalizeRecord(empty)).toEqual({ cost_center: "0400" });
  });

  it("gives DOM and vision readings of one value the same canonical form", () => {
    expect(canonicalValue("net_amount", "6.350,00 €", "de")).toBe(canonicalValue("net_amount", "6350", "de"));
    expect(canonicalValue("invoice_date", "14.09.2026", "de")).toBe("2026-09-14");
    expect(canonicalValue("invoice_date", "12/2026", "de")).toBe("2026-12");
    expect(canonicalValue("company_code", "cz01")).toBe("CZ01");
    expect(canonicalValue("comment", "  a  b ")).toBe("a b");
  });
});

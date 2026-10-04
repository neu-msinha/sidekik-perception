import { afterEach, describe, expect, it, vi } from "vitest";
import { clock, CtxBatcher, formatCtx, CTX_MAX_CHARS } from "../src/ctx.js";
import type { TrackedEvent } from "../src/state.js";

const state = { app: "MiniERP", record: { invoice_id: "4471", supplier: "Präzisionswerk Ulm", net_amount: 6350, currency: "EUR", cost_center: "0400" }, focused_field: "asset_number" };
const change = (field: string, before: string, after: string, t_ms = 192_000, id = "4471"): TrackedEvent => ({
  type: "field_changed",
  t_ms,
  entity: { kind: "invoice", id },
  field,
  before,
  after,
  confidence: 1,
  source: "dom",
  state,
});

describe("formatCtx", () => {
  it("matches the DESIGN example", () => {
    expect(formatCtx(192_000, [change("cost_center", "4711", "0400")], state)).toBe(
      "03:12 invoice 4471 | cost_center 4711→0400 | net €6,350 | supplier Präzisionswerk Ulm | focus: asset_number",
    );
  });

  it("keeps the first before and the last after per field", () => {
    const line = formatCtx(1000, [change("cost_center", "4711", "04"), change("cost_center", "04", "0400")], state);
    expect(line).toContain("cost_center 4711→0400");
  });

  it("names non-record fields without their values and drops changes to other records", () => {
    const line = formatCtx(1000, [change("approver", "", "M. Novák"), change("cost_center", "1", "2", 500, "4480")], state);
    expect(line).toContain("approver changed");
    expect(line).not.toContain("Novák");
    expect(line).not.toContain("1→2");
  });

  it("stays within 400 characters", () => {
    const many = Array.from({ length: 60 }, (_, i) => change("cost_center", String(i), String(i + 1)));
    const fields = Array.from({ length: 40 }, (_, i) => change(`field_${i}_with_a_long_name`, "a", "b"));
    expect(formatCtx(1000, [...many, ...fields], state).length).toBeLessThanOrEqual(CTX_MAX_CHARS);
  });

  it("formats session time as mm:ss", () => {
    expect(clock(0)).toBe("00:00");
    expect(clock(192_999)).toBe("03:12");
    expect(clock(3_725_000)).toBe("62:05");
  });
});

describe("CtxBatcher", () => {
  afterEach(() => vi.useRealTimers());

  it("sends the first change at once, then at most one line every 5 s", async () => {
    vi.useFakeTimers();
    const sent: [string, number][] = [];
    const b = new CtxBatcher(async (text, t) => void sent.push([text, t]), () => Date.now());
    b.add([change("cost_center", "4711", "0400", 1000)]);
    expect(sent).toHaveLength(1);
    b.add([change("asset_number", "", "A-1", 2000)]);
    b.add([change("category", "parts", "equipment", 3000)]);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.[0]).toMatch(/asset_number →A-1 \| category parts→equipment/);
    expect(sent[1]?.[1]).toBe(3000);
  });

  it("ignores typing, and clear() drops the batch", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const b = new CtxBatcher(async (text) => void sent.push(text), () => Date.now());
    b.add([{ ...change("cost_center", "04", "0400"), type: "typing_in_progress" }]);
    expect(sent).toHaveLength(0);
    b.add([change("cost_center", "4711", "0400")]);
    b.add([change("asset_number", "", "A-1")]);
    b.clear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(1);
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { ScreenTracker, SETTLE_MS, type TrackedEvent } from "../src/state.js";
import { prepareImage, type VisionImage } from "../src/vision/image.js";
import type { VisionEvent, VisionOutput, VisionRecord } from "../src/vision/schema.js";
import { invoiceSvg, jpeg } from "./fixtures/screens.js";

let image: VisionImage;
beforeAll(async () => {
  image = await prepareImage(await jpeg(invoiceSvg({ invoice: "4471", amount: "6350", costCenter: "4711" })), { width: 1280, height: 720 });
});

const EMPTY: VisionRecord = { invoice_id: null, supplier: null, net_amount: null, currency: null, invoice_date: null, company_code: null, category: null, cost_center: null, asset_number: null };
const INVOICE_4471: Partial<VisionRecord> = { invoice_id: "4471", supplier: "Präzisionswerk Ulm", net_amount: "6.350,00 €", invoice_date: "14.09.2026", company_code: "DE01", category: "equipment", cost_center: "4711" };

function vo(record: Partial<VisionRecord>, opts: { focus?: string | null; app?: string; screen?: string; events?: VisionEvent[]; text?: string } = {}): VisionOutput {
  return {
    events: opts.events ?? [],
    state: { app: opts.app ?? "MiniERP", screen: opts.screen ?? "invoice", record: { ...EMPTY, ...record }, focused_field: opts.focus === undefined ? null : opts.focus },
    untrusted_screen_text: opts.text ?? "",
  };
}

const ctx = (t_ms: number, reason: "tick" | "blur" | "save" | "nav" = "tick") => ({ t_ms, reason, image, lang: "de" });
const types = (evs: TrackedEvent[]) => evs.map((e) => e.type);
const changes = (evs: TrackedEvent[]) => evs.filter((e) => e.type === "field_changed").map((e) => [e.field, e.before, e.after, e.source]);

const domOpen = { kind: "record_open" as const, record: { kind: "invoice", id: "4471" }, state: { invoice_id: "4471", supplier: "Präzisionswerk Ulm", supplier_known: true, net_amount: 6350, currency: "EUR", category: "equipment", company_code: "DE01", cost_center: "4711", approvals_count: 1 } };

describe("ScreenTracker: DOM path (Checkpoint 1)", () => {
  it("opening 4471 and recoding 4711→0400 gives exactly one field_changed, even with vision watching", () => {
    const tr = new ScreenTracker("de");
    const all: TrackedEvent[] = [];
    all.push(...tr.applyDom(domOpen, 800));
    all.push(...tr.applyVision(vo(INVOICE_4471, { focus: null }), ctx(1000, "nav")));
    all.push(...tr.applyDom({ kind: "field_focus", record: { kind: "invoice", id: "4471" }, field: "cost_center" }, 5900));
    all.push(...tr.applyVision(vo({ ...INVOICE_4471, cost_center: "04" }, { focus: "cost_center" }), ctx(6500)));
    all.push(...tr.applyVision(vo({ ...INVOICE_4471, cost_center: "0400" }, { focus: "cost_center" }), ctx(7000)));
    all.push(...tr.applyDom({ kind: "field_change", record: { kind: "invoice", id: "4471" }, field: "cost_center", before: "4711", after: "0400" }, 7200));
    all.push(...tr.tick(9000));
    all.push(...tr.applyVision(vo({ ...INVOICE_4471, cost_center: "0400" }, { focus: "asset_number" }), ctx(9500)));
    all.push(...tr.tick(12_000));

    expect(types(all).filter((t) => t === "record_opened")).toHaveLength(1);
    expect(changes(all)).toEqual([["cost_center", "4711", "0400", "dom"]]);
    const fc = all.find((e) => e.type === "field_changed")!;
    expect(fc.entity).toEqual({ kind: "invoice", id: "4471" });
    expect(fc.state.record?.cost_center).toBe("0400");
    expect(fc.t_ms).toBe(7200);
  });

  it("reports the DOM record with supplier_known and approvals_count", () => {
    const tr = new ScreenTracker("de");
    const [ev] = tr.applyDom(domOpen, 800);
    expect(ev).toMatchObject({ type: "record_opened", source: "dom", confidence: 1, after: "4471", entity: { kind: "invoice", id: "4471" } });
    expect(ev?.state.record).toMatchObject({ supplier_known: true, approvals_count: 1, net_amount: 6350 });
  });

  it("lets DOM values win over vision for 10 s, then trusts vision again", () => {
    const tr = new ScreenTracker("de");
    tr.applyDom(domOpen, 0);
    tr.applyDom({ kind: "field_change", field: "cost_center", before: "4711", after: "0400" }, 1000);
    expect(changes(tr.applyVision(vo({ ...INVOICE_4471, cost_center: "4711" }), ctx(5000)))).toEqual([]);
    expect(tr.current.record?.cost_center).toBe("0400");
    expect(changes(tr.applyVision(vo({ ...INVOICE_4471, cost_center: "4711" }), ctx(11_500)))).toEqual([["cost_center", "0400", "4711", "vision"]]);
  });

  it("doesn't report a DOM value vision already reported", () => {
    const tr = new ScreenTracker("de");
    tr.applyVision(vo(INVOICE_4471), ctx(0, "nav"));
    const v = tr.applyVision(vo({ ...INVOICE_4471, category: "parts" }), ctx(1000));
    expect(changes(v)).toEqual([["category", "equipment", "parts", "vision"]]);
    expect(tr.applyDom({ kind: "field_change", field: "category", before: "equipment", after: "parts" }, 1200)).toEqual([]);
  });

  it("compares amounts and dates in canonical form", () => {
    const tr = new ScreenTracker("de");
    tr.applyDom(domOpen, 0);
    expect(types(tr.applyVision(vo({ ...INVOICE_4471, net_amount: "6.350,00 €" }), ctx(12_000)))).toEqual(["app_opened"]);
    const dated = tr.applyVision(vo({ ...INVOICE_4471, invoice_date: "03.12.2026" }), ctx(13_000));
    expect(changes(dated)).toEqual([["invoice_date", "2026-09-14", "2026-12-03", "vision"]]);
    expect(tr.current.record?.invoice_month).toBe(12);
  });

  it("save_attempt commits held edits and reports the click", () => {
    const tr = new ScreenTracker("de");
    tr.applyVision(vo(INVOICE_4471, { focus: "asset_number" }), ctx(0, "nav"));
    tr.applyVision(vo({ ...INVOICE_4471, asset_number: "A-2026-117" }, { focus: "asset_number" }), ctx(500));
    const evs = tr.applyDom({ kind: "save_attempt", record: { kind: "invoice", id: "4471" } }, 700);
    expect(types(evs)).toEqual(["field_changed", "button_clicked"]);
    expect(evs[1]).toMatchObject({ field: "save", source: "dom" });
  });
});

describe("ScreenTracker: vision only (meetings)", () => {
  it("fills in fields seen for the first time without reporting a change", () => {
    const tr = new ScreenTracker("de");
    tr.applyDom(domOpen, 0);
    const evs = tr.applyVision(vo(INVOICE_4471), ctx(12_000));
    expect(changes(evs)).toEqual([]);
    expect(tr.current.record).toMatchObject({ invoice_date: "2026-09-14", invoice_month: 9 });
  });

  it("opens the record from vision once", () => {
    const tr = new ScreenTracker("de");
    const evs = tr.applyVision(vo(INVOICE_4471), ctx(0, "nav"));
    expect(types(evs)).toEqual(["app_opened", "record_opened"]);
    expect(evs[1]?.state.record).toMatchObject({ invoice_id: "4471", net_amount: 6350, invoice_month: 9, currency: "EUR" });
    expect(tr.applyVision(vo(INVOICE_4471), ctx(500))).toEqual([]);
  });

  it("holds typing in the focused field, emits typing_in_progress, then one field_changed once it settles", () => {
    const tr = new ScreenTracker("de");
    tr.applyVision(vo(INVOICE_4471, { focus: "cost_center" }), ctx(0, "nav"));
    const bbox = [10, 20, 100, 30];
    const field = (after: string): VisionEvent => ({ type: "field_changed", entity: null, field: "cost_center", before: null, after, ui_label: "Kostenstelle", bbox, confidence: 0.92 });
    expect(tr.applyVision(vo({ ...INVOICE_4471, cost_center: "04" }, { focus: "cost_center", events: [field("04")] }), ctx(1000))).toEqual([]);
    const typing = tr.applyVision(vo({ ...INVOICE_4471, cost_center: "0400" }, { focus: "cost_center", events: [field("0400")] }), ctx(1500));
    expect(typing.map((e) => [e.type, e.before, e.after])).toEqual([["typing_in_progress", "04", "0400"]]);
    expect(tr.tick(1500 + SETTLE_MS - 1)).toEqual([]);
    const settled = tr.tick(1500 + SETTLE_MS);
    expect(changes(settled)).toEqual([["cost_center", "4711", "0400", "vision"]]);
    expect(settled[0]).toMatchObject({ t_ms: 1500, confidence: 0.92, bbox: { left: 10, top: 20, width: 100, height: 30 } });
    expect(tr.tick(5000)).toEqual([]);
  });

  it("commits at once when the changed field isn't focused", () => {
    const tr = new ScreenTracker("de");
    tr.applyVision(vo(INVOICE_4471), ctx(0, "nav"));
    expect(changes(tr.applyVision(vo({ ...INVOICE_4471, category: "parts" }), ctx(1000)))).toEqual([["category", "equipment", "parts", "vision"]]);
  });

  it("commits a held edit when focus moves or a blur frame arrives", () => {
    const tr = new ScreenTracker("de");
    tr.applyVision(vo(INVOICE_4471, { focus: "cost_center" }), ctx(0, "nav"));
    tr.applyVision(vo({ ...INVOICE_4471, cost_center: "0400" }, { focus: "cost_center" }), ctx(1000));
    expect(changes(tr.applyVision(vo({ ...INVOICE_4471, cost_center: "0400" }, { focus: "asset_number" }), ctx(1200)))).toEqual([["cost_center", "4711", "0400", "vision"]]);

    tr.applyVision(vo({ ...INVOICE_4471, cost_center: "0400", asset_number: "A-1" }, { focus: "asset_number" }), ctx(2000));
    expect(changes(tr.applyVision(vo({ ...INVOICE_4471, cost_center: "0400", asset_number: "A-1" }, { focus: "asset_number" }), ctx(2100, "blur")))).toEqual([
      ["asset_number", undefined, "A-1", "vision"],
    ]);
  });

  it("reports nothing when typing ends where it started", () => {
    const tr = new ScreenTracker("de");
    tr.applyVision(vo(INVOICE_4471, { focus: "cost_center" }), ctx(0, "nav"));
    tr.applyVision(vo({ ...INVOICE_4471, cost_center: "47" }, { focus: "cost_center" }), ctx(500));
    tr.applyVision(vo({ ...INVOICE_4471, cost_center: "4711" }, { focus: "cost_center" }), ctx(1000));
    expect(changes(tr.tick(3000))).toEqual([]);
  });

  it("reports a new record and a new screen", () => {
    const tr = new ScreenTracker("de");
    tr.applyVision(vo(INVOICE_4471), ctx(0, "nav"));
    const evs = tr.applyVision(vo({ invoice_id: "4480", supplier: "Kranbau GmbH", invoice_date: "03.12.2026" }, { screen: "invoice_detail" }), ctx(4000, "nav"));
    expect(evs.map((e) => [e.type, e.before, e.after])).toEqual([
      ["navigation", "invoice", "invoice_detail"],
      ["record_opened", "4471", "4480"],
    ]);
    expect(tr.current.record).toMatchObject({ invoice_id: "4480", invoice_month: 12 });
    expect(tr.current.record?.cost_center).toBeUndefined();
  });

  it("passes buttons, dialogs and fields outside the record through, with the screen text", () => {
    const tr = new ScreenTracker("de");
    tr.applyVision(vo(INVOICE_4471), ctx(0, "nav"));
    const evs = tr.applyVision(
      vo(INVOICE_4471, {
        text: "Freigabe erforderlich",
        events: [
          { type: "dialog", entity: null, field: null, before: null, after: null, ui_label: "Freigabe erforderlich", bbox: null, confidence: 0.9 },
          { type: "field_changed", entity: null, field: "comment", before: "", after: "Anlage", ui_label: "Kommentar", bbox: null, confidence: 0.8 },
        ],
      }),
      ctx(1000),
    );
    expect(evs.map((e) => [e.type, e.field, e.after])).toEqual([
      ["dialog", "Freigabe erforderlich", "Freigabe erforderlich"],
      ["field_changed", "comment", "Anlage"],
    ]);
    expect(evs.every((e) => e.untrusted_screen_text === "Freigabe erforderlich")).toBe(true);
    // The same value again is not a change.
    expect(types(tr.applyVision(vo(INVOICE_4471, { events: [{ type: "field_changed", entity: null, field: "comment", before: "", after: "Anlage", ui_label: null, bbox: null, confidence: 0.8 }] }), ctx(2000)))).toEqual([]);
  });

  it("gives vision the merged state, DOM values included, as PREVIOUS_STATE", () => {
    const tr = new ScreenTracker("de");
    tr.applyDom(domOpen, 0);
    tr.applyDom({ kind: "field_focus", field: "cost_center" }, 100);
    expect(tr.previousForVision()).toMatchObject({ record: { invoice_id: "4471", net_amount: "6350", cost_center: "4711", asset_number: null }, focused_field: "cost_center" });
  });
});

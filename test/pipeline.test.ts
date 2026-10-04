import { beforeAll, describe, expect, it } from "vitest";
import { wireConsumers } from "../src/consumers.js";
import type { IncomingFrame } from "../src/frames/routes.js";
import { PipelineManager } from "../src/pipeline.js";
import { Publisher } from "../src/publisher.js";
import { SessionRegistry } from "../src/sessions.js";
import { MemoryStore } from "../src/store.js";
import { EMPTY_VISION_STATE, type VisionOutput, type VisionRecord } from "../src/vision/schema.js";
import { VisionError, type Vision, type VisionRequest, type VisionResult } from "../src/vision/vision.js";
import { invoiceSvg, jpeg, listSvg } from "./fixtures/screens.js";
import { ev, FakeBus, lifecycle, ORG, SID, silentLogger, started } from "./helpers.js";

const R: VisionRecord = { invoice_id: "4471", supplier: "Präzisionswerk Ulm", net_amount: "6.350,00 €", currency: null, invoice_date: null, company_code: "DE01", category: "equipment", cost_center: "4711", asset_number: null };
const out = (record: Partial<VisionRecord>, focus: string | null = null): VisionOutput => ({
  events: [],
  state: { ...EMPTY_VISION_STATE, app: "MiniERP", screen: "invoice", record: { ...R, ...record }, focused_field: focus },
  untrusted_screen_text: "",
});

/** Answers vision calls from a script, optionally slowly, and records what it was asked. */
class ScriptVision implements Vision {
  readonly requests: VisionRequest[] = [];
  inFlight = 0;
  maxInFlight = 0;
  constructor(
    private readonly script: (VisionOutput | "fail")[],
    private readonly delayMs = 0,
  ) {}
  async see(req: VisionRequest): Promise<VisionResult> {
    this.requests.push(req);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((r) => setTimeout(r, this.delayMs));
    this.inFlight--;
    const next = this.script.shift() ?? out({});
    const calls = [{ model: "claude-haiku-4-5-20251001", usage: { input_tokens: 1000, output_tokens: 100 }, latency_ms: this.delayMs, ok: next !== "fail" }];
    if (next === "fail") throw new VisionError("timeout", calls);
    return { output: next, model: "claude-haiku-4-5-20251001", escalated: false, calls, latency_ms: this.delayMs };
  }
}

const screens: Record<string, Buffer> = {};
beforeAll(async () => {
  screens.cc4711 = await jpeg(invoiceSvg({ invoice: "4471", amount: "6350", costCenter: "4711" }));
  screens.cc4711b = await jpeg(invoiceSvg({ invoice: "4471", amount: "6350", costCenter: "4711" }), 60);
  screens.cc04 = await jpeg(invoiceSvg({ invoice: "4471", amount: "6350", costCenter: "04" }));
  screens.cc0400 = await jpeg(invoiceSvg({ invoice: "4471", amount: "6350", costCenter: "0400" }));
  screens.list = await jpeg(listSvg());
});

function setup(vision: Vision) {
  const bus = new FakeBus();
  const store = new MemoryStore();
  const sessions = new SessionRegistry();
  const log = silentLogger();
  const redactor = { redact: async (image: Buffer) => ({ image, presidio: true }) };
  const pipelines = new PipelineManager({ vision, publisher: new Publisher({ bus, store, log }), log, ctxEveryMs: 300, keyframes: { store, redactor, log } });
  wireConsumers(bus, sessions, log, {
    onDom: (s, e) => pipelines.onDom(s, e),
    onOffRecord: async (s, on) => pipelines.onOffRecord(s, on),
    onEnded: (s) => pipelines.onEnded(s),
    onAsk: async (s, e) => pipelines.onAsk(s, e.t_ms),
  });
  const frame = (t_ms: number, jpegBytes: Buffer, reason: IncomingFrame["reason"] = "tick"): IncomingFrame => ({ t_ms, reason, jpeg: jpegBytes, source: "browser", received_ms: Date.now() });
  const send = async (f: IncomingFrame) => {
    const s = sessions.get(SID) ?? sessions.ensure({ session_id: SID, org_id: ORG })!;
    pipelines.onFrame(s, f);
    await pipelines.peek(SID)!.idle();
  };
  return { bus, store, sessions, pipelines, frame, send };
}

const changed = (bus: FakeBus) => bus.of("sk:screen.events").filter((e) => e.data.type === "field_changed");

describe("pipeline: Checkpoint 1", () => {
  it("4711→0400 in the MiniERP: exactly one field_changed within 2.5 s, a matching ctx, a row per event", async () => {
    const vision = new ScriptVision([out({}), out({ cost_center: "04" }, "cost_center"), out({ cost_center: "0400" }, "cost_center")], 150);
    const { bus, store, frame, send, pipelines } = setup(vision);
    await bus.deliver("sk:session.lifecycle", started());
    await bus.deliver("sk:dom.events", ev("sk:dom.events", 800, { kind: "record_open", record: { kind: "invoice", id: "4471" }, state: { invoice_id: "4471", supplier: "Präzisionswerk Ulm", net_amount: 6350, currency: "EUR", category: "equipment", company_code: "DE01", cost_center: "4711", approvals_count: 1 } }));
    await send(frame(1000, screens.cc4711!, "nav"));
    await bus.deliver("sk:dom.events", ev("sk:dom.events", 5900, { kind: "field_focus", record: { kind: "invoice", id: "4471" }, field: "cost_center" }));
    await send(frame(6500, screens.cc04!));
    await send(frame(7000, screens.cc0400!));

    const domAt = Date.now();
    await bus.deliver("sk:dom.events", ev("sk:dom.events", 7200, { kind: "field_change", record: { kind: "invoice", id: "4471" }, field: "cost_center", before: "4711", after: "0400" }));
    const fc = changed(bus);
    expect(fc).toHaveLength(1);
    expect(Date.now() - domAt).toBeLessThan(2500);
    expect(fc[0]?.data).toMatchObject({ field: "cost_center", before: "4711", after: "0400", source: "dom", entity: { kind: "invoice", id: "4471" } });

    // Settling and later frames add nothing.
    await pipelines.peek(SID)!.tick();
    await send(frame(9000, screens.cc0400!, "blur"));
    expect(changed(bus)).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 400));
    const ctx = bus.of("sk:agent.commands").map((e) => (e.data.type === "ctx" ? e.data.text : ""));
    expect(ctx.some((t) => t.includes("cost_center 4711→0400"))).toBe(true);
    expect(store.screenEvents.map((r) => r.event_id).sort()).toEqual(bus.of("sk:screen.events").map((e) => e.id).sort());
    expect(bus.of("sk:usage").length).toBeGreaterThan(0);
  });
});

describe("pipeline: frames", () => {
  it("drops unchanged frames and sends a crop for a small change", async () => {
    const vision = new ScriptVision([out({}), out({ cost_center: "0400" })]);
    const { frame, send } = setup(vision);
    await send(frame(0, screens.cc4711!, "nav"));
    await send(frame(1000, screens.cc4711b!));
    expect(vision.requests).toHaveLength(1);
    await send(frame(2000, screens.cc0400!));
    expect(vision.requests).toHaveLength(2);
    const crop = vision.requests[1]!.image;
    expect(crop.width).toBeLessThan(400);
    expect(crop.region.left).toBeGreaterThan(0);
    expect(vision.requests[1]!.previous.record?.invoice_id).toBe("4471");
  });

  it("keeps at most 2 vision calls in flight and only the latest waiting frame", async () => {
    const vision = new ScriptVision([], 80);
    const { frame, sessions, pipelines } = setup(vision);
    const s = sessions.ensure({ session_id: SID, org_id: ORG })!;
    const shots = [screens.cc4711!, screens.list!, screens.cc04!, screens.list!, screens.cc0400!, screens.list!];
    for (const [i, img] of shots.entries()) {
      pipelines.onFrame(s, frame(i * 500, img, "nav"));
      await new Promise((r) => setTimeout(r, 15));
    }
    await pipelines.peek(SID)!.idle();
    expect(vision.maxInFlight).toBeLessThanOrEqual(2);
    expect(vision.requests.length).toBeLessThan(shots.length);
    expect(pipelines.peek(SID)!.stats.dropped_busy).toBeGreaterThan(0);
  });

  it("compares with the last frame vision saw when a call fails, so the change isn't lost", async () => {
    const vision = new ScriptVision([out({}), "fail", out({ cost_center: "0400" })]);
    const { frame, send, bus } = setup(vision);
    await send(frame(0, screens.cc4711!, "nav"));
    await send(frame(1000, screens.cc0400!));
    await send(frame(2000, screens.cc0400!));
    expect(vision.requests).toHaveLength(3);
    expect(changed(bus).map((e) => e.data.after)).toEqual(["0400"]);
    // The failed call's tokens are still reported.
    expect(bus.of("sk:usage").length).toBe(6);
  });
});

describe("pipeline: off the record (ticket 9)", () => {
  it("processes no frame, keeps no frame and publishes nothing while off the record", async () => {
    const vision = new ScriptVision([out({}), out({ cost_center: "0400" })]);
    const { bus, store, frame, send, pipelines, sessions } = setup(vision);
    await bus.deliver("sk:session.lifecycle", started());
    await send(frame(1000, screens.cc4711!, "nav"));
    const p = pipelines.peek(SID)!;
    expect(p.keyframer!.ring.size).toBe(1);
    const before = { calls: vision.requests.length, events: bus.of("sk:screen.events").length, keyframes: store.keyframes.length };

    await bus.deliver("sk:session.lifecycle", lifecycle("offrecord_on", 2000));
    expect(p.keyframer!.ring.size).toBe(0);
    pipelines.onFrame(sessions.get(SID)!, frame(3000, screens.list!, "nav"));
    pipelines.onFrame(sessions.get(SID)!, frame(4000, screens.cc0400!));
    await bus.deliver("sk:dom.events", ev("sk:dom.events", 4500, { kind: "field_change", field: "cost_center", before: "4711", after: "0400" }));
    await bus.deliver("sk:agent.commands", ev("sk:agent.commands", 4600, { type: "ask", question_id: "q", text: "Warum?", qtype: "why" }, SID, "brain"));
    await p.idle();
    expect(vision.requests.length).toBe(before.calls);
    expect(p.stats.frames).toBe(1);
    expect(p.keyframer!.ring.size).toBe(0);
    expect(bus.of("sk:screen.events")).toHaveLength(before.events);
    expect(store.keyframes).toHaveLength(before.keyframes);

    await bus.deliver("sk:session.lifecycle", lifecycle("offrecord_off", 5000));
    await send(frame(6000, screens.cc0400!));
    expect(vision.requests.length).toBe(before.calls + 1);
    expect(changed(bus).map((e) => e.data.after)).toEqual(["0400"]);
  });

  it("throws away a vision result that comes back after off-record started", async () => {
    const vision = new ScriptVision([out({ cost_center: "0400" })], 100);
    const { bus, store, frame, pipelines, sessions } = setup(vision);
    await bus.deliver("sk:session.lifecycle", started());
    // A tick frame: no keyframe of its own, so only the vision result could produce output.
    pipelines.onFrame(sessions.get(SID)!, frame(1000, screens.cc0400!));
    await new Promise((r) => setTimeout(r, 50));
    await bus.deliver("sk:session.lifecycle", lifecycle("offrecord_on", 1100));
    await pipelines.peek(SID)!.idle();
    expect(vision.requests).toHaveLength(1);
    expect(bus.of("sk:screen.events")).toHaveLength(0);
    expect(store.keyframes).toHaveLength(0);
    // The call was still billed.
    expect(bus.of("sk:usage")).toHaveLength(2);
  });

  it("keeps keyframes around an ask and frees everything at the end", async () => {
    const vision = new ScriptVision([], 0);
    const { bus, store, frame, send, pipelines } = setup(vision);
    await bus.deliver("sk:session.lifecycle", started());
    await send(frame(1000, screens.cc4711!, "nav"));
    await send(frame(2000, screens.cc4711b!));
    await bus.deliver("sk:agent.commands", ev("sk:agent.commands", 2500, { type: "ask", question_id: "q", text: "Warum?", qtype: "why" }, SID, "brain"));
    await send(frame(3500, screens.cc4711!));
    await pipelines.peek(SID)!.idle();
    expect(store.keyframes.map((k) => k.t_ms).sort((a, b) => a - b)).toEqual([1000, 2000, 3500]);
    await bus.deliver("sk:session.lifecycle", lifecycle("ended", 4000));
    expect(pipelines.peek(SID)).toBeUndefined();
  });
});

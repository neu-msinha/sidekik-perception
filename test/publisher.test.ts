import { afterEach, describe, expect, it, vi } from "vitest";
import { Publisher } from "../src/publisher.js";
import type { Session } from "../src/sessions.js";
import type { TrackedEvent } from "../src/state.js";
import { MemoryStore } from "../src/store.js";
import { FakeBus, ORG, SID, silentLogger } from "./helpers.js";

const session: Session = { session_id: SID, org_id: ORG, kind: "capture", mode: "browser", phase: "capture", language: "de", offRecord: false };
const tracked: TrackedEvent = {
  type: "field_changed",
  t_ms: 7200,
  entity: { kind: "invoice", id: "4471" },
  field: "cost_center",
  before: "4711",
  after: "0400",
  confidence: 0.9,
  source: "vision",
  bbox: { left: 470, top: 486, width: 360, height: 36 },
  untrusted_screen_text: "Kostenstelle 0400, Ansprechpartner Hans Müller",
  state: { record: { invoice_id: "4471", supplier: "Präzisionswerk Ulm", cost_center: "0400" } },
};

afterEach(() => vi.unstubAllGlobals());

describe("Publisher", () => {
  it("persists a row and publishes an envelope whose id is the event_id", async () => {
    const bus = new FakeBus();
    const store = new MemoryStore();
    const [p] = await new Publisher({ bus, store, log: silentLogger() }).screenEvents(session, [tracked]);
    const [env] = bus.of("sk:screen.events");
    expect(env?.id).toBe(p?.event.event_id);
    expect(env).toMatchObject({ producer: "perception", type: "screen.event", t_ms: 7200, org_id: ORG, session_id: SID });
    expect(env?.data).toMatchObject({ type: "field_changed", field: "cost_center", before: "4711", after: "0400", source: "vision" });
    expect(store.screenEvents[0]).toMatchObject({
      event_id: env?.id,
      entity_kind: "invoice",
      entity_id: "4471",
      before_val: "4711",
      after_val: "0400",
      bbox: tracked.bbox,
      source: "vision",
    });
  });

  it("drops screen text when Presidio isn't configured (fails closed)", async () => {
    const bus = new FakeBus();
    await new Publisher({ bus, store: new MemoryStore(), log: silentLogger() }).screenEvents(session, [tracked]);
    expect(bus.of("sk:screen.events")[0]?.data.untrusted_screen_text).toBeUndefined();
  });

  it("redacts screen text through Presidio, keeping the supplier", async () => {
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      if (url.endsWith("/analyze")) return Response.json([{ entity_type: "PERSON", start: 35, end: 46, score: 0.9 }]);
      return Response.json({ text: "Kostenstelle 0400, Ansprechpartner <PERSON>" });
    });
    const bus = new FakeBus();
    const pub = new Publisher({ bus, store: new MemoryStore(), log: silentLogger(), presidio: { analyzerUrl: "http://a", anonymizerUrl: "http://b" } });
    await pub.screenEvents(session, [tracked, tracked]);
    expect(bus.of("sk:screen.events").map((e) => e.data.untrusted_screen_text)).toEqual([
      "Kostenstelle 0400, Ansprechpartner <PERSON>",
      "Kostenstelle 0400, Ansprechpartner <PERSON>",
    ]);
    // Same text twice: one round trip.
    expect(calls.filter((c) => c.url.endsWith("/analyze"))).toHaveLength(1);
    expect(calls[0]?.body.language).toBe("de");
    expect(calls[0]?.body.allow_list.some((p: string) => p.includes("Präzisionswerk"))).toBe(true);
  });

  it("drops screen text when Presidio fails", async () => {
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    const bus = new FakeBus();
    await new Publisher({ bus, store: new MemoryStore(), log: silentLogger(), presidio: { analyzerUrl: "http://a", anonymizerUrl: "http://b" } }).screenEvents(session, [tracked]);
    expect(bus.of("sk:screen.events")[0]?.data.untrusted_screen_text).toBeUndefined();
  });

  it("publishes ctx commands and non-zero usage records", async () => {
    const bus = new FakeBus();
    const pub = new Publisher({ bus, store: new MemoryStore(), log: silentLogger() });
    await pub.ctx(session, "03:12 invoice 4471", 192_000);
    await pub.usage(session, 1000, [
      { service: "perception", vendor: "anthropic", units: 1200, unit: "tokens_in", cost_usd: 0.0012 },
      { service: "perception", vendor: "anthropic", units: 0, unit: "tokens_out", cost_usd: 0 },
    ]);
    expect(bus.of("sk:agent.commands")[0]?.data).toEqual({ type: "ctx", text: "03:12 invoice 4471" });
    expect(bus.of("sk:usage")).toHaveLength(1);
  });

  it("keeps publishing when the database insert fails", async () => {
    const bus = new FakeBus();
    const store = Object.assign(new MemoryStore(), { insertScreenEvents: async () => Promise.reject(new Error("db down")) });
    await new Publisher({ bus, store, log: silentLogger() }).screenEvents(session, [tracked]);
    expect(bus.of("sk:screen.events")).toHaveLength(1);
  });
});

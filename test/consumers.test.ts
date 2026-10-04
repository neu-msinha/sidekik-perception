import { describe, expect, it, vi } from "vitest";
import { wireConsumers } from "../src/consumers.js";
import { SessionRegistry } from "../src/sessions.js";
import { ev, FakeBus, lifecycle, silentLogger, started } from "./helpers.js";

function setup() {
  const bus = new FakeBus();
  const sessions = new SessionRegistry();
  const hooks = { onOffRecord: vi.fn(async (_s: unknown, _on: boolean) => {}), onEnded: vi.fn(async () => {}), onDom: vi.fn(async () => {}), onAsk: vi.fn(async () => {}) };
  wireConsumers(bus, sessions, silentLogger(), hooks);
  return { bus, sessions, hooks };
}

const dom = (t: number) => ev("sk:dom.events", t, { kind: "field_change", field: "cost_center", before: "4711", after: "0400" });
const ask = (t: number) => ev("sk:agent.commands", t, { type: "ask", question_id: "q1", text: "Warum 0400?", qtype: "why" }, undefined, "brain");

describe("consumers", () => {
  it("routes off-record changes and ended to the hooks", async () => {
    const { bus, hooks } = setup();
    await bus.deliver("sk:session.lifecycle", started());
    await bus.deliver("sk:session.lifecycle", lifecycle("offrecord_on"));
    await bus.deliver("sk:session.lifecycle", lifecycle("task_done"));
    await bus.deliver("sk:session.lifecycle", lifecycle("ended"));
    expect(hooks.onOffRecord).toHaveBeenCalledTimes(1);
    expect(hooks.onOffRecord.mock.calls[0]?.[1]).toBe(true);
    expect(hooks.onEnded).toHaveBeenCalledTimes(1);
  });

  it("drops DOM events and asks while off the record", async () => {
    const { bus, hooks } = setup();
    await bus.deliver("sk:session.lifecycle", started());
    await bus.deliver("sk:dom.events", dom(100));
    await bus.deliver("sk:agent.commands", ask(200));
    await bus.deliver("sk:session.lifecycle", lifecycle("offrecord_on", 300));
    await bus.deliver("sk:dom.events", dom(400));
    await bus.deliver("sk:agent.commands", ask(500));
    expect(hooks.onDom).toHaveBeenCalledTimes(1);
    expect(hooks.onAsk).toHaveBeenCalledTimes(1);
  });

  it("ignores everything for replay sessions", async () => {
    const { bus, hooks, sessions } = setup();
    await bus.deliver("sk:session.lifecycle", started("replay"));
    await bus.deliver("sk:dom.events", dom(100));
    await bus.deliver("sk:agent.commands", ask(200));
    expect(hooks.onDom).not.toHaveBeenCalled();
    expect(hooks.onAsk).not.toHaveBeenCalled();
    expect(sessions.size).toBe(0);
  });

  it("only passes ask commands on", async () => {
    const { bus, hooks } = setup();
    await bus.deliver("sk:session.lifecycle", started());
    await bus.deliver("sk:agent.commands", ev("sk:agent.commands", 100, { type: "ctx", text: "x" }, undefined, "perception"));
    expect(hooks.onAsk).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { prepareImage, toFrameBBox } from "../src/vision/image.js";
import { VISION_PROMPT } from "../src/vision/prompt.js";
import { EMPTY_VISION_STATE, type VisionOutput } from "../src/vision/schema.js";
import { AnthropicVisionModel, ClaudeVision, modelParams, userText, VisionError, type VisionModel, type VisionRequest } from "../src/vision/vision.js";
import { anthropicUsage, priceModel } from "../src/usage.js";
import { invoiceSvg, jpeg } from "./fixtures/screens.js";

const out = (confidence = 0.95, field = "cost_center"): VisionOutput => ({
  events: [{ type: "field_changed", entity: { kind: "invoice", id: "4471" }, field, before: "4711", after: "0400", ui_label: "Kostenstelle", bbox: [10, 10, 100, 20], confidence }],
  state: { ...EMPTY_VISION_STATE, app: "MiniERP" },
  untrusted_screen_text: "",
});

async function request(): Promise<VisionRequest> {
  const frame = await jpeg(invoiceSvg({ invoice: "4471", amount: "6350", costCenter: "0400" }));
  return { image: await prepareImage(frame, { width: 1280, height: 720 }), previous: EMPTY_VISION_STATE };
}

/** Answers each call from the script in order; an Error entry throws. */
class Scripted implements VisionModel {
  readonly models: string[] = [];
  constructor(private readonly script: (VisionOutput | Error)[]) {}
  async call(model: string) {
    this.models.push(model);
    const next = this.script.shift();
    if (!next || next instanceof Error) throw next ?? new Error("script empty");
    return { output: next, usage: { input_tokens: 1200, output_tokens: 150 } };
  }
}

describe("ClaudeVision policy", () => {
  it("returns a confident first reading after one call", async () => {
    const m = new Scripted([out(0.95)]);
    const res = await new ClaudeVision({ primary: "claude-haiku-4-5-20251001", model: m }).see(await request());
    expect(m.models).toEqual(["claude-haiku-4-5-20251001"]);
    expect(res).toMatchObject({ model: "claude-haiku-4-5-20251001", escalated: false });
    expect(res.calls).toHaveLength(1);
  });

  it("retries a failed call once, then skips the frame", async () => {
    const m = new Scripted([new Error("timeout"), out()]);
    const res = await new ClaudeVision({ primary: "h", model: m }).see(await request());
    expect(m.models).toEqual(["h", "h"]);
    expect(res.calls.map((c) => c.ok)).toEqual([false, true]);

    const m2 = new Scripted([new Error("timeout"), new Error("timeout")]);
    const err = await new ClaudeVision({ primary: "h", model: m2 }).see(await request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VisionError);
    expect((err as VisionError).calls).toHaveLength(2);
  });

  it("escalates a low-confidence numeric field to VISION_FALLBACK", async () => {
    const m = new Scripted([out(0.5), out(0.9)]);
    const res = await new ClaudeVision({ primary: "h", fallback: "s", model: m }).see(await request());
    expect(m.models).toEqual(["h", "s"]);
    expect(res).toMatchObject({ model: "s", escalated: true });
    expect(res.output.events[0]?.confidence).toBe(0.9);
  });

  it("retries the primary when no fallback is set and keeps the more confident reading", async () => {
    const m = new Scripted([out(0.6), out(0.4)]);
    const res = await new ClaudeVision({ primary: "h", model: m }).see(await request());
    expect(m.models).toEqual(["h", "h"]);
    expect(res.output.events[0]?.confidence).toBe(0.6);
    expect(res.escalated).toBe(false);
  });

  it("does not escalate low confidence on a non-numeric field", async () => {
    const m = new Scripted([out(0.3, "category")]);
    await new ClaudeVision({ primary: "h", fallback: "s", model: m }).see(await request());
    expect(m.models).toEqual(["h"]);
  });

  it("keeps the first reading when escalation fails", async () => {
    const m = new Scripted([out(0.5), new Error("down")]);
    const res = await new ClaudeVision({ primary: "h", fallback: "s", model: m }).see(await request());
    expect(res).toMatchObject({ model: "h", escalated: false });
  });
});

describe("AnthropicVisionModel", () => {
  it("sends the verbatim prompt, a base64 JPEG and a JSON schema, and parses the reply", async () => {
    let body: Record<string, any> = {};
    const fetch = (async (_url: unknown, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: JSON.stringify(out()) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1234, output_tokens: 99 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch;
    const model = new AnthropicVisionModel({ apiKey: "test", timeoutMs: 2000, fetch });
    const req = await request();
    const res = await model.call("claude-haiku-4-5-20251001", req);

    expect(body.system).toBe(VISION_PROMPT);
    expect(body.temperature).toBe(0);
    const [image, text] = body.messages[0].content;
    expect(image).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/jpeg" } });
    expect(Buffer.from(image.source.data, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(text.text).toContain("PREVIOUS_STATE:");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(res.usage).toEqual({ input_tokens: 1234, output_tokens: 99 });
    expect(res.output.events[0]?.after).toBe("0400");
  });

  it("reports a refusal as a billed failure", async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({ id: "m", type: "message", role: "assistant", model: "h", content: [], stop_reason: "refusal", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof globalThis.fetch;
    const vision = new ClaudeVision({ primary: "h", model: new AnthropicVisionModel({ apiKey: "t", timeoutMs: 2000, fetch }) });
    const err = (await vision.see(await request()).catch((e: unknown) => e)) as VisionError;
    expect(err).toBeInstanceOf(VisionError);
    expect(err.calls.map((c) => c.usage.input_tokens)).toEqual([10, 10]);
  });

  it("uses settings each model accepts", () => {
    expect(modelParams("claude-haiku-4-5-20251001")).toEqual({ temperature: 0 });
    expect(modelParams("claude-sonnet-5-5")).toEqual({ thinking: { type: "between_tools" } });
    expect(modelParams("claude-opus-5-5")).toEqual({});
  });
});

describe("images", () => {
  it("crops, caps the width and maps bboxes back to the frame", async () => {
    const frame = await jpeg(invoiceSvg({ invoice: "4471", amount: "6350", costCenter: "4711" }));
    const crop = { left: 400, top: 340, width: 260, height: 90 };
    const img = await prepareImage(frame, { width: 1280, height: 720 }, crop);
    expect([img.width, img.height, img.scale]).toEqual([260, 90, 1]);
    expect(toFrameBBox([10, 20, 100, 30], img)).toEqual({ left: 410, top: 360, width: 100, height: 30 });
    expect(toFrameBBox([1, 2, 3], img)).toBeUndefined();
    expect(userText({ image: img, previous: EMPTY_VISION_STATE })).toMatch(/cropped part of the screen \(x=400, y=340/);
  });

  it("downscales frames wider than 1280 px", async () => {
    const sharp = (await import("sharp")).default;
    const wide = await sharp({ create: { width: 2560, height: 1440, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    const img = await prepareImage(wide, { width: 2560, height: 1440 });
    expect([img.width, img.height, img.scale]).toEqual([1280, 720, 0.5]);
    expect(toFrameBBox([100, 100, 50, 50], img)).toEqual({ left: 200, top: 200, width: 100, height: 100 });
  });
});

describe("usage", () => {
  it("prices dated model ids from PRICE_TABLE", () => {
    expect(priceModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    const [tin, tout] = anthropicUsage("claude-haiku-4-5-20251001", { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(tin).toMatchObject({ vendor: "anthropic", unit: "tokens_in", cost_usd: 1, service: "perception" });
    expect(tout).toMatchObject({ unit: "tokens_out", cost_usd: 5 });
    expect(anthropicUsage("unknown-model", { input_tokens: 5, output_tokens: 5 })[0]?.cost_usd).toBe(0);
  });
});

import { signSessionToken } from "@sidekik/contracts";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { SessionDirectory } from "../src/directory.js";
import { FrameGate } from "../src/frames/gate.js";
import { encodeFrame, parseFrame } from "../src/frames/protocol.js";
import type { FrameSink, IncomingFrame } from "../src/frames/routes.js";
import { buildServer } from "../src/server.js";
import { SessionRegistry, type Session } from "../src/sessions.js";
import { INTERNAL, lifecycle, ORG, SECRET, SID, silentLogger, started } from "./helpers.js";

let JPEG: Buffer;
beforeAll(async () => {
  JPEG = await sharp({ create: { width: 64, height: 36, channels: 3, background: "#ffffff" } }).jpeg({ quality: 70 }).toBuffer();
});

describe("parseFrame", () => {
  it("round-trips header and JPEG", () => {
    const res = parseFrame(encodeFrame({ t_ms: 1234, reason: "blur" }, JPEG));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.frame.t_ms).toBe(1234);
      expect(res.frame.reason).toBe("blur");
      expect(res.frame.jpeg.equals(JPEG)).toBe(true);
    }
  });

  it("rejects bad messages", () => {
    expect(parseFrame(Buffer.from([0, 0]))).toMatchObject({ ok: false, error: "too short" });
    expect(parseFrame(Buffer.from([0, 0, 0x10, 0, 1, 2, 3]))).toMatchObject({ ok: false });
    const badJson = Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from("{x}"), JPEG]);
    expect(parseFrame(badJson)).toMatchObject({ ok: false, error: "bad header" });
    expect(parseFrame(encodeFrame({ t_ms: 1, reason: "tick" }, Buffer.from("PNGxxxx")))).toMatchObject({ ok: false, error: "not a JPEG" });
    const badReason = Buffer.concat([Buffer.from([0, 0, 0, 25]), Buffer.from('{"t_ms":1,"reason":"zoom"}'.padEnd(25)), JPEG]);
    expect(parseFrame(badReason)).toMatchObject({ ok: false, error: "bad header" });
  });
});

describe("FrameGate", () => {
  it("caps each session at 2 fps with a little jitter allowance", () => {
    const g = new FrameGate();
    expect(g.admit("a", 0)).toBe(true);
    expect(g.admit("a", 200)).toBe(false);
    expect(g.admit("a", 460)).toBe(true);
    expect(g.admit("b", 470)).toBe(true);
    expect(g.admit("a", 700)).toBe(false);
    expect(g.admit("a", 1000)).toBe(true);
  });
});

class CollectSink implements FrameSink {
  readonly frames: { session: Session; frame: IncomingFrame }[] = [];
  onFrame(session: Session, frame: IncomingFrame): void {
    this.frames.push({ session, frame });
  }
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function server(directory: SessionDirectory = { orgOf: async () => undefined }) {
  const sessions = new SessionRegistry();
  const sink = new CollectSink();
  const app = buildServer({
    version: "test",
    logger: silentLogger(),
    checks: {},
    frames: { sessions, directory, sink, sessionSecret: SECRET, internalToken: INTERNAL, log: silentLogger(), gate: new FrameGate(0) },
  });
  await app.ready();
  close = () => app.close();
  return { app, sessions, sink };
}

const token = (sid = SID) => signSessionToken({ sid, org: ORG, role: "expert", kind: "capture" }, SECRET);

async function send(ws: WebSocket, msgs: Buffer[]): Promise<void> {
  for (const m of msgs) ws.send(m);
  // Round-trip a ping so the server has handled everything sent before it.
  await new Promise<void>((resolve) => {
    ws.once("pong", () => resolve());
    ws.ping();
  });
}

describe("WS /ws/frames/:sid", () => {
  it("accepts frames with a valid sk_token and passes them to the sink", async () => {
    const { app, sink, sessions } = await server();
    const ws = await app.injectWS(`/ws/frames/${SID}?t=${token()}`);
    await send(ws, [encodeFrame({ t_ms: 100, reason: "tick" }, JPEG), encodeFrame({ t_ms: 600, reason: "nav" }, JPEG)]);
    expect(sink.frames.map((f) => [f.frame.t_ms, f.frame.reason, f.frame.source])).toEqual([
      [100, "tick", "browser"],
      [600, "nav", "browser"],
    ]);
    expect(sessions.get(SID)?.org_id).toBe(ORG);
    ws.terminate();
  });

  it("rejects a missing, bad or other-session token before upgrading", async () => {
    const { app } = await server();
    await expect(app.injectWS(`/ws/frames/${SID}`)).rejects.toThrow(/401/);
    await expect(app.injectWS(`/ws/frames/${SID}?t=${token()}x`)).rejects.toThrow(/401/);
    await expect(app.injectWS(`/ws/frames/${SID}?t=${token("other")}`)).rejects.toThrow(/401/);
    const wrongSecret = signSessionToken({ sid: SID, org: ORG, role: "expert", kind: "capture" }, "another-secret-1234567");
    await expect(app.injectWS(`/ws/frames/${SID}?t=${wrongSecret}`)).rejects.toThrow(/401/);
  });

  it("drops text and malformed messages", async () => {
    const { app, sink } = await server();
    const ws = await app.injectWS(`/ws/frames/${SID}?t=${token()}`);
    ws.send("hello");
    await send(ws, [Buffer.from([0, 0, 0, 1, 0x7b]), encodeFrame({ t_ms: 5, reason: "tick" }, JPEG)]);
    expect(sink.frames).toHaveLength(1);
    ws.terminate();
  });

  it("drops frames faster than 2 fps", async () => {
    const sessions = new SessionRegistry();
    const sink = new CollectSink();
    const app = buildServer({
      version: "test",
      logger: silentLogger(),
      checks: {},
      frames: { sessions, directory: { orgOf: async () => undefined }, sink, sessionSecret: SECRET, internalToken: INTERNAL, log: silentLogger() },
    });
    await app.ready();
    close = () => app.close();
    const ws = await app.injectWS(`/ws/frames/${SID}?t=${token()}`);
    await send(ws, [1, 2, 3, 4, 5].map((i) => encodeFrame({ t_ms: i * 100, reason: "tick" }, JPEG)));
    expect(sink.frames).toHaveLength(1);
    ws.terminate();
  });

  it("drops frames while off the record and resumes after", async () => {
    const { app, sink, sessions } = await server();
    sessions.applyLifecycle(started());
    const ws = await app.injectWS(`/ws/frames/${SID}?t=${token()}`);
    sessions.applyLifecycle(lifecycle("offrecord_on"));
    await send(ws, [encodeFrame({ t_ms: 1100, reason: "tick" }, JPEG)]);
    expect(sink.frames).toHaveLength(0);
    sessions.applyLifecycle(lifecycle("offrecord_off", 2000));
    await send(ws, [encodeFrame({ t_ms: 2100, reason: "tick" }, JPEG)]);
    expect(sink.frames.map((f) => f.frame.t_ms)).toEqual([2100]);
    ws.terminate();
  });

  it("closes the socket once the session has ended", async () => {
    const { app, sink, sessions } = await server();
    sessions.applyLifecycle(started());
    const ws = await app.injectWS(`/ws/frames/${SID}?t=${token()}`);
    sessions.applyLifecycle(lifecycle("ended"));
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(encodeFrame({ t_ms: 5000, reason: "tick" }, JPEG));
    expect(await closed).toBe(4410);
    expect(sink.frames).toHaveLength(0);
  });
});

describe("WS /internal/frames/:sid", () => {
  it("requires X-Internal-Token", async () => {
    const { app } = await server();
    await expect(app.injectWS(`/internal/frames/${SID}`)).rejects.toThrow(/401/);
    await expect(app.injectWS(`/internal/frames/${SID}`, { headers: { "x-internal-token": "wrong" } })).rejects.toThrow(/401/);
  });

  it("finds the org in the sessions table and tags frames as meeting", async () => {
    const { app, sink, sessions } = await server({ orgOf: async (sid) => (sid === SID ? ORG : undefined) });
    const ws = await app.injectWS(`/internal/frames/${SID}`, { headers: { "x-internal-token": INTERNAL } });
    // Give the directory lookup a tick to resolve.
    await new Promise((r) => setTimeout(r, 10));
    await send(ws, [encodeFrame({ t_ms: 300, reason: "tick" }, JPEG)]);
    expect(sink.frames.map((f) => f.frame.source)).toEqual(["meeting"]);
    expect(sessions.get(SID)?.org_id).toBe(ORG);
    ws.terminate();
  });

  it("uses the live session without a lookup", async () => {
    const { app, sink, sessions } = await server();
    sessions.applyLifecycle(started("meeting"));
    const ws = await app.injectWS(`/internal/frames/${SID}`, { headers: { "x-internal-token": INTERNAL } });
    await send(ws, [encodeFrame({ t_ms: 300, reason: "tick" }, JPEG)]);
    expect(sink.frames).toHaveLength(1);
    ws.terminate();
  });

  it("drops frames for a session it can't place", async () => {
    const { app, sink } = await server();
    const ws = await app.injectWS(`/internal/frames/${SID}`, { headers: { "x-internal-token": INTERNAL } });
    await send(ws, [encodeFrame({ t_ms: 300, reason: "tick" }, JPEG)]);
    expect(sink.frames).toHaveLength(0);
    ws.terminate();
  });
});

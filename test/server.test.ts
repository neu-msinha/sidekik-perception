import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { silentLogger } from "./helpers.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
});

function server(redisOk = true) {
  const app = buildServer({ version: "9.9.9", logger: silentLogger(), checks: { redis: async () => redisOk } });
  close = () => app.close();
  return app;
}

describe("server", () => {
  it("GET /healthz reports ok with deps", async () => {
    const res = await server().inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: "9.9.9", deps: { redis: "ok" } });
  });

  it("GET /healthz is 503 when a dependency is down", async () => {
    const res = await server(false).inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, deps: { redis: "down" } });
  });
});

describe("GET /internal/keyframe-url", () => {
  it("signs a keyframe's path for 5 minutes behind X-Internal-Token", async () => {
    const { MemoryStore } = await import("../src/store.js");
    const store = new MemoryStore();
    const id = "11111111-2222-4333-8444-555555555555";
    await store.insertKeyframe({ id, org_id: "o", session_id: "s", t_ms: 1, storage_path: "captures/org/o/sessions/s/keyframes/1.webp", phash: "0".repeat(16), redacted: true });
    const app = buildServer({ version: "t", logger: silentLogger(), checks: {}, internal: { token: "tok-1234567890abcdef", store } });
    close = () => app.close();
    const get = (q: string, token = "tok-1234567890abcdef") => app.inject({ method: "GET", url: `/internal/keyframe-url${q}`, headers: { "x-internal-token": token } });
    expect((await get(`?keyframe_id=${id}`, "wrong")).statusCode).toBe(401);
    const ok = await get(`?keyframe_id=${id}`);
    expect(ok.json()).toEqual({ url: "memory://captures/org/o/sessions/s/keyframes/1.webp?ttl=300" });
    expect((await get("?keyframe_id=nope")).statusCode).toBe(400);
    expect((await get("?keyframe_id=11111111-2222-4333-8444-000000000000")).statusCode).toBe(404);
  });
});

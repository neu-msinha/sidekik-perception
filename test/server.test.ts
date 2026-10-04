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

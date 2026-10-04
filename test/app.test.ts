import { STREAMS } from "@sidekik/contracts";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPerception, type Perception } from "../src/app.js";
import { loadPerceptionEnv } from "../src/env.js";
import { INTERNAL, lifecycle, SECRET, SID, silentLogger, started } from "./helpers.js";

// Over real Redis (sidekik-platform dev/docker-compose.yml). DB 13 keeps it away from dev data.
const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/13";
let perception: Perception;

beforeAll(async () => {
  const admin = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await admin.connect();
    await admin.flushdb();
  } catch {
    throw new Error(`Redis not reachable at ${REDIS_URL}. Run: docker compose -f ../sidekik-platform/dev/docker-compose.yml up -d redis`);
  } finally {
    admin.disconnect();
  }
  const env = loadPerceptionEnv({
    REDIS_URL,
    SUPABASE_URL: "http://localhost:54321",
    SUPABASE_SERVICE_ROLE_KEY: "test",
    SK_INTERNAL_TOKEN: INTERNAL,
    SK_SESSION_SECRET: SECRET,
    PERSISTENCE: "memory",
    FAKE_VISION: "true",
  });
  perception = await startPerception(env, { listen: false, logger: silentLogger() });
});

afterAll(async () => {
  await perception?.close();
});

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("app over Redis", () => {
  it("serves /healthz with redis ok", async () => {
    const res = await perception.app.inject({ method: "GET", url: "/healthz" });
    expect(res.json()).toMatchObject({ ok: true, deps: { redis: "ok" } });
  });

  it("tracks lifecycle from the bus", async () => {
    // Let the consumer groups get created before the first publish.
    await new Promise((r) => setTimeout(r, 300));
    await perception.bus.publish(STREAMS.lifecycle, started());
    await until(() => perception.sessions.get(SID) !== undefined);
    await perception.bus.publish(STREAMS.lifecycle, lifecycle("offrecord_on"));
    await until(() => perception.sessions.get(SID)?.offRecord === true);
    await perception.bus.publish(STREAMS.lifecycle, lifecycle("ended", 2000));
    await until(() => perception.sessions.get(SID) === undefined);
  });
});

/**
 * Runs perception against a recorded bus fixture, with no teammates' services and no database.
 *
 *   pnpm dev:mock                                  # sidekik-platform capture fixture, 20x speed
 *   pnpm dev:mock path/to/fixture.jsonl --speed 1  # real time
 *   pnpm dev:mock --keep                           # keep serving after the replay
 *
 * The fixture's DOM events go through the real state tracker, so it prints the screen.events and ctx
 * lines perception would publish. Without ANTHROPIC_API_KEY, vision runs on the offline fake.
 *
 * Needs Redis: docker compose -f ../sidekik-platform/dev/docker-compose.yml up -d redis
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Redis } from "ioredis";
import { startPerception } from "../src/app.js";
import { loadPerceptionEnv } from "../src/env.js";
import { readFixture, replayFixture } from "./replay.js";

const PLATFORM_FIXTURE = fileURLToPath(new URL("../../sidekik-platform/dev/fixtures/capture_sabine.jsonl", import.meta.url));

// Local defaults so dev:mock boots without a filled-in .env. Real values win.
const DEV_DEFAULTS: Record<string, string> = {
  REDIS_URL: "redis://localhost:6379",
  SUPABASE_URL: "http://localhost:54321",
  SUPABASE_SERVICE_ROLE_KEY: "dev-mock",
  SK_INTERNAL_TOKEN: "dev-mock-internal-token",
  SK_SESSION_SECRET: "dev-mock-session-secret",
  PERSISTENCE: "memory",
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    speed: { type: "string", default: "20" },
    keep: { type: "boolean", default: false },
  },
});

const fixturePath = positionals[0] ?? PLATFORM_FIXTURE;
if (!existsSync(fixturePath)) {
  console.error(`fixture not found: ${fixturePath} (clone sidekik-platform next to this repo, or pass a path)`);
  process.exit(1);
}

const real = stripEmpty(process.env);
const env = loadPerceptionEnv({ ...DEV_DEFAULTS, ...real, ...(real.ANTHROPIC_API_KEY ? {} : { FAKE_VISION: "true" }) });
const perception = await startPerception(env);
const { log } = perception;

// The fixture also carries the screen.events and ctx the recording's perception published: count only ours.
const lines = readFixture(fixturePath).filter((l) => l.ev.producer !== "perception");
log.info({ fixture: fixturePath, events: lines.length, speed: Number(values.speed), fake_vision: env.FAKE_VISION }, "dev:mock replaying");
// Let consumer groups get created before the first publish.
await new Promise((r) => setTimeout(r, 300));
const sessions = await replayFixture(perception.bus, lines, { speed: Number(values.speed) });
await new Promise((r) => setTimeout(r, 1000));

const redis = new Redis(env.REDIS_URL);
const ids = new Set(sessions.values());
const read = async (stream: string) =>
  (await redis.xrange(stream, "-", "+"))
    .map(([, f]) => JSON.parse(f[f.indexOf("ev") + 1] ?? "null") as { session_id: string; t_ms: number; producer: string; data: Record<string, unknown> })
    .filter((e) => e && ids.has(e.session_id) && e.producer === "perception");
for (const e of await read("sk:screen.events")) {
  const d = e.data;
  console.log(`screen.event ${String(e.t_ms).padStart(7)}  ${String(d.type).padEnd(16)} ${d.field ?? ""} ${d.before ?? ""}${d.after !== undefined ? `→${d.after}` : ""} (${d.source})`);
}
for (const e of await read("sk:agent.commands")) console.log(`ctx          ${String(e.t_ms).padStart(7)}  ${e.data.text}`);
redis.disconnect();

if (values.keep) {
  log.info(`dev:mock done; still serving on :${env.PORT} (Ctrl+C to stop)`);
} else {
  await perception.close();
}

function stripEmpty(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(source).filter((e): e is [string, string] => !!e[1]));
}

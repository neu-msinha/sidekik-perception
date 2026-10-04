/**
 * Runs perception against a recorded bus fixture, with no teammates' services.
 *
 *   pnpm dev:mock                                  # sidekik-platform capture fixture, 20x speed
 *   pnpm dev:mock path/to/fixture.jsonl --speed 1  # real time
 *   pnpm dev:mock --keep                           # keep serving after the replay
 *
 * Needs Redis: docker compose -f ../sidekik-platform/dev/docker-compose.yml up -d redis
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
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

const env = loadPerceptionEnv({ ...DEV_DEFAULTS, ...stripEmpty(process.env) });
const perception = await startPerception(env);
const { log } = perception;

const lines = readFixture(fixturePath);
log.info({ fixture: fixturePath, events: lines.length, speed: Number(values.speed) }, "dev:mock replaying");
// Let consumer groups get created before the first publish.
await new Promise((r) => setTimeout(r, 300));
const sessions = await replayFixture(perception.bus, lines, { speed: Number(values.speed) });
await new Promise((r) => setTimeout(r, 500));

for (const sid of sessions.values()) {
  const s = perception.sessions.get(sid);
  log.info(s ? { ...s } : { session_id: sid }, s ? "dev:mock session state" : "dev:mock session ended");
}

if (values.keep) {
  log.info(`dev:mock done; still serving on :${env.PORT} (Ctrl+C to stop)`);
} else {
  await perception.close();
}

function stripEmpty(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(source).filter((e): e is [string, string] => !!e[1]));
}

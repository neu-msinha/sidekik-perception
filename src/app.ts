import { readFileSync } from "node:fs";
import { createBus, createLogger, type Bus, type Logger } from "@sidekik/contracts";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { wireConsumers, type PerceptionHooks } from "./consumers.js";
import { RegistryFirstDirectory } from "./directory.js";
import type { PerceptionEnv } from "./env.js";
import type { FrameSink } from "./frames/routes.js";
import { buildServer } from "./server.js";
import { SessionRegistry } from "./sessions.js";

export const VERSION = readVersion();

function readVersion(): string {
  // src/app.ts under tsx, dist/src/app.js when built.
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")).version;
    } catch {
      // try the next location
    }
  }
  return "0.0.0";
}

export type Perception = {
  app: FastifyInstance;
  bus: Bus;
  sessions: SessionRegistry;
  log: Logger;
  close(): Promise<void>;
};

export type StartOptions = { listen?: boolean; logger?: Logger; bus?: Bus; hooks?: PerceptionHooks; sink?: FrameSink };

export async function startPerception(env: PerceptionEnv, opts: StartOptions = {}): Promise<Perception> {
  const log = opts.logger ?? createLogger("perception", { level: env.LOG_LEVEL });
  const sessions = new SessionRegistry();
  const bus = opts.bus ?? createBus(env.REDIS_URL, "perception", { logger: log });
  const health = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await health.connect();

  const stopConsumers = wireConsumers(bus, sessions, log, opts.hooks);
  const directory = new RegistryFirstDirectory(
    sessions,
    env.PERSISTENCE === "supabase" ? { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY } : undefined,
  );
  // Until the pipeline lands, accepted frames are only counted.
  const sink: FrameSink = opts.sink ?? { onFrame: () => {} };
  const app = buildServer({
    version: VERSION,
    logger: log,
    checks: { redis: async () => (await health.ping()) === "PONG" },
    frames: { sessions, directory, sink, sessionSecret: env.SK_SESSION_SECRET, internalToken: env.SK_INTERNAL_TOKEN, log },
  });

  if (opts.listen ?? true) {
    await app.listen({ host: "::", port: env.PORT });
  } else {
    await app.ready();
  }

  return {
    app,
    bus,
    sessions,
    log,
    async close() {
      stopConsumers();
      await app.close();
      await bus.close();
      await health.quit();
    },
  };
}

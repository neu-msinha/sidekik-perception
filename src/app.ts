import { readFileSync } from "node:fs";
import { createBus, createLogger, type Bus, type Logger } from "@sidekik/contracts";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { wireConsumers, type PerceptionHooks } from "./consumers.js";
import { RegistryFirstDirectory } from "./directory.js";
import type { PerceptionEnv } from "./env.js";
import type { FrameSink } from "./frames/routes.js";
import { PipelineManager, type EventsListener } from "./pipeline.js";
import { Publisher } from "./publisher.js";
import { MemoryStore, SupabaseStore, type PerceptionStore } from "./store.js";
import { FakeVision } from "./vision/fake.js";
import { AnthropicVisionModel, ClaudeVision, type Vision } from "./vision/vision.js";
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
  pipelines: PipelineManager;
  store: PerceptionStore;
  log: Logger;
  close(): Promise<void>;
};

export type StartOptions = {
  listen?: boolean;
  logger?: Logger;
  bus?: Bus;
  vision?: Vision;
  store?: PerceptionStore;
  /** Extra listener for published events (tests). */
  onEvents?: EventsListener;
  hooks?: PerceptionHooks;
  sink?: FrameSink;
};

export function createVision(env: PerceptionEnv): Vision {
  if (env.FAKE_VISION) return new FakeVision();
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required (or FAKE_VISION=true for offline dev)");
  return new ClaudeVision({
    primary: env.VISION_PRIMARY,
    ...(env.VISION_FALLBACK ? { fallback: env.VISION_FALLBACK } : {}),
    model: new AnthropicVisionModel({ apiKey: env.ANTHROPIC_API_KEY, timeoutMs: env.VISION_TIMEOUT_MS }),
  });
}

export function createStore(env: PerceptionEnv, log: Logger): PerceptionStore {
  return env.PERSISTENCE === "supabase" ? new SupabaseStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY) : new MemoryStore(log);
}

export async function startPerception(env: PerceptionEnv, opts: StartOptions = {}): Promise<Perception> {
  const log = opts.logger ?? createLogger("perception", { level: env.LOG_LEVEL });
  const sessions = new SessionRegistry();
  const bus = opts.bus ?? createBus(env.REDIS_URL, "perception", { logger: log });
  const health = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await health.connect();

  const store = opts.store ?? createStore(env, log);
  const publisher = new Publisher({
    bus,
    store,
    log,
    ...(env.PRESIDIO_ANALYZER_URL && env.PRESIDIO_ANONYMIZER_URL
      ? { presidio: { analyzerUrl: env.PRESIDIO_ANALYZER_URL, anonymizerUrl: env.PRESIDIO_ANONYMIZER_URL } }
      : {}),
  });
  const pipelines = new PipelineManager({ vision: opts.vision ?? createVision(env), publisher, log }, opts.onEvents);
  const hooks: PerceptionHooks = opts.hooks ?? {
    onDom: (session, ev) => pipelines.onDom(session, ev),
    onOffRecord: async (session, on) => pipelines.onOffRecord(session, on),
    onEnded: (session) => pipelines.onEnded(session),
  };
  const stopConsumers = wireConsumers(bus, sessions, log, hooks);
  const directory = new RegistryFirstDirectory(
    sessions,
    env.PERSISTENCE === "supabase" ? { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY } : undefined,
  );
  const sink: FrameSink = opts.sink ?? pipelines;
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
    pipelines,
    store,
    log,
    async close() {
      stopConsumers();
      await app.close();
      await pipelines.close();
      await bus.close();
      await health.quit();
    },
  };
}

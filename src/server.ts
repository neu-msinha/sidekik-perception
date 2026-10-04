import { ClipsRequestSchema, internalAuth, type Logger } from "@sidekik/contracts";
import type { ClipsService } from "./clips.js";
import websocket from "@fastify/websocket";
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { MAX_FRAME_BYTES } from "./frames/protocol.js";
import { registerFrameRoutes, type FrameRouteDeps } from "./frames/routes.js";
import type { PerceptionStore } from "./store.js";

/** GET /internal/keyframe-url: signed URLs live 5 minutes (DESIGN §2). */
export const KEYFRAME_URL_TTL_S = 300;

export type HealthCheck = () => Promise<boolean>;

export type ServerDeps = {
  version: string;
  /** Named dependency checks reported by /healthz. */
  checks: Record<string, HealthCheck>;
  logger: Logger;
  /** Serves the frames WebSockets when set. */
  frames?: FrameRouteDeps;
  /** Serves the internal HTTP routes when set. */
  internal?: { token: string; store: PerceptionStore; clips?: ClipsService };
};

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app: FastifyInstance = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    // Health probes would flood the logs; every other request is logged.
    logController: new LogController({ disableRequestLogging: (req) => req.url === "/healthz" }),
  });

  app.get("/healthz", async (_req, reply) => {
    const entries = await Promise.all(
      Object.entries(deps.checks).map(async ([name, check]) => {
        const ok = await check().catch(() => false);
        return [name, ok ? "ok" : "down"] as const;
      }),
    );
    const ok = entries.every(([, status]) => status === "ok");
    return reply.code(ok ? 200 : 503).send({ ok, version: deps.version, deps: Object.fromEntries(entries) });
  });

  app.register(websocket, { options: { maxPayload: MAX_FRAME_BYTES } });
  // Registered after the websocket plugin so its onRoute hook sees `websocket: true`.
  const frames = deps.frames;
  if (frames) app.register(async (scope) => registerFrameRoutes(scope, frames));

  const internal = deps.internal;
  if (internal) {
    app.register(
      async (scope) => {
        scope.addHook("preHandler", internalAuth(internal.token));
        scope.get<{ Querystring: { keyframe_id?: string } }>("/keyframe-url", async (req, reply) => {
          const id = req.query.keyframe_id ?? "";
          if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(400).send({ error: "keyframe_id must be a uuid" });
          const kf = await internal.store.getKeyframe(id);
          if (!kf) return reply.code(404).send({ error: "unknown keyframe" });
          return { url: await internal.store.signedUrl(kf.storage_path, KEYFRAME_URL_TTL_S) };
        });

        const clips = internal.clips;
        if (clips) {
          // POST /internal/clips (mapper): 202 {job_id}; the clips rows appear when the job is done.
          scope.post("/clips", async (req, reply) => {
            const parsed = ClipsRequestSchema.safeParse(req.body);
            if (!parsed.success) return reply.code(400).send({ error: "invalid request", issues: parsed.error.issues });
            const job = clips.submit(parsed.data);
            return reply.code(202).send({ job_id: job.job_id });
          });
          // Job status, for callers that want to wait rather than poll the clips table.
          scope.get<{ Params: { job_id: string } }>("/clips/:job_id", async (req, reply) => {
            const job = clips.get(req.params.job_id);
            return job ?? reply.code(404).send({ error: "unknown job" });
          });
        }
      },
      { prefix: "/internal" },
    );
  }

  return app;
}

import type { Logger } from "@sidekik/contracts";
import websocket from "@fastify/websocket";
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { MAX_FRAME_BYTES } from "./frames/protocol.js";
import { registerFrameRoutes, type FrameRouteDeps } from "./frames/routes.js";

export type HealthCheck = () => Promise<boolean>;

export type ServerDeps = {
  version: string;
  /** Named dependency checks reported by /healthz. */
  checks: Record<string, HealthCheck>;
  logger: Logger;
  /** Serves the frames WebSockets when set. */
  frames?: FrameRouteDeps;
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

  return app;
}

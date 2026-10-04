import type { Logger } from "@sidekik/contracts";
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from "fastify";

export type HealthCheck = () => Promise<boolean>;

export type ServerDeps = {
  version: string;
  /** Named dependency checks reported by /healthz. */
  checks: Record<string, HealthCheck>;
  logger: Logger;
};

/** Fastify app with /healthz. Routes for frames, clips and keyframes are registered by their modules. */
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

  return app;
}

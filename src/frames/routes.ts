import {
  AuthError,
  checkInternalToken,
  INTERNAL_TOKEN_HEADER,
  sessionLogger,
  verifySessionToken,
  type Logger,
  type SessionClaims,
} from "@sidekik/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RawData, WebSocket } from "ws";
import type { SessionDirectory } from "../directory.js";
import type { Session, SessionRegistry } from "../sessions.js";
import { FrameGate } from "./gate.js";
import { parseFrame, type Frame } from "./protocol.js";

export type FrameSource = "browser" | "meeting";
export type IncomingFrame = Frame & { source: FrameSource; received_ms: number };

/** Where accepted frames go (the per-session pipeline). Must not block: the socket handler doesn't wait. */
export interface FrameSink {
  onFrame(session: Session, frame: IncomingFrame): void;
}

export type FrameRouteDeps = {
  sessions: SessionRegistry;
  directory: SessionDirectory;
  sink: FrameSink;
  sessionSecret: string;
  internalToken: string;
  log: Logger;
  gate?: FrameGate;
};

/** Close codes (4000–4999 are application-defined). */
export const CLOSE = { sessionGone: 4410 } as const;

type Stats = { received: number; accepted: number; invalid: number; rate_dropped: number; offrecord_dropped: number; no_session: number };

/**
 * WS /ws/frames/:sid?t=<sk_token> (browser) and WS /internal/frames/:sid (meetbot, X-Internal-Token).
 * Both carry the same binary frames; see protocol.ts.
 */
export function registerFrameRoutes(app: FastifyInstance, deps: FrameRouteDeps): void {
  const gate = deps.gate ?? new FrameGate();
  const claimsOf = new WeakMap<FastifyRequest, SessionClaims>();

  app.get<{ Params: { sid: string }; Querystring: { t?: string } }>(
    "/ws/frames/:sid",
    {
      websocket: true,
      preValidation: async (req, reply) => {
        try {
          const claims = verifySessionToken(req.query.t ?? "", deps.sessionSecret);
          if (claims.sid !== req.params.sid) throw new AuthError("token is for another session");
          claimsOf.set(req, claims);
        } catch (err) {
          req.log.warn({ session_id: req.params.sid, reason: err instanceof Error ? err.message : String(err) }, "frames: rejected token");
          await reply.code(401).send({ error: "unauthorized" });
        }
      },
    },
    (socket, req) => {
      const claims = claimsOf.get(req)!;
      const sid = req.params.sid;
      const resolve = () => deps.sessions.get(sid) ?? deps.sessions.ensure({ session_id: sid, org_id: claims.org, kind: claims.kind });
      serve(socket, sid, "browser", resolve, sessionLogger(deps.log, { session_id: sid, org_id: claims.org }));
    },
  );

  app.get<{ Params: { sid: string } }>(
    "/internal/frames/:sid",
    {
      websocket: true,
      preValidation: async (req, reply) => {
        if (!checkInternalToken(req.headers[INTERNAL_TOKEN_HEADER], deps.internalToken)) {
          await reply.code(401).send({ error: "unauthorized" });
        }
      },
    },
    (socket, req) => {
      const sid = req.params.sid;
      // meetbot connects with only the session id: the org comes from lifecycle or the sessions table.
      let org: string | undefined;
      let lookup: Promise<void> | undefined;
      const findOrg = () => {
        lookup ??= deps.directory
          .orgOf(sid)
          .then((o) => {
            org = o;
          })
          .catch(() => {})
          .finally(() => {
            // Retry on a later frame if it wasn't found yet.
            if (!org) setTimeout(() => (lookup = undefined), 2000).unref();
          });
      };
      findOrg();
      const resolve = () => {
        const live = deps.sessions.get(sid);
        if (live) return live;
        if (!org) {
          findOrg();
          return null;
        }
        return deps.sessions.ensure({ session_id: sid, org_id: org });
      };
      serve(socket, sid, "meeting", resolve, deps.log.child({ session_id: sid }));
    },
  );

  /** `resolve` returns the session, null while it isn't known yet, or undefined once it's ended or a replay. */
  function serve(socket: WebSocket, sid: string, source: FrameSource, resolve: () => Session | null | undefined, log: Logger): void {
    const stats: Stats = { received: 0, accepted: 0, invalid: 0, rate_dropped: 0, offrecord_dropped: 0, no_session: 0 };
    const opened = Date.now();
    log.info({ source }, "frames: connected");

    socket.on("message", (data: RawData, isBinary: boolean) => {
      stats.received++;
      if (!isBinary) {
        stats.invalid++;
        return;
      }
      const parsed = parseFrame(toBuffer(data));
      if (!parsed.ok) {
        stats.invalid++;
        if (stats.invalid <= 3) log.warn({ source, error: parsed.error }, "frames: invalid message");
        return;
      }
      const session = resolve();
      if (session === undefined) {
        socket.close(CLOSE.sessionGone, "session ended");
        return;
      }
      if (session === null) {
        stats.no_session++;
        return;
      }
      // Off the record: drop before anything is decoded or kept.
      if (session.offRecord) {
        stats.offrecord_dropped++;
        return;
      }
      const now = Date.now();
      if (!gate.admit(sid, now)) {
        stats.rate_dropped++;
        return;
      }
      stats.accepted++;
      deps.sink.onFrame(session, { ...parsed.frame, source, received_ms: now });
    });

    socket.on("close", (code: number) => {
      gate.forget(sid);
      const org_id = deps.sessions.get(sid)?.org_id;
      log.info({ source, code, ...(org_id ? { org_id } : {}), ...stats, latency_ms: Date.now() - opened }, "frames: disconnected");
    });
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

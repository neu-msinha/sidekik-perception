import {
  eventLogger,
  STREAMS,
  type AgentCommand,
  type Bus,
  type DomEvent,
  type Envelope,
  type Logger,
} from "@sidekik/contracts";
import type { Session, SessionRegistry } from "./sessions.js";

/** Extension points for the frame pipeline. Each runs after the session registry has been updated. */
export type PerceptionHooks = {
  /** Off-record switched on or off for a live session. */
  onOffRecord?(session: Session, on: boolean): Promise<void>;
  /** Session ended: flush and free everything held for it. */
  onEnded?(session: Session): Promise<void>;
  /** A DOM event for an on-record session. */
  onDom?(session: Session, ev: Envelope<DomEvent>): Promise<void>;
  /** Brain asked a question (keyframes are kept ±5 s around it). */
  onAsk?(session: Session, ev: Envelope<Extract<AgentCommand, { type: "ask" }>>): Promise<void>;
};

/** Subscribes perception to lifecycle, DOM events and agent commands. Returns a function that stops all consumers. */
export function wireConsumers(bus: Bus, sessions: SessionRegistry, log: Logger, hooks: PerceptionHooks = {}): () => void {
  const stops = [
    bus.consume(STREAMS.lifecycle, async (ev) => {
      const elog = eventLogger(log, ev);
      const out = sessions.applyLifecycle(ev);
      switch (out.kind) {
        case "created":
          elog.info({ kind: out.session.kind, mode: out.session.mode, phase: out.session.phase }, "session started");
          break;
        case "updated":
          elog.info({ event: ev.data.event, phase: out.session.phase, off_record: out.session.offRecord }, "session updated");
          if (out.offRecordChanged) await hooks.onOffRecord?.(out.session, out.session.offRecord);
          break;
        case "ended":
          elog.info("session ended");
          await hooks.onEnded?.(out.session);
          break;
        case "ignored_replay":
          elog.debug({ event: ev.data.event }, "replay session, ignored");
          break;
        case "unknown_session":
          elog.debug({ event: ev.data.event }, "lifecycle for unknown session, ignored");
          break;
      }
    }),

    bus.consume(STREAMS.dom, async (ev) => {
      const session = sessions.ensure({ session_id: ev.session_id, org_id: ev.org_id });
      if (!session || session.offRecord) return;
      await hooks.onDom?.(session, ev);
    }),

    bus.consume(STREAMS.commands, async (ev) => {
      if (ev.data.type !== "ask") return;
      const session = sessions.get(ev.session_id);
      if (!session || session.offRecord) return;
      await hooks.onAsk?.(session, ev as Envelope<Extract<AgentCommand, { type: "ask" }>>);
    }),
  ];
  return () => stops.forEach((stop) => stop());
}

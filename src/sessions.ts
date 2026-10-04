import type { Envelope, Phase, SessionKind, SessionLifecycle, SessionMode } from "@sidekik/contracts";

/** What perception knows about a live session. Frame pipelines hang their per-session state off this. */
export type Session = {
  session_id: string;
  org_id: string;
  kind: SessionKind;
  mode: SessionMode;
  phase: Phase;
  language: string;
  /** While on, no frame or DOM event is processed and nothing is kept in memory. */
  offRecord: boolean;
};

export type LifecycleOutcome =
  | { kind: "created"; session: Session }
  | { kind: "updated"; session: Session; offRecordChanged: boolean }
  | { kind: "ended"; session: Session }
  | { kind: "ignored_replay" }
  | { kind: "unknown_session" };

/**
 * Per-session state, keyed by session_id. One perception instance serves a session (the frames
 * socket is sticky), so memory is enough. Sessions started with `mode: "replay"` are ignored for good.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly replaySessions = new Set<string>();
  /** Ended sessions stay ended: a late frame or DOM event must not bring one back. */
  private readonly endedSessions = new Set<string>();

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  get size(): number {
    return this.sessions.size;
  }

  isIgnored(sessionId: string): boolean {
    return this.replaySessions.has(sessionId) || this.endedSessions.has(sessionId);
  }

  /**
   * Session for a frame or DOM event that arrived before its lifecycle `started` (or after a restart).
   * Returns undefined for replay and ended sessions.
   */
  ensure(init: { session_id: string; org_id: string; kind?: SessionKind }): Session | undefined {
    if (this.isIgnored(init.session_id)) return undefined;
    let s = this.sessions.get(init.session_id);
    if (!s) {
      s = {
        session_id: init.session_id,
        org_id: init.org_id,
        kind: init.kind ?? "capture",
        mode: "browser",
        phase: init.kind === "tutor" ? "tutoring" : "capture",
        language: "en",
        offRecord: false,
      };
      this.sessions.set(s.session_id, s);
    }
    return s;
  }

  applyLifecycle(ev: Envelope<SessionLifecycle>): LifecycleOutcome {
    const d = ev.data;
    if (this.replaySessions.has(ev.session_id)) return { kind: "ignored_replay" };
    if (this.endedSessions.has(ev.session_id)) return { kind: "unknown_session" };
    if (d.mode === "replay") {
      this.replaySessions.add(ev.session_id);
      this.sessions.delete(ev.session_id);
      return { kind: "ignored_replay" };
    }

    let s = this.sessions.get(ev.session_id);
    if (d.event === "ended") {
      this.endedSessions.add(ev.session_id);
      if (!s) return { kind: "unknown_session" };
      this.sessions.delete(ev.session_id);
      return { kind: "ended", session: s };
    }

    // Any lifecycle event can create the session: perception may have restarted mid-session.
    const created = !s;
    if (!s) {
      s = { session_id: ev.session_id, org_id: ev.org_id, kind: d.kind, mode: d.mode, phase: d.phase, language: d.language, offRecord: false };
      this.sessions.set(s.session_id, s);
    } else {
      Object.assign(s, { org_id: ev.org_id, kind: d.kind, mode: d.mode, phase: d.phase, language: d.language });
    }

    const wasOff = s.offRecord;
    if (d.event === "offrecord_on") s.offRecord = true;
    if (d.event === "offrecord_off") s.offRecord = false;
    if (created && d.event === "started") return { kind: "created", session: s };
    return { kind: "updated", session: s, offRecordChanged: wasOff !== s.offRecord };
  }
}

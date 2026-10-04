import {
  EVENT_TYPES,
  makeEvent,
  newId,
  redact,
  sessionLogger,
  STREAMS,
  type Bus,
  type Logger,
  type ScreenEvent,
  type UsageRecord,
} from "@sidekik/contracts";
import type { Session } from "./sessions.js";
import type { TrackedEvent } from "./state.js";
import type { PerceptionStore, ScreenEventRow } from "./store.js";

export type Presidio = { analyzerUrl: string; anonymizerUrl: string };

export type PublishedEvent = { event: ScreenEvent; t_ms: number; tracked: TrackedEvent };

/** Persists and publishes perception's output: screen.events, ctx commands and usage records. */
export class Publisher {
  /** Last screen text and its redaction, per session: the same text isn't sent to Presidio twice. */
  private readonly redacted = new Map<string, { raw: string; text: string | undefined }>();

  constructor(
    private readonly deps: { bus: Bus; store: PerceptionStore; log: Logger; presidio?: Presidio },
  ) {}

  /** One envelope per event; the ScreenEvent's event_id is the envelope id (screen_events.event_id). */
  async screenEvents(session: Session, tracked: TrackedEvent[]): Promise<PublishedEvent[]> {
    if (tracked.length === 0) return [];
    const log = sessionLogger(this.deps.log, session);
    const out: PublishedEvent[] = [];
    for (const t of tracked) {
      const id = newId();
      const keep = t.state.record?.supplier ? [t.state.record.supplier] : [];
      const text = t.untrusted_screen_text ? await this.redactText(session, t.untrusted_screen_text, keep) : undefined;
      const event: ScreenEvent = {
        event_id: id,
        type: t.type,
        ...(t.entity ? { entity: t.entity } : {}),
        ...(t.field !== undefined ? { field: t.field } : {}),
        ...(t.before !== undefined ? { before: t.before } : {}),
        ...(t.after !== undefined ? { after: t.after } : {}),
        state: t.state,
        confidence: t.confidence,
        source: t.source,
        ...(text ? { untrusted_screen_text: text } : {}),
      };
      out.push({ event, t_ms: t.t_ms, tracked: t });
    }

    const rows: ScreenEventRow[] = out.map(({ event, t_ms, tracked }) => ({
      org_id: session.org_id,
      session_id: session.session_id,
      event_id: event.event_id,
      t_ms,
      type: event.type,
      entity_kind: event.entity?.kind ?? null,
      entity_id: event.entity?.id ?? null,
      field: event.field ?? null,
      before_val: event.before ?? null,
      after_val: event.after ?? null,
      state: event.state,
      bbox: tracked.bbox ?? null,
      confidence: event.confidence,
      source: event.source,
    }));

    // The row and the bus event go out together; neither waits for the other.
    const started = Date.now();
    await Promise.all([
      this.deps.store.insertScreenEvents(rows).catch((err: unknown) => log.error({ err, events: rows.length }, "screen_events insert failed")),
      ...out.map(({ event, t_ms }) =>
        this.deps.bus
          .publish(
            STREAMS.screen,
            makeEvent({ id: event.event_id, type: EVENT_TYPES[STREAMS.screen], org_id: session.org_id, session_id: session.session_id, t_ms, producer: "perception", data: event }),
          )
          .catch((err: unknown) => log.error({ err, event_id: event.event_id }, "screen.event publish failed")),
      ),
    ]);
    for (const { event, t_ms } of out) {
      log.info(
        { event_id: event.event_id, t_ms, type: event.type, field: event.field, before: event.before, after: event.after, source: event.source, latency_ms: Date.now() - started },
        "screen.event",
      );
    }
    return out;
  }

  async ctx(session: Session, text: string, t_ms: number): Promise<void> {
    const ev = makeEvent({
      type: EVENT_TYPES[STREAMS.commands],
      org_id: session.org_id,
      session_id: session.session_id,
      t_ms,
      producer: "perception",
      data: { type: "ctx" as const, text },
    });
    await this.deps.bus.publish(STREAMS.commands, ev);
    sessionLogger(this.deps.log, session).info({ event_id: ev.id, t_ms, text }, "ctx");
  }

  async usage(session: Session, t_ms: number, records: UsageRecord[]): Promise<void> {
    for (const data of records) {
      if (data.units === 0) continue;
      await this.deps.bus
        .publish(STREAMS.usage, makeEvent({ type: EVENT_TYPES[STREAMS.usage], org_id: session.org_id, session_id: session.session_id, t_ms, producer: "perception", data }))
        .catch((err: unknown) => sessionLogger(this.deps.log, session).error({ err }, "usage publish failed"));
    }
  }

  forget(sessionId: string): void {
    this.redacted.delete(sessionId);
  }

  /**
   * Screen text goes through Presidio, keeping the supplier on screen. Fails closed: without Presidio,
   * or when it errors, the text is dropped rather than published unredacted.
   */
  private async redactText(session: Session, raw: string, keep: string[]): Promise<string | undefined> {
    const cached = this.redacted.get(session.session_id);
    if (cached?.raw === raw) return cached.text;
    let text: string | undefined;
    if (this.deps.presidio) {
      try {
        text = (await redact(raw, session.language, { analyzerUrl: this.deps.presidio.analyzerUrl, anonymizerUrl: this.deps.presidio.anonymizerUrl, keep })).text;
      } catch (err) {
        sessionLogger(this.deps.log, session).warn({ err }, "screen text redaction failed, dropping the text");
      }
    }
    this.redacted.set(session.session_id, { raw, text });
    return text;
  }
}

import {
  createLogger,
  EVENT_TYPES,
  makeEvent,
  type Bus,
  type Envelope,
  type EventHandler,
  type ServiceName,
  type StreamKey,
  type StreamPayload,
} from "@sidekik/contracts";

export const ORG = "00000000-0000-4000-8000-000000000001";
export const SID = "00000000-0000-4000-8000-0000000000a1";
export const SECRET = "test-session-secret-123456";
export const INTERNAL = "test-internal-token-1234";

export const silentLogger = () => createLogger("perception", { level: "silent" });

export function ev<K extends StreamKey>(
  stream: K,
  t_ms: number,
  data: StreamPayload<K>,
  session_id = SID,
  producer: ServiceName = "gateway",
): Envelope<StreamPayload<K>> {
  return makeEvent({ type: EVENT_TYPES[stream], org_id: ORG, session_id, t_ms, producer, data });
}

export const started = (mode: "browser" | "meeting" | "replay" = "browser", session_id = SID) =>
  ev("sk:session.lifecycle", 0, { event: "started", kind: "capture", phase: "capture", workflow_id: "wf-1", mode, language: "de" }, session_id);

export const lifecycle = (event: "offrecord_on" | "offrecord_off" | "ended" | "task_done", t_ms = 1000, session_id = SID) =>
  ev("sk:session.lifecycle", t_ms, { event, kind: "capture", phase: "capture", workflow_id: "wf-1", mode: "browser", language: "de" }, session_id);

/** In-memory Bus: `deliver` calls the registered handler directly, in order. */
export class FakeBus implements Bus {
  readonly published: { stream: StreamKey; ev: Envelope<unknown> }[] = [];
  private readonly handlers = new Map<StreamKey, EventHandler<StreamKey>>();

  async publish<K extends StreamKey>(stream: K, e: Envelope<StreamPayload<K>>): Promise<string> {
    this.published.push({ stream, ev: e });
    return `${this.published.length}-0`;
  }

  consume<K extends StreamKey>(stream: K, handler: EventHandler<K>): () => void {
    this.handlers.set(stream, handler as unknown as EventHandler<StreamKey>);
    return () => this.handlers.delete(stream);
  }

  async deliver<K extends StreamKey>(stream: K, e: Envelope<StreamPayload<K>>): Promise<void> {
    const h = this.handlers.get(stream);
    if (!h) throw new Error(`no consumer for ${stream}`);
    await h(e as Envelope<StreamPayload<StreamKey>>);
  }

  of<K extends StreamKey>(stream: K): Envelope<StreamPayload<K>>[] {
    return this.published.filter((p) => p.stream === stream).map((p) => p.ev as Envelope<StreamPayload<K>>);
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}

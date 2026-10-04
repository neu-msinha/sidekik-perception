import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { newId, type Bus, type StreamKey, STREAMS } from "@sidekik/contracts";

/** One fixture line: the stream and the envelope that was published on it. */
export type FixtureLine = { stream: StreamKey; ev: { session_id: string; t_ms: number; id: string; ts: string } & Record<string, unknown> };

const KNOWN_STREAMS = new Set<string>(Object.values(STREAMS));

export function readFixture(path: string): FixtureLine[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l, i) => {
      const line = JSON.parse(l) as FixtureLine;
      if (!KNOWN_STREAMS.has(line.stream)) throw new Error(`${path}:${i + 1}: unknown stream ${line.stream}`);
      return line;
    });
}

/**
 * Publishes fixture events in t_ms order. Each run gets fresh session ids (UUIDs, so rows can be written) and event
 * ids, so bus de-duplication never swallows a second replay of the same file.
 * Returns the fixture session id → replay session id map.
 */
export async function replayFixture(
  bus: Bus,
  lines: FixtureLine[],
  opts: { speed?: number } = {},
): Promise<Map<string, string>> {
  const speed = opts.speed ?? 1;
  const sessions = new Map<string, string>();
  const sorted = [...lines].sort((a, b) => a.ev.t_ms - b.ev.t_ms);
  let prevT = sorted[0]?.ev.t_ms ?? 0;

  for (const line of sorted) {
    const waitMs = (line.ev.t_ms - prevT) / speed;
    if (Number.isFinite(waitMs) && waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    prevT = line.ev.t_ms;

    let sid = sessions.get(line.ev.session_id);
    if (!sid) {
      sid = randomUUID();
      sessions.set(line.ev.session_id, sid);
    }
    const ev = { ...line.ev, id: newId(), session_id: sid, ts: new Date().toISOString() };
    await bus.publish(line.stream, ev as Parameters<Bus["publish"]>[1]);
  }
  return sessions;
}

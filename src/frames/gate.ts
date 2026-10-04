/** DESIGN §2: at most 2 fps per session; anything faster is dropped. */
export const MIN_FRAME_INTERVAL_MS = 500;
/** Network jitter allowance, so a sender pacing at exactly 2 fps isn't dropped for arriving a little early. */
const JITTER_MS = 50;

/** Per-session frame rate cap on arrival time. */
export class FrameGate {
  private readonly last = new Map<string, number>();

  constructor(private readonly minIntervalMs = MIN_FRAME_INTERVAL_MS - JITTER_MS) {}

  /** True when a frame arriving at `nowMs` for this session may pass. */
  admit(sessionId: string, nowMs = Date.now()): boolean {
    const prev = this.last.get(sessionId);
    if (prev !== undefined && nowMs - prev < this.minIntervalMs) return false;
    this.last.set(sessionId, nowMs);
    return true;
  }

  forget(sessionId: string): void {
    this.last.delete(sessionId);
  }
}

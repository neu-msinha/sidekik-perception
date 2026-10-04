/**
 * `ctx` agent commands (DESIGN §2, §4): terse context lines for the agent, never read aloud.
 * At most one every 5 s and at most 400 characters, e.g.
 *   03:12 invoice 4471 | cost_center 4711→0400 | net €6,350 | supplier Präzisionswerk Ulm | focus: asset_number
 */
import type { ScreenState } from "@sidekik/contracts";
import { RECORD_FIELDS, type TrackedEvent } from "./state.js";

const RECORD = new Set<string>(RECORD_FIELDS);

export const CTX_EVERY_MS = 5_000;
export const CTX_MAX_CHARS = 400;

export function clock(t_ms: number): string {
  const s = Math.max(0, Math.floor(t_ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function money(amount: number, currency?: string): string {
  const symbol = currency === undefined || currency === "EUR" ? "€" : currency === "USD" ? "$" : `${currency} `;
  return `${symbol}${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/**
 * Builds one ctx line from the changes since the last one and the current state. The line goes to
 * the voice agent (a third party), so only invoice record values appear in it; other fields (approver,
 * comments) can hold names and are only named as changed. Changes to an earlier record are dropped.
 */
export function formatCtx(t_ms: number, events: TrackedEvent[], state: ScreenState): string {
  const r = state.record ?? {};
  events = events.filter((e) => !e.entity || !r.invoice_id || e.entity.id === r.invoice_id);
  const head = `${clock(t_ms)}${r.invoice_id ? ` invoice ${r.invoice_id}` : state.screen ? ` ${state.screen}` : ""}`;

  // Most important first, so truncation drops the least useful parts.
  const parts: string[] = [];
  const changes = new Map<string, { before?: string; after?: string }>();
  for (const e of events) {
    if (e.type === "field_changed" && e.field) {
      const prev = changes.get(e.field);
      changes.set(e.field, { ...(prev?.before !== undefined ? { before: prev.before } : e.before !== undefined ? { before: e.before } : {}), ...(e.after !== undefined ? { after: e.after } : {}) });
    } else if (e.type === "record_opened") {
      parts.push("opened");
    } else if (e.type === "button_clicked") {
      parts.push(`clicked ${e.field ?? e.after ?? "button"}`);
    } else if (e.type === "dialog") {
      parts.push("dialog open");
    } else if (e.type === "navigation" && e.after) {
      parts.push(`screen ${e.after}`);
    }
  }
  for (const [field, c] of changes) {
    if (!RECORD.has(field)) parts.push(`${field} changed`);
    else parts.push(c.before !== undefined ? `${field} ${c.before}→${c.after ?? "∅"}` : `${field} →${c.after ?? "∅"}`);
  }
  if (r.net_amount !== undefined) parts.push(`net ${money(r.net_amount, r.currency)}`);
  if (r.supplier) parts.push(`supplier ${r.supplier}`);
  if (r.cost_center && !changes.has("cost_center")) parts.push(`cost_center ${r.cost_center}`);
  if (state.focused_field) parts.push(`focus: ${state.focused_field}`);

  let line = [head, ...dedupe(parts)].join(" | ");
  while (line.length > CTX_MAX_CHARS && parts.length > 0) {
    parts.pop();
    line = [head, ...dedupe(parts)].join(" | ");
  }
  return line.replace(/\s+/g, " ").slice(0, CTX_MAX_CHARS);
}

function dedupe(parts: string[]): string[] {
  return [...new Set(parts)];
}

export type CtxSend = (text: string, t_ms: number) => Promise<void>;

/**
 * Collects screen events and sends at most one ctx line every 5 s: the first change goes out at once,
 * later ones are batched into one line when the 5 s window ends. Typing and idle events don't count.
 */
export class CtxBatcher {
  private batch: TrackedEvent[] = [];
  private lastSentWall = -Infinity;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private latestState: ScreenState = {};
  private latestT = 0;

  constructor(
    private readonly send: CtxSend,
    private readonly now: () => number = Date.now,
    private readonly everyMs = CTX_EVERY_MS,
  ) {}

  add(events: TrackedEvent[]): void {
    const relevant = events.filter((e) => e.type !== "typing_in_progress" && e.type !== "idle" && e.type !== "value_read");
    if (relevant.length === 0) return;
    this.batch.push(...relevant);
    const last = relevant[relevant.length - 1]!;
    this.latestState = last.state;
    this.latestT = Math.max(this.latestT, last.t_ms);
    const wait = this.lastSentWall + this.everyMs - this.now();
    if (wait <= 0) void this.flush();
    else this.timer ??= setTimeout(() => void this.flush(), wait);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.batch.length === 0) return;
    const events = this.batch;
    this.batch = [];
    this.lastSentWall = this.now();
    await this.send(formatCtx(this.latestT, events, this.latestState), this.latestT);
  }

  /** Drops anything batched (off-record, session end). */
  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.batch = [];
  }
}

/**
 * Per-session screen state (DESIGN §3): merges vision readings and DOM events into one ScreenState and
 * turns the differences into ScreenEvents.
 *
 * - **One event per real change.** Values are compared in canonical form (normalize.ts), so a DOM
 *   `6350` and a vision `6.350,00 €` are the same value, and a change seen by both is reported once.
 * - **DOM wins.** A DOM value for a field overrides vision for that field for 10 s.
 * - **Typing.** A vision change to the focused field is held until it settles (1 s without growth, focus
 *   moving away, a blur/save/nav frame, or the DOM change), so "4711 → 04 → 0400" is one field_changed.
 *   While the value grows, `typing_in_progress` goes out instead (a value that grew within the last 2 s).
 */
import type { DomEvent, InvoiceState, ScreenEventType, ScreenState } from "@sidekik/contracts";
import type { Rect } from "./diff.js";
import { canonicalValue, normalizeRecord } from "./normalize.js";
import { toFrameBBox, type VisionImage } from "./vision/image.js";
import type { VisionOutput, VisionState } from "./vision/schema.js";

export const DOM_WINS_MS = 10_000;
export const TYPING_WINDOW_MS = 2_000;
export const SETTLE_MS = 1_000;
/** typing_in_progress at most this often per field. */
export const TYPING_EVERY_MS = 1_000;
/** A DOM and a vision report of the same change within this window are one event. */
export const SAME_CHANGE_MS = 10_000;
/** Confidence for a state difference the model didn't also report as an event. */
const STATE_DIFF_CONFIDENCE = 0.85;

/** InvoiceState fields read off the screen (invoice_month is derived from the date). */
export const RECORD_FIELDS = [
  "invoice_id",
  "supplier",
  "net_amount",
  "currency",
  "invoice_date",
  "company_code",
  "category",
  "cost_center",
  "asset_number",
] as const;
type RecordField = (typeof RECORD_FIELDS)[number];
const isRecordField = (f: string): f is RecordField => (RECORD_FIELDS as readonly string[]).includes(f);

/** A ScreenEvent before it gets its id (the envelope id) and keyframe. */
export type TrackedEvent = {
  type: ScreenEventType;
  t_ms: number;
  entity?: { kind: string; id: string };
  field?: string;
  before?: string;
  after?: string;
  confidence: number;
  source: "vision" | "dom";
  /** Where on the frame (frame pixels), when vision said. Stored in screen_events.bbox; drives keyframe redaction. */
  bbox?: Rect;
  untrusted_screen_text?: string;
  state: ScreenState;
};

export type VisionContext = {
  t_ms: number;
  reason: "tick" | "blur" | "save" | "nav";
  image: VisionImage;
  lang: string;
};

type Pending = { before?: string; after: string; lastT: number; confidence: number; bbox?: Rect };

export class ScreenTracker {
  private state: ScreenState = {};
  private readonly domTruth = new Map<string, { value: string; until: number }>();
  private readonly pending = new Map<RecordField, Pending>();
  /** Last value seen per field and when it changed, for typing detection. */
  private readonly observed = new Map<string, { value: string; t: number }>();
  private readonly lastTyping = new Map<string, number>();
  private readonly lastCommitted = new Map<string, { after: string; t: number }>();
  /** Fields outside the invoice record, from model field_changed events. */
  private readonly otherFields = new Map<string, string>();

  constructor(private readonly lang = "en") {}

  get current(): ScreenState {
    return clone(this.state);
  }

  /** PREVIOUS_STATE for the next vision call: the merged state, DOM truth included, as screen strings. */
  previousForVision(): VisionState {
    const r = this.state.record;
    const str = (f: RecordField) => {
      const v = r ? fieldString(r, f) : undefined;
      return v ?? null;
    };
    return {
      app: this.state.app ?? null,
      screen: this.state.screen ?? null,
      record: r ? Object.fromEntries(RECORD_FIELDS.map((f) => [f, str(f)])) as VisionState["record"] : null,
      focused_field: this.state.focused_field ?? null,
    };
  }

  /** Merges one vision reading. */
  applyVision(out: VisionOutput, ctx: VisionContext): TrackedEvent[] {
    const t = ctx.t_ms;
    const events: TrackedEvent[] = [];
    const text = out.untrusted_screen_text.trim().slice(0, 300) || undefined;
    const confidenceOf = (field: string) => {
      const evs = out.events.filter((e) => e.field === field);
      return evs.length ? Math.min(...evs.map((e) => clamp01(e.confidence))) : STATE_DIFF_CONFIDENCE;
    };
    const bboxOf = (field: string) => {
      const e = out.events.find((x) => x.field === field && x.bbox);
      return e ? toFrameBBox(e.bbox, ctx.image) : undefined;
    };
    const emit = (e: Omit<TrackedEvent, "state" | "source" | "untrusted_screen_text">) =>
      events.push({ ...e, source: "vision", ...(text ? { untrusted_screen_text: text } : {}), state: clone(this.state) });

    // App and screen.
    const app = out.state.app?.trim();
    if (app && app !== this.state.app) {
      const before = this.state.app;
      this.state.app = app;
      emit({ type: "app_opened", t_ms: t, after: app, ...(before ? { before } : {}), confidence: STATE_DIFF_CONFIDENCE });
    }
    const screen = out.state.screen?.trim();
    if (screen && screen !== this.state.screen) {
      const before = this.state.screen;
      this.state.screen = screen;
      if (before) emit({ type: "navigation", t_ms: t, before, after: screen, confidence: STATE_DIFF_CONFIDENCE });
    }

    // The record.
    const seen = out.state.record ? normalizeRecord(out.state.record, ctx.lang) : {};
    const record = (this.state.record ??= {});
    if (seen.invoice_id && seen.invoice_id !== record.invoice_id) {
      const before = record.invoice_id;
      this.openRecord(seen, t);
      emit({
        type: "record_opened",
        t_ms: t,
        entity: { kind: "invoice", id: seen.invoice_id },
        ...(before ? { before } : {}),
        after: seen.invoice_id,
        confidence: confidenceOf("invoice_id"),
      });
    } else {
      for (const f of RECORD_FIELDS) {
        if (f === "invoice_id") continue;
        const value = seen[f] === undefined ? undefined : fieldString(seen, f);
        if (value === undefined || this.domWins(f, t)) continue;
        this.observeVision(f, value, t, ctx, confidenceOf(f), bboxOf(f), events, text);
      }
    }

    // After the fields, so an edit finished in this frame is judged with the focus it had.
    if (out.state.focused_field !== null) this.setFocus(out.state.focused_field || undefined, events);

    // Events the state can't express: buttons, dialogs, values read, fields outside the record.
    for (const e of out.events) {
      const entity = e.entity ?? this.entity();
      const base = {
        t_ms: t,
        ...(entity ? { entity } : {}),
        ...(e.field ? { field: e.field } : {}),
        confidence: clamp01(e.confidence),
        ...(e.bbox && toFrameBBox(e.bbox, ctx.image) ? { bbox: toFrameBBox(e.bbox, ctx.image)! } : {}),
      };
      const before = e.field ? canonicalValue(e.field, e.before, ctx.lang) : e.before?.trim() || undefined;
      const after = e.field ? canonicalValue(e.field, e.after, ctx.lang) : e.after?.trim() || e.ui_label?.trim() || undefined;
      if (e.type === "button_clicked" || e.type === "dialog" || e.type === "value_read") {
        emit({ ...base, type: e.type, ...(before ? { before } : {}), ...(after ? { after } : {}), ...(e.ui_label && !e.field ? { field: e.ui_label } : {}) });
      } else if (e.type === "field_changed" && e.field && !isRecordField(e.field) && after !== undefined && this.otherFields.get(e.field) !== after) {
        this.otherFields.set(e.field, after);
        emit({ ...base, type: "field_changed", ...(before ? { before } : {}), after });
      }
    }

    // A blur, save or navigation frame means editing stopped.
    if (ctx.reason !== "tick") this.commitAll(events, text);
    return events;
  }

  /** Merges one DOM event (trusted for field values). */
  applyDom(ev: DomEvent, t: number): TrackedEvent[] {
    const events: TrackedEvent[] = [];
    const emit = (e: Omit<TrackedEvent, "state" | "source" | "confidence">) => events.push({ ...e, source: "dom", confidence: 1, state: clone(this.state) });

    switch (ev.kind) {
      case "record_open": {
        const id = ev.state?.invoice_id ?? ev.record?.id;
        const before = this.state.record?.invoice_id;
        const merged: InvoiceState = { ...(ev.state ?? {}), ...(id ? { invoice_id: id } : {}) };
        if (id && id !== before) {
          this.openRecord(merged, t);
          this.markDom(merged, t);
          emit({ type: "record_opened", t_ms: t, entity: { kind: ev.record?.kind ?? "invoice", id }, ...(before ? { before } : {}), after: id });
        } else {
          // Vision saw this record first: take the DOM's values without a second record_opened.
          this.state.record = { ...(this.state.record ?? {}), ...merged };
          this.markDom(merged, t);
        }
        break;
      }
      case "field_focus":
        this.setFocus(ev.field, events);
        break;
      case "field_change": {
        const f = ev.field;
        if (!f) break;
        if (ev.state) this.state.record = { ...(this.state.record ?? {}), ...ev.state };
        const after = canonicalValue(f, ev.after, this.lang) ?? "";
        this.domTruth.set(f, { value: after, until: t + DOM_WINS_MS });
        const held = isRecordField(f) ? this.pending.get(f) : undefined;
        if (isRecordField(f)) this.pending.delete(f);
        const record = (this.state.record ??= {});
        const current = isRecordField(f) ? fieldString(record, f) : this.otherFields.get(f);
        const before = canonicalValue(f, ev.before, this.lang) ?? held?.before ?? (held ? undefined : current);
        if (isRecordField(f)) setField(record, f, after, this.lang);
        else this.otherFields.set(f, after);
        this.observed.set(f, { value: after, t });
        if (this.recentlyCommitted(f, after, t) || (!held && before === after)) break;
        this.lastCommitted.set(f, { after, t });
        const entity = this.entity();
        emit({ type: "field_changed", t_ms: t, ...(entity ? { entity } : {}), field: f, ...(before !== undefined ? { before } : {}), after });
        break;
      }
      case "save_attempt": {
        this.commitAll(events);
        const entity = ev.record ?? this.entity();
        emit({ type: "button_clicked", t_ms: t, ...(entity ? { entity } : {}), field: "save", after: "save" });
        break;
      }
    }
    return events;
  }

  /** Commits held edits that have settled. Call on a timer (and before reading the state for ctx). */
  tick(t: number): TrackedEvent[] {
    const events: TrackedEvent[] = [];
    for (const [f, p] of [...this.pending]) if (t - p.lastT >= SETTLE_MS) this.commit(f, p, events);
    return events;
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  // ------------------------------------------------------------------ internals

  private observeVision(f: RecordField, value: string, t: number, ctx: VisionContext, confidence: number, bbox: Rect | undefined, events: TrackedEvent[], text?: string): void {
    const record = this.state.record!;
    const prev = this.observed.get(f);
    const grew = prev !== undefined && prev.value !== value && value.length > prev.value.length && t - prev.t <= TYPING_WINDOW_MS;
    if (!prev || prev.value !== value) this.observed.set(f, { value, t });

    const held = this.pending.get(f);
    const committed = held ? held.before : fieldString(record, f);
    if (!held && committed === value) return;
    // A field seen for the first time is a reading, not a change, unless it's the one being edited.
    if (!held && committed === undefined && this.state.focused_field !== f) {
      setField(record, f, value, this.lang);
      return;
    }

    setField(record, f, value, this.lang);
    if (grew && t - (this.lastTyping.get(f) ?? -Infinity) >= TYPING_EVERY_MS) {
      this.lastTyping.set(f, t);
      const entity = this.entity();
      events.push({
        type: "typing_in_progress",
        t_ms: t,
        ...(entity ? { entity } : {}),
        field: f,
        ...(prev ? { before: prev.value } : {}),
        after: value,
        confidence,
        source: "vision",
        ...(bbox ? { bbox } : {}),
        state: clone(this.state),
      });
    }

    // A repeat of the held value doesn't restart the settle clock.
    const lastT = held && held.after === value ? held.lastT : t;
    const keepBox = bbox ?? held?.bbox;
    const p: Pending = { ...(committed !== undefined ? { before: committed } : {}), after: value, lastT, confidence, ...(keepBox ? { bbox: keepBox } : {}) };
    const typing = this.state.focused_field === f && ctx.reason === "tick";
    if (typing) this.pending.set(f, p);
    else this.commit(f, p, events, text);
  }

  private commit(f: RecordField, p: Pending, events: TrackedEvent[], text?: string): void {
    this.pending.delete(f);
    if (p.before === p.after || this.recentlyCommitted(f, p.after, p.lastT)) return;
    this.lastCommitted.set(f, { after: p.after, t: p.lastT });
    const entity = this.entity();
    events.push({
      type: "field_changed",
      t_ms: p.lastT,
      ...(entity ? { entity } : {}),
      field: f,
      ...(p.before !== undefined ? { before: p.before } : {}),
      after: p.after,
      confidence: p.confidence,
      source: "vision",
      ...(p.bbox ? { bbox: p.bbox } : {}),
      ...(text ? { untrusted_screen_text: text } : {}),
      state: clone(this.state),
    });
  }

  private commitAll(events: TrackedEvent[], text?: string): void {
    for (const [f, p] of [...this.pending]) this.commit(f, p, events, text);
  }

  private setFocus(field: string | undefined, events: TrackedEvent[]): void {
    if (field === this.state.focused_field) return;
    // Focus moving away ends the edit of the previously focused field.
    const prev = this.state.focused_field;
    if (prev && isRecordField(prev)) {
      const p = this.pending.get(prev);
      if (p) this.commit(prev, p, events);
    }
    if (field) this.state.focused_field = field;
    else delete this.state.focused_field;
  }

  private openRecord(r: InvoiceState, t: number): void {
    this.state.record = { ...r };
    if (r.invoice_date && r.invoice_month === undefined) {
      const m = Number(r.invoice_date.slice(5, 7));
      if (m >= 1 && m <= 12) this.state.record.invoice_month = m;
    }
    this.pending.clear();
    this.domTruth.clear();
    this.lastCommitted.clear();
    this.otherFields.clear();
    this.observed.clear();
    for (const f of RECORD_FIELDS) {
      const v = fieldString(this.state.record, f);
      if (v !== undefined) this.observed.set(f, { value: v, t });
    }
  }

  private markDom(r: InvoiceState, t: number): void {
    for (const f of RECORD_FIELDS) {
      const v = fieldString(r, f);
      if (v !== undefined) this.domTruth.set(f, { value: v, until: t + DOM_WINS_MS });
    }
  }

  private domWins(f: string, t: number): boolean {
    const d = this.domTruth.get(f);
    return d !== undefined && t < d.until;
  }

  private recentlyCommitted(f: string, after: string, t: number): boolean {
    const c = this.lastCommitted.get(f);
    return c !== undefined && c.after === after && Math.abs(t - c.t) < SAME_CHANGE_MS;
  }

  private entity(): { kind: string; id: string } | undefined {
    const id = this.state.record?.invoice_id;
    return id ? { kind: "invoice", id } : undefined;
  }
}

/** A record field as its canonical string, or undefined when unset. */
export function fieldString(r: InvoiceState, f: RecordField): string | undefined {
  const v = r[f];
  return v === undefined ? undefined : String(v);
}

function setField(r: InvoiceState, f: RecordField, canonical: string, lang: string): void {
  if (f === "net_amount") {
    const n = Number(canonical);
    if (Number.isFinite(n)) r.net_amount = n;
    return;
  }
  r[f] = canonical;
  if (f === "invoice_date") {
    const m = Number(canonicalValue("invoice_date", canonical, lang)?.slice(5, 7));
    if (m >= 1 && m <= 12) r.invoice_month = m;
  }
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

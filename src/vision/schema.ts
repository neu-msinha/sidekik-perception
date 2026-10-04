import { z } from "zod";

/**
 * What the vision model returns (DESIGN §4), as the structured-output schema. Values are strings exactly
 * as they appear on screen ("6.350,00", "03.12.2026"); normalize.ts turns them into InvoiceState.
 * Nullable rather than optional: structured outputs require every key, and null means "not visible".
 */
const Str = z.string().nullable();

export const VISION_EVENT_TYPES = ["app_opened", "record_opened", "field_changed", "button_clicked", "value_read", "navigation", "dialog"] as const;

export const VisionEventSchema = z.object({
  type: z.enum(VISION_EVENT_TYPES),
  entity: z.object({ kind: z.string(), id: z.string() }).nullable(),
  field: Str,
  before: Str,
  after: Str,
  ui_label: Str,
  /** [x, y, width, height] in pixels of the image the model saw. */
  bbox: z.array(z.number()).nullable(),
  confidence: z.number(),
});
export type VisionEvent = z.infer<typeof VisionEventSchema>;

export const VisionRecordSchema = z.object({
  invoice_id: Str,
  supplier: Str,
  net_amount: Str,
  currency: Str,
  invoice_date: Str,
  company_code: Str,
  category: Str,
  cost_center: Str,
  asset_number: Str,
});
export type VisionRecord = z.infer<typeof VisionRecordSchema>;

export const VisionStateSchema = z.object({
  app: Str,
  screen: Str,
  record: VisionRecordSchema.nullable(),
  focused_field: Str,
});
export type VisionState = z.infer<typeof VisionStateSchema>;

export const VisionOutputSchema = z.object({
  events: z.array(VisionEventSchema),
  state: VisionStateSchema,
  untrusted_screen_text: z.string(),
});
export type VisionOutput = z.infer<typeof VisionOutputSchema>;

export const EMPTY_VISION_STATE: VisionState = { app: null, screen: null, record: null, focused_field: null };

/** Fields whose low confidence triggers escalation (DESIGN §4). */
export const NUMERIC_FIELDS = new Set(["net_amount", "cost_center", "invoice_id"]);

/** Lowest confidence the model gave on a numeric field, or undefined when no event touched one. */
export function minNumericConfidence(out: VisionOutput): number | undefined {
  let min: number | undefined;
  for (const e of out.events) {
    if (e.field && NUMERIC_FIELDS.has(e.field)) min = Math.min(min ?? 1, e.confidence);
  }
  return min;
}

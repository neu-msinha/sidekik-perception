import { BaseServiceEnvSchema, loadEnv } from "@sidekik/contracts";
import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const flag = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

export const PerceptionEnvSchema = BaseServiceEnvSchema.extend({
  PORT: z.coerce.number().int().positive().default(8081),
  /** Verifies the browser's `sk_token` on /ws/frames (shared with gateway). */
  SK_SESSION_SECRET: z.string().min(16),
  /** Optional at boot so dev:mock runs without it; the vision client checks for it when created. */
  ANTHROPIC_API_KEY: optional,
  VISION_PRIMARY: z.string().min(1).default("claude-haiku-4-5-20251001"),
  /** Escalation model for low-confidence numeric fields (DESIGN §4). Unset: retry the primary once. */
  VISION_FALLBACK: optional,
  VISION_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  /** Presidio text redaction for untrusted_screen_text. Unset: screen text is dropped, never published raw. */
  PRESIDIO_ANALYZER_URL: optional.pipe(z.url().optional()),
  PRESIDIO_ANONYMIZER_URL: optional.pipe(z.url().optional()),
  /** Presidio image redactor. Unset: keyframes fall back to blurring PII-labeled fields. */
  PRESIDIO_IMAGE_URL: optional.pipe(z.url().optional()),
  /** Where perception's rows and files go: Supabase, or memory + log (dev:mock without a database). */
  PERSISTENCE: z.enum(["supabase", "memory"]).default("supabase"),
  /** Offline vision that reads nothing off the image (dev:mock without a key). Never in production. */
  FAKE_VISION: flag,
});
export type PerceptionEnv = z.infer<typeof PerceptionEnvSchema>;

export function loadPerceptionEnv(source: Record<string, string | undefined> = process.env): PerceptionEnv {
  return loadEnv(PerceptionEnvSchema, source);
}

import { priceUsd, type UsageRecord } from "@sidekik/contracts";

export type TokenUsage = { input_tokens: number; output_tokens: number };

/** PRICE_TABLE keys are model aliases: "claude-haiku-4-5-20251001" is priced as "claude-haiku-4-5". */
export function priceModel(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

/** Two `usage` records for one Claude call (tokens in and out), priced from PRICE_TABLE. */
export function anthropicUsage(model: string, usage: TokenUsage): UsageRecord[] {
  const m = priceModel(model);
  const rec = (unit: "tokens_in" | "tokens_out", units: number): UsageRecord => ({
    service: "perception",
    vendor: "anthropic",
    units,
    unit,
    cost_usd: priceUsd("anthropic", m, unit, units) ?? 0,
  });
  return [rec("tokens_in", usage.input_tokens), rec("tokens_out", usage.output_tokens)];
}

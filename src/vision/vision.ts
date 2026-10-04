import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { TokenUsage } from "../usage.js";
import type { VisionImage } from "./image.js";
import { VISION_PROMPT } from "./prompt.js";
import { minNumericConfidence, VisionOutputSchema, type VisionOutput, type VisionState } from "./schema.js";

/** Below this on a numeric field, a frame is re-run (DESIGN §4). */
export const ESCALATE_BELOW = 0.7;

export type VisionCall = { model: string; usage: TokenUsage; latency_ms: number; ok: boolean };

export type VisionRequest = {
  image: VisionImage;
  /** What vision last reported for this session (PREVIOUS_STATE). */
  previous: VisionState;
  signal?: AbortSignal;
};

export type VisionResult = {
  output: VisionOutput;
  model: string;
  escalated: boolean;
  /** Every call made for this frame, for `usage` records (failed calls that were billed included). */
  calls: VisionCall[];
  latency_ms: number;
};

export class VisionError extends Error {
  override name = "VisionError";
  constructor(
    message: string,
    readonly calls: VisionCall[],
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface Vision {
  /** Reads one frame. Throws VisionError when the frame should be skipped (the next changed frame carries the change). */
  see(req: VisionRequest): Promise<VisionResult>;
}

/** The single model call: one image in, one parsed VisionOutput out. Separate so tests can script it. */
export interface VisionModel {
  call(model: string, req: VisionRequest): Promise<{ output: VisionOutput; usage: TokenUsage }>;
}

export type ClaudeVisionOptions = {
  primary: string;
  /** Escalation model; unset = retry the primary once. */
  fallback?: string;
  model: VisionModel;
};

/**
 * DESIGN §4 policy on top of a VisionModel:
 * - a failed or timed-out call is retried once on the primary, then the frame is skipped;
 * - a numeric field (net_amount, cost_center, invoice_id) read with confidence < 0.7 is re-run once,
 *   on VISION_FALLBACK when set, else on the primary, and the more confident reading wins.
 * At most two calls per frame.
 */
export class ClaudeVision implements Vision {
  constructor(private readonly opts: ClaudeVisionOptions) {}

  async see(req: VisionRequest): Promise<VisionResult> {
    const started = performance.now();
    const calls: VisionCall[] = [];
    const attempt = async (model: string) => {
      const t0 = performance.now();
      try {
        const res = await this.opts.model.call(model, req);
        calls.push({ model, usage: res.usage, latency_ms: Math.round(performance.now() - t0), ok: true });
        return res.output;
      } catch (err) {
        calls.push({ model, usage: usageOf(err), latency_ms: Math.round(performance.now() - t0), ok: false });
        throw err;
      }
    };

    let output: VisionOutput;
    let model = this.opts.primary;
    try {
      output = await attempt(model);
    } catch (first) {
      if (req.signal?.aborted) throw new VisionError("aborted", calls, { cause: first });
      try {
        output = await attempt(model);
      } catch (second) {
        throw new VisionError(`vision failed twice: ${message(second)}`, calls, { cause: second });
      }
      return { output, model, escalated: false, calls, latency_ms: Math.round(performance.now() - started) };
    }

    const conf = minNumericConfidence(output);
    let escalated = false;
    if (conf !== undefined && conf < ESCALATE_BELOW && !req.signal?.aborted) {
      const next = this.opts.fallback ?? this.opts.primary;
      try {
        const second = await attempt(next);
        escalated = next !== this.opts.primary;
        // Keep whichever reading is more confident on the numeric fields.
        if ((minNumericConfidence(second) ?? 1) >= conf) {
          output = second;
          model = next;
        }
      } catch {
        // The first reading stands.
      }
    }
    return { output, model, escalated, calls, latency_ms: Math.round(performance.now() - started) };
  }
}

export type AnthropicVisionModelOptions = { apiKey: string; timeoutMs: number; fetch?: typeof fetch };

/** Messages API with a base64 JPEG image block and a structured-output (zod) JSON response. */
export class AnthropicVisionModel implements VisionModel {
  private readonly client: Anthropic;

  constructor(opts: AnthropicVisionModelOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      timeout: opts.timeoutMs,
      // Retries are ClaudeVision's job (one per frame, inside the latency budget).
      maxRetries: 0,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  async call(model: string, req: VisionRequest): Promise<{ output: VisionOutput; usage: TokenUsage }> {
    const message = await this.client.messages.parse(
      {
        model,
        max_tokens: 2048,
        system: VISION_PROMPT,
        ...modelParams(model),
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: req.image.jpeg.toString("base64") } },
              { type: "text", text: userText(req) },
            ],
          },
        ],
        output_config: { format: zodOutputFormat(VisionOutputSchema) },
      },
      req.signal ? { signal: req.signal } : {},
    );
    const usage = { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens };
    if (message.stop_reason === "refusal") throw new BilledError("model refused", usage);
    if (!message.parsed_output) throw new BilledError(`no parsed output (stop_reason ${message.stop_reason})`, usage);
    return { output: message.parsed_output, usage };
  }
}

/** Sampling and thinking settings each model accepts; extraction wants deterministic, fast answers. */
export function modelParams(model: string): { temperature?: number; thinking?: { type: "between_tools" } } {
  if (model.startsWith("claude-haiku")) return { temperature: 0 };
  // Claude Sonnet 5.5 rejects sampling parameters and disabled thinking; between_tools turns thinking off.
  if (model.startsWith("claude-sonnet-5-5")) return { thinking: { type: "between_tools" } };
  return {};
}

/** PREVIOUS_STATE plus where the image sits in the frame, so bboxes and partial views make sense. */
export function userText(req: VisionRequest): string {
  const { image } = req;
  const full = image.region.width === image.frameWidth && image.region.height === image.frameHeight;
  const view = full
    ? `VIEW: full screen, ${image.width}x${image.height} px.`
    : `VIEW: a cropped part of the screen (x=${image.region.left}, y=${image.region.top}, ${image.region.width}x${image.region.height} of ${image.frameWidth}x${image.frameHeight}), shown at ${image.width}x${image.height} px. Fields outside this view are unchanged: keep their PREVIOUS_STATE values. bbox is in this image's pixels.`;
  return `${view}\nPREVIOUS_STATE: ${JSON.stringify(req.previous)}`;
}

/** An error after the API answered: the tokens were still billed. */
class BilledError extends Error {
  constructor(
    message: string,
    readonly usage: TokenUsage,
  ) {
    super(message);
  }
}

function usageOf(err: unknown): TokenUsage {
  return err instanceof BilledError ? err.usage : { input_tokens: 0, output_tokens: 0 };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

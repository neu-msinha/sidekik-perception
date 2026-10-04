import type { Vision, VisionRequest, VisionResult } from "./vision.js";

/**
 * Offline stand-in for dev:mock without an API key (FAKE_VISION=true). It reads nothing off the
 * image and reports "nothing changed", so DOM events carry the session. Never used in production.
 */
export class FakeVision implements Vision {
  async see(req: VisionRequest): Promise<VisionResult> {
    return {
      output: { events: [], state: req.previous, untrusted_screen_text: "" },
      model: "fake",
      escalated: false,
      calls: [],
      latency_ms: 0,
    };
  }
}

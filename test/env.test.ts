import { describe, expect, it } from "vitest";
import { loadPerceptionEnv } from "../src/env.js";

const BASE = {
  REDIS_URL: "redis://localhost:6379",
  SUPABASE_URL: "http://localhost:54321",
  SUPABASE_SERVICE_ROLE_KEY: "x",
  SK_INTERNAL_TOKEN: "0123456789abcdef",
  SK_SESSION_SECRET: "0123456789abcdef",
};

describe("env", () => {
  it("applies the DESIGN defaults", () => {
    const env = loadPerceptionEnv(BASE);
    expect(env.PORT).toBe(8081);
    expect(env.VISION_PRIMARY).toBe("claude-haiku-4-5-20251001");
    expect(env.VISION_TIMEOUT_MS).toBe(2000);
    expect(env.VISION_FALLBACK).toBeUndefined();
    expect(env.PRESIDIO_IMAGE_URL).toBeUndefined();
    expect(env.PERSISTENCE).toBe("supabase");
    expect(env.FAKE_VISION).toBe(false);
  });

  it("treats empty optional values as unset", () => {
    const env = loadPerceptionEnv({ ...BASE, ANTHROPIC_API_KEY: "", VISION_FALLBACK: "", PRESIDIO_IMAGE_URL: "" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.VISION_FALLBACK).toBeUndefined();
    expect(env.PRESIDIO_IMAGE_URL).toBeUndefined();
  });

  it("lists every bad variable", () => {
    expect(() => loadPerceptionEnv({ ...BASE, SK_SESSION_SECRET: "short", PRESIDIO_IMAGE_URL: "not a url" })).toThrow(
      /SK_SESSION_SECRET[\s\S]*PRESIDIO_IMAGE_URL|PRESIDIO_IMAGE_URL[\s\S]*SK_SESSION_SECRET/,
    );
  });
});

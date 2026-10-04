/**
 * Optional live checks against the shared dev stack. Each block skips unless its URL is set:
 *   TEST_SUPABASE_URL + TEST_SUPABASE_SERVICE_ROLE_KEY   local Supabase (sidekik-platform: supabase start)
 *   TEST_PRESIDIO_IMAGE_URL                              presidio-image-redactor (dev/docker-compose.yml)
 */
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { Keyframer } from "../src/keyframes.js";
import { PresidioImageRedactor } from "../src/redact-image.js";
import type { Session } from "../src/sessions.js";
import { SupabaseStore } from "../src/store.js";
import { invoiceSvg, jpeg } from "./fixtures/screens.js";
import { silentLogger } from "./helpers.js";

const SB_URL = process.env.TEST_SUPABASE_URL;
const SB_KEY = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const IMAGE_URL = process.env.TEST_PRESIDIO_IMAGE_URL;
const ORG = "00000000-0000-4000-8000-000000000001";
const WORKFLOW = "00000000-0000-4000-8000-000000000031";

describe.skipIf(!SB_URL || !SB_KEY)("Supabase (live)", () => {
  it("writes screen_events, uploads a keyframe, links it and signs its URL", async () => {
    const store = new SupabaseStore(SB_URL!, SB_KEY!);
    // A session row (gateway's table) as the fixture the foreign keys need; deleted at the end.
    const sid = randomUUID();
    const { error } = await store.db.from("sessions").insert({ id: sid, org_id: ORG, workflow_id: WORKFLOW, kind: "capture", mode: "browser", phase: "capture" });
    expect(error).toBeNull();
    try {
      const eventId = `01TEST${randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase()}`;
      const row = { org_id: ORG, session_id: sid, event_id: eventId, t_ms: 7200, type: "field_changed", entity_kind: "invoice", entity_id: "4471", field: "cost_center", before_val: "4711", after_val: "0400", state: { record: { cost_center: "0400" } }, bbox: { left: 1, top: 2, width: 3, height: 4 }, confidence: 1, source: "dom" as const };
      await store.insertScreenEvents([row]);
      await store.insertScreenEvents([row]); // idempotent

      const session: Session = { session_id: sid, org_id: ORG, kind: "capture", mode: "browser", phase: "capture", language: "de", offRecord: false };
      const k = new Keyframer(session, { store, redactor: new PresidioImageRedactor({}), log: silentLogger() });
      const frame = { t_ms: 7200, reason: "tick" as const, jpeg: await jpeg(invoiceSvg({ invoice: "4471", amount: "6350", costCenter: "0400" })), source: "browser" as const, received_ms: 0 };
      k.onFrame(frame);
      k.onEvents([{ event: { event_id: eventId, type: "field_changed", state: {}, confidence: 1, source: "dom" }, t_ms: 7200, tracked: { type: "field_changed", t_ms: 7200, confidence: 1, source: "dom", state: {} } }], frame);
      await k.idle();
      expect(k.stats.stored).toBe(1);

      const { data: events } = await store.db.from("screen_events").select("event_id, keyframe_id").eq("session_id", sid);
      expect(events).toHaveLength(1);
      const kf = await store.getKeyframe(events![0]!.keyframe_id as string);
      expect(kf?.storage_path).toBe(`captures/org/${ORG}/sessions/${sid}/keyframes/7200.webp`);
      const url = await store.signedUrl(kf!.storage_path, 300);
      const res = await fetch(url);
      expect(res.ok).toBe(true);
      expect((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).format).toBe("webp");
      expect(await store.storeLearnerKeyframes(ORG)).toBe(false);
    } finally {
      await store.db.storage.from("captures").remove([`org/${ORG}/sessions/${sid}/keyframes/7200.webp`]);
      await store.db.from("sessions").delete().eq("id", sid);
    }
  });
});

describe.skipIf(!IMAGE_URL)("Presidio image redactor (live)", () => {
  it("blacks out names, emails and phones but keeps invoice data", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" font-family="Helvetica, Arial"><rect width="1280" height="720" fill="#fff"/>
      <text x="100" y="150" font-size="28" fill="#111">Rechnung 4471 Kostenstelle 0400</text>
      <text x="100" y="250" font-size="28" fill="#111">Ansprechpartner: Hans Mueller</text>
      <text x="100" y="350" font-size="28" fill="#111">E-Mail: hans.mueller@example.com</text></svg>`;
    const img = await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
    const res = await new PresidioImageRedactor({ url: IMAGE_URL!, timeoutMs: 30_000 }).redact(img, []);
    expect(res.presidio).toBe(true);
    const { data, info } = await sharp(res.image).greyscale().raw().toBuffer({ resolveWithObject: true });
    const dark = (y0: number, y1: number) => {
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = 100; x < 700; x++) if (data[y * info.width + x]! < 40) n++;
      return n / ((y1 - y0) * 600);
    };
    // The name line gets solid black boxes; the invoice line keeps only thin glyph strokes.
    expect(dark(225, 255)).toBeGreaterThan(0.2);
    expect(dark(125, 155)).toBeLessThan(0.2);
  }, 40_000);
});

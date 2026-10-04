import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../src/sessions.js";
import { lifecycle, ORG, SID, started } from "./helpers.js";

describe("SessionRegistry", () => {
  it("creates on started and tracks off-record", () => {
    const r = new SessionRegistry();
    expect(r.applyLifecycle(started()).kind).toBe("created");
    const on = r.applyLifecycle(lifecycle("offrecord_on"));
    expect(on).toMatchObject({ kind: "updated", offRecordChanged: true });
    expect(r.get(SID)?.offRecord).toBe(true);
    expect(r.applyLifecycle(lifecycle("offrecord_on"))).toMatchObject({ offRecordChanged: false });
    expect(r.applyLifecycle(lifecycle("offrecord_off"))).toMatchObject({ offRecordChanged: true });
    expect(r.get(SID)?.offRecord).toBe(false);
  });

  it("frees the session on ended", () => {
    const r = new SessionRegistry();
    r.applyLifecycle(started());
    expect(r.applyLifecycle(lifecycle("ended")).kind).toBe("ended");
    expect(r.get(SID)).toBeUndefined();
    expect(r.applyLifecycle(lifecycle("ended")).kind).toBe("unknown_session");
  });

  it("ignores replay sessions for good", () => {
    const r = new SessionRegistry();
    expect(r.applyLifecycle(started("replay")).kind).toBe("ignored_replay");
    expect(r.applyLifecycle(lifecycle("offrecord_on")).kind).toBe("ignored_replay");
    expect(r.ensure({ session_id: SID, org_id: ORG })).toBeUndefined();
    expect(r.size).toBe(0);
  });

  it("creates a session from any lifecycle event after a restart", () => {
    const r = new SessionRegistry();
    const out = r.applyLifecycle(lifecycle("offrecord_on"));
    expect(out.kind).toBe("updated");
    expect(r.get(SID)).toMatchObject({ org_id: ORG, offRecord: true, language: "de" });
  });

  it("ensure() creates a placeholder for frames that arrive first", () => {
    const r = new SessionRegistry();
    const s = r.ensure({ session_id: SID, org_id: ORG, kind: "tutor" });
    expect(s).toMatchObject({ kind: "tutor", phase: "tutoring", offRecord: false });
    expect(r.applyLifecycle(started()).kind).toBe("updated");
    expect(r.get(SID)?.language).toBe("de");
  });
});

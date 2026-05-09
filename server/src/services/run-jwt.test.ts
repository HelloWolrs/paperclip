import { describe, it, expect } from "vitest";
import { runJwtService } from "./run-jwt.js";

const secret = "0".repeat(32);

describe("runJwtService", () => {
  it("mints and verifies a token", () => {
    const svc = runJwtService(secret);
    const t = svc.mint({ runId: "r-1", agentId: "a-1", companyId: "c-1", jobUid: "j-1", ttlSeconds: 60 });
    const v = svc.verify(t);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.claims.runId).toBe("r-1");
      expect(v.claims.jobUid).toBe("j-1");
    }
  });

  it("rejects a tampered token", () => {
    const svc = runJwtService(secret);
    const t = svc.mint({ runId: "r-1", agentId: "a-1", companyId: "c-1", jobUid: "j-1", ttlSeconds: 60 });
    const tampered = t.slice(0, -2) + "AA";
    const v = svc.verify(tampered);
    expect(v.ok).toBe(false);
  });

  it("rejects an expired token", async () => {
    const svc = runJwtService(secret);
    const t = svc.mint({ runId: "r-1", agentId: "a-1", companyId: "c-1", jobUid: "j-1", ttlSeconds: 0 });
    await new Promise((r) => setTimeout(r, 1100));
    const v = svc.verify(t);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("expired");
  });
});

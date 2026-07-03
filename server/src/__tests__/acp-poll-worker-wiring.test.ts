import { describe, expect, it } from "vitest";
import { extractAcpToken } from "../services/acp-poll-worker-wiring.js";

describe("extractAcpToken", () => {
  it("accepts legacy plaintext string", () => {
    expect(extractAcpToken("abc123")).toEqual({ kind: "token", value: "abc123" });
  });

  it("unwraps {type:'plain',value:string} (BASA-30757 regression)", () => {
    const wrapped = {
      type: "plain",
      value: "2874e041e16a8aaddaa46c82de1944dce2f27449e2b14cd4c0146ead905ff184",
    };
    expect(extractAcpToken(wrapped)).toEqual({
      kind: "token",
      value: wrapped.value,
    });
  });

  it("reports secret_ref (not resolvable from startup discovery)", () => {
    expect(extractAcpToken({ type: "secret_ref", secretId: "s_x" })).toEqual({
      kind: "secret_ref",
    });
  });

  it("reports empty for zero-length string and zero-length plain wrapper", () => {
    expect(extractAcpToken("")).toEqual({ kind: "empty" });
    expect(extractAcpToken({ type: "plain", value: "" })).toEqual({ kind: "empty" });
  });

  it("reports unknown for unrecognized shapes", () => {
    expect(extractAcpToken(null)).toEqual({ kind: "unknown" });
    expect(extractAcpToken(undefined)).toEqual({ kind: "unknown" });
    expect(extractAcpToken(42)).toEqual({ kind: "unknown" });
    expect(extractAcpToken({ type: "plain", value: 42 })).toEqual({ kind: "unknown" });
    expect(extractAcpToken({ type: "other" })).toEqual({ kind: "unknown" });
    expect(extractAcpToken(["abc"])).toEqual({ kind: "unknown" });
  });
});

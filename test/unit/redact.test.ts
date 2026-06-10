import { describe, expect, test } from "bun:test";
import { redact, registerSecret } from "../../src/errors.ts";

describe("redact", () => {
  test("registered secrets are removed wherever they appear", () => {
    registerSecret("super-secret-token-xyz");
    expect(redact("error: super-secret-token-xyz rejected (super-secret-token-xyz)")).toBe(
      "error: [REDACTED] rejected ([REDACTED])",
    );
  });

  test("GitLab PAT shapes are redacted even when never registered", () => {
    // Assembled at runtime so no PAT-shaped literal exists in the repo —
    // GitHub push protection (rightly) cannot distinguish fakes from real ones.
    const fakePat = ["glpat", "AbCd1234efgh5678ijkl"].join("-");
    expect(redact(`header was ${fakePat}`)).toBe("header was [REDACTED]");
  });

  test("empty registration is a no-op", () => {
    registerSecret("");
    expect(redact("plain message")).toBe("plain message");
  });
});

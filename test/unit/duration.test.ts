import { describe, expect, test } from "bun:test";
import { formatDuration, parseDuration } from "../../src/core/duration.ts";
import { UsageError } from "../../src/errors.ts";

describe("parseDuration", () => {
  test("single and compound units", () => {
    expect(parseDuration("45m")).toBe(2700);
    expect(parseDuration("1h30m")).toBe(5400);
    expect(parseDuration("90s")).toBe(90);
  });

  test("GitLab day/week conventions: 1d=8h, 1w=5d", () => {
    expect(parseDuration("1d")).toBe(8 * 3600);
    expect(parseDuration("1w")).toBe(40 * 3600);
    expect(parseDuration("1w2d4h")).toBe((40 + 16 + 4) * 3600);
  });

  test("leading minus negates the whole duration", () => {
    expect(parseDuration("-30m")).toBe(-1800);
    expect(parseDuration("-1h30m")).toBe(-5400);
  });

  test("bare 0 clears", () => {
    expect(parseDuration("0")).toBe(0);
  });

  test("garbage, bare numbers, and trailing junk are rejected", () => {
    for (const bad of ["", "abc", "30", "1h30", "1.5h", "1h 30m", "30m extra", "h", "--30m"]) {
      expect(() => parseDuration(bad)).toThrow(UsageError);
    }
  });
});

describe("formatDuration", () => {
  test("compounds hours/minutes/seconds, skipping zero parts", () => {
    expect(formatDuration(5400)).toBe("1h 30m");
    expect(formatDuration(2700)).toBe("45m");
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(90)).toBe("1m 30s");
    expect(formatDuration(0)).toBe("0m");
  });

  test("stays in hours above a day (no ambiguous d/w units)", () => {
    expect(formatDuration(10 * 3600)).toBe("10h");
  });

  test("negative durations carry the sign", () => {
    expect(formatDuration(-1800)).toBe("-30m");
  });
});

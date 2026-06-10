import { UsageError } from "../errors.ts";

/**
 * Human duration ↔ seconds, using GitLab's time-tracking conventions:
 * 1w = 5d, 1d = 8h. Input like "1h30m", "2d", "45m", "1w2d4h"; a leading
 * "-" negates the whole duration (subtract time spent).
 */
const UNIT_SECONDS: Record<string, number> = {
  w: 5 * 8 * 3600,
  d: 8 * 3600,
  h: 3600,
  m: 60,
  s: 1,
};

export function parseDuration(input: string): number {
  const trimmed = input.trim();
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  if (body === "0") return 0;
  const parts = [...body.matchAll(/(\d+)([wdhms])/g)];
  const matched = parts.map((p) => p[0]).join("");
  if (parts.length === 0 || matched !== body) {
    throw new UsageError(
      `invalid duration "${input}" — use units w/d/h/m/s, e.g. 1h30m, 45m, 2d (1d=8h, 1w=5d), -30m to subtract`,
    );
  }
  const seconds = parts.reduce((sum, p) => sum + Number(p[1]) * UNIT_SECONDS[p[2]!]!, 0);
  return negative ? -seconds : seconds;
}

/** 5400 → "1h 30m"; 0 → "0m". Days/weeks are kept in hours to stay unambiguous. */
export function formatDuration(totalSeconds: number): string {
  const sign = totalSeconds < 0 ? "-" : "";
  let rest = Math.abs(Math.round(totalSeconds));
  const parts: string[] = [];
  const h = Math.floor(rest / 3600);
  rest %= 3600;
  const m = Math.floor(rest / 60);
  const s = rest % 60;
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s) parts.push(`${s}s`);
  if (parts.length === 0) return "0m";
  return sign + parts.join(" ");
}

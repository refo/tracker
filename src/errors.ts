/** Domain failure (lost race, refused claim, not found). CLI exit code 2. */
export class DomainError extends Error {}

/** Bad invocation or environment/config problem. CLI exit code 1. */
export class UsageError extends Error {}

const secrets: string[] = [];

/** Register a secret so it can never appear in output or error messages. */
export function registerSecret(secret: string): void {
  if (secret && !secrets.includes(secret)) secrets.push(secret);
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) {
    while (out.includes(s)) out = out.replace(s, "[REDACTED]");
  }
  // Defense in depth: GitLab PAT shapes, even if never registered.
  out = out.replace(/glpat-[\w-]{10,}/g, "[REDACTED]");
  return out;
}

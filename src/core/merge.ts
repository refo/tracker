import type { MergeAdapter, TrackerAdapter } from "../adapters/types.ts";
import type { ItemId } from "../model/types.ts";
import { type ClaimPolicy, closeItem } from "./claim.ts";

/**
 * "Closes #N" trailers — the provider-neutral link between a PR and the issues
 * it addresses. Written into the PR description on create, parsed back on get.
 * Closing happens explicitly via the issues port (mergeAndCloseIssues): GitLab's
 * native auto-close only fires on default-branch targets, and a GitHub PR can
 * never auto-close a Jira issue, so tracker never relies on provider magic.
 */
export function closesTrailers(issues: ItemId[]): string {
  return issues.map((id) => `Closes #${id}`).join("\n");
}

export function parseClosesIssues(description: string): ItemId[] {
  const ids: ItemId[] = [];
  for (const m of description.matchAll(/^Closes #(\S+)\s*$/gim)) {
    if (!ids.includes(m[1]!)) ids.push(m[1]!);
  }
  return ids;
}

/** Append the trailers block to a description (blank-line separated). */
export function withClosesTrailers(description: string, issues: ItemId[]): string {
  if (issues.length === 0) return description;
  return [description, closesTrailers(issues)].filter(Boolean).join("\n\n");
}

/**
 * Merge the PR, then close every issue its trailers reference via the issues
 * port, leaving a comment on each so a zero-context reader sees why it closed.
 * Closing goes through closeItem so merge-driven closes get the same claim
 * hygiene as `tracker close` — a closed issue must never keep a stale claim.
 */
export async function mergeAndCloseIssues(
  merge: MergeAdapter,
  issues: TrackerAdapter,
  prId: string,
  policy: ClaimPolicy,
): Promise<{ closed: ItemId[] }> {
  const pr = await merge.prGet(prId);
  await merge.prMerge(prId);
  for (const id of pr.closesIssues) {
    await closeItem(issues, id, policy, `closed by merged PR: ${pr.url}`);
  }
  return { closed: pr.closesIssues };
}

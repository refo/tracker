import { describe, expect, test } from "bun:test";
import type { MergeAdapter, TrackerAdapter } from "../../src/adapters/types.ts";
import { type ClaimDeps, RELEASE_MARK, claimItem } from "../../src/core/claim.ts";
import { mergeAndCloseIssues } from "../../src/core/merge.ts";
import type { CiState } from "../../src/model/types.ts";

const POLICY = { inProgressLabel: "status::in-progress", memoryLabel: "meta::memory" };

const fastDeps = (): ClaimDeps => ({
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  randomSuffix: () => "merge-suite",
});

export interface MergeHarness {
  /** Fresh, empty backend exposing both ports plus a CI-state test hook. */
  make(): Promise<{
    merge: MergeAdapter;
    issues: TrackerAdapter;
    setCi(prId: string, state: CiState): void;
  }>;
}

/**
 * The merge-port contract: every scenario must pass for ANY MergeAdapter.
 * Issue closing appears only via the provider-neutral mergeAndCloseIssues —
 * a GitHub PR must be able to close a Jira issue, so no provider magic.
 */
export function runMergeContractSuite(name: string, harness: MergeHarness): void {
  describe(`merge contract: ${name}`, () => {
    test("prCreate → open PR with branches, title, url; ci starts none", async () => {
      const { merge } = await harness.make();
      const pr = await merge.prCreate({
        title: "Add login",
        source: "task/42",
        target: "dev",
        description: "Implements the login flow.",
      });
      expect(pr.id).toBeTruthy();
      expect(pr.state).toBe("open");
      expect(pr.title).toBe("Add login");
      expect(pr.source).toBe("task/42");
      expect(pr.target).toBe("dev");
      expect(pr.draft).toBe(false);
      expect(pr.ci).toBe("none");
      expect(typeof pr.url).toBe("string");
      expect(pr.description).toContain("Implements the login flow.");

      const fetched = await merge.prGet(pr.id);
      expect(fetched.state).toBe("open");
      expect(fetched.title).toBe("Add login");
    });

    test("issues passed to prCreate round-trip via closesIssues trailers", async () => {
      const { merge, issues } = await harness.make();
      const a = await issues.create({ title: "Bug A" });
      const b = await issues.create({ title: "Bug B" });
      const pr = await merge.prCreate({
        title: "Fix A and B",
        source: "task/1",
        target: "dev",
        issues: [a.id, b.id],
      });
      expect(pr.closesIssues.sort()).toEqual([a.id, b.id].sort());
      const fetched = await merge.prGet(pr.id);
      expect(fetched.closesIssues.sort()).toEqual([a.id, b.id].sort());
    });

    test("draft flag round-trips", async () => {
      const { merge } = await harness.make();
      const pr = await merge.prCreate({
        title: "WIP refactor",
        source: "task/7",
        target: "dev",
        draft: true,
      });
      expect(pr.draft).toBe(true);
      expect((await merge.prGet(pr.id)).draft).toBe(true);
    });

    test("ci signal: none → pending → green/red as the pipeline progresses", async () => {
      const { merge, setCi } = await harness.make();
      const pr = await merge.prCreate({ title: "CI watch", source: "t/1", target: "dev" });
      expect((await merge.prGet(pr.id)).ci).toBe("none");
      setCi(pr.id, "pending");
      expect((await merge.prGet(pr.id)).ci).toBe("pending");
      setCi(pr.id, "green");
      expect((await merge.prGet(pr.id)).ci).toBe("green");
      setCi(pr.id, "red");
      expect((await merge.prGet(pr.id)).ci).toBe("red");
    });

    test("pr comments round-trip oldest-first", async () => {
      const { merge } = await harness.make();
      const pr = await merge.prCreate({ title: "Discuss", source: "t/2", target: "dev" });
      await merge.prComment(pr.id, "verification evidence attached");
      await merge.prComment(pr.id, "pipeline green after retry");
      const comments = await merge.prListComments(pr.id);
      expect(comments.map((c) => c.body)).toEqual([
        "verification evidence attached",
        "pipeline green after retry",
      ]);
      expect(comments.every((c) => typeof c.id === "string" && c.createdAt)).toBe(true);
    });

    test("merge: open PR merges; mergeAndCloseIssues closes linked issues explicitly", async () => {
      const { merge, issues } = await harness.make();
      const issue = await issues.create({ title: "Tracked work" });
      const pr = await merge.prCreate({
        title: "Finish tracked work",
        source: "task/9",
        target: "dev",
        issues: [issue.id],
      });

      const { closed } = await mergeAndCloseIssues(merge, issues, pr.id, POLICY);
      expect(closed).toEqual([issue.id]);
      expect((await merge.prGet(pr.id)).state).toBe("merged");
      expect((await issues.get(issue.id)).state).toBe("closed");
      // the issue records WHY it closed, for zero-context readers
      const bodies = (await issues.listComments(issue.id)).map((c) => c.body).join("\n");
      expect(bodies).toContain(pr.url);
    });

    test("merge-driven close clears a claimed issue's claim (label, assignee, token)", async () => {
      const { merge, issues } = await harness.make();
      const issue = await issues.create({ title: "Claimed work" });
      const claim = await claimItem(issues, issue.id, { ...POLICY, settleMs: 5 }, fastDeps());
      expect(claim.ok).toBe(true);
      const pr = await merge.prCreate({
        title: "Land claimed work",
        source: "task/10",
        target: "dev",
        issues: [issue.id],
      });

      await mergeAndCloseIssues(merge, issues, pr.id, POLICY);

      const after = await issues.get(issue.id);
      expect(after.state).toBe("closed");
      expect(after.labels).not.toContain(POLICY.inProgressLabel);
      expect(after.assignees).toEqual([]);
      const bodies = (await issues.listComments(issue.id)).map((c) => c.body);
      expect(bodies.some((b) => b.startsWith(RELEASE_MARK) && b.includes("reason=closed"))).toBe(
        true,
      );
    });

    test("merge-driven close preserves a human assignee when no claim exists", async () => {
      const { merge, issues } = await harness.make();
      const me = await issues.whoami();
      const issue = await issues.create({ title: "Human-assigned work" });
      await issues.update(issue.id, { assigneeIds: [me.id] });
      const pr = await merge.prCreate({
        title: "Land human work",
        source: "task/11",
        target: "dev",
        issues: [issue.id],
      });

      await mergeAndCloseIssues(merge, issues, pr.id, POLICY);

      const after = await issues.get(issue.id);
      expect(after.state).toBe("closed");
      expect(after.assignees.map((a) => a.username)).toEqual([me.username]);
    });

    test("merge on a closed PR is refused as a domain failure", async () => {
      const { merge } = await harness.make();
      const pr = await merge.prCreate({ title: "Abandoned", source: "t/3", target: "dev" });
      await merge.prClose(pr.id);
      expect(merge.prMerge(pr.id)).rejects.toThrow();
      expect((await merge.prGet(pr.id)).state).toBe("closed");
    });

    test("close and reopen round-trip", async () => {
      const { merge } = await harness.make();
      const pr = await merge.prCreate({ title: "Maybe later", source: "t/4", target: "dev" });
      await merge.prClose(pr.id);
      expect((await merge.prGet(pr.id)).state).toBe("closed");
      await merge.prReopen(pr.id);
      expect((await merge.prGet(pr.id)).state).toBe("open");
    });
  });
}

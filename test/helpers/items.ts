import type { User, WorkItem } from "../../src/model/types.ts";

export const alice: User = { id: "1", username: "alice", name: "Alice Aydın" };
export const bob: User = { id: "2", username: "bob", name: "Bob Bulut" };
export const mehmet: User = { id: "3", username: "mehmet", name: "Mehmet Yılmaz" };

let counter = 1000;

export function makeItem(partial: Partial<WorkItem> & { id?: string }): WorkItem {
  const id = partial.id ?? String(counter++);
  return {
    id,
    kind: "task",
    title: `Item ${id}`,
    state: "open",
    labels: [],
    assignees: [],
    author: alice,
    parent: null,
    blockedBy: [],
    url: `https://example.test/items/${id}`,
    description: "",
    updatedAt: "2026-06-10T10:00:00Z",
    timeSpentSeconds: 0,
    timeEstimateSeconds: 0,
    ...partial,
  };
}

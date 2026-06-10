import type { User, WorkItem } from "../model/types.ts";

/** Stable JSON shape for a work item (debug `raw` payload stripped). */
export function itemToJson(item: WorkItem): Omit<WorkItem, "raw"> {
  const { raw: _raw, ...publicItem } = item;
  return publicItem;
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

const formatUsers = (users: User[]) => users.map((u) => `@${u.username}`).join(",");

/** One line per item: #id [state] title (@assignees) {labels}. */
export function printItemLines(items: WorkItem[]): void {
  for (const item of items) {
    const parts = [`#${item.id}`, `[${item.state}]`, item.title];
    if (item.assignees.length) parts.push(`(${formatUsers(item.assignees)})`);
    if (item.labels.length) parts.push(`{${item.labels.join(", ")}}`);
    console.log(parts.join("\t"));
  }
}

export function printItemDetail(item: WorkItem, blocks: string[]): void {
  console.log(`#${item.id}\t${item.title}\t[${item.state}]`);
  console.log(`url:        ${item.url}`);
  console.log(`kind:       ${item.kind}`);
  console.log(`labels:     ${item.labels.join(", ") || "-"}`);
  console.log(`assignees:  ${formatUsers(item.assignees) || "-"}`);
  console.log(`author:     ${item.author ? `@${item.author.username}` : "-"}`);
  console.log(`parent:     ${item.parent ? `#${item.parent}` : "-"}`);
  console.log(`blocked by: ${item.blockedBy.map((b) => `#${b}`).join(", ") || "-"}`);
  console.log(`blocks:     ${blocks.map((b) => `#${b}`).join(", ") || "-"}`);
  console.log(`updated:    ${item.updatedAt}`);
  if (item.description) {
    console.log("---");
    console.log(item.description);
  }
}

export function printUsers(users: User[]): void {
  for (const u of users) console.log(`${u.id}\t@${u.username}\t${u.name ?? ""}`);
}

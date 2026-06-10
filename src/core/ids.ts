import { UsageError } from "../errors.ts";
import type { ItemId } from "../model/types.ts";

/** Accept "#42" or "42" (or "PROJ-1" for future providers); strip the display hash. */
export function normalizeId(input: string | undefined): ItemId {
  const id = (input ?? "").trim().replace(/^#/, "");
  if (!id) throw new UsageError("an item id is required (e.g. 42 or #42)");
  return id;
}

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ItemId, User, WorkItem } from "../model/types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  state       TEXT NOT NULL,
  labels      TEXT NOT NULL,
  assignees   TEXT NOT NULL,
  author      TEXT,
  parent      TEXT,
  url         TEXT NOT NULL,
  description TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  time_spent    INTEGER NOT NULL DEFAULT 0,
  time_estimate INTEGER NOT NULL DEFAULT 0,
  raw         TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent);
CREATE TABLE IF NOT EXISTS links (
  blocker TEXT NOT NULL,
  blocked TEXT NOT NULL,
  PRIMARY KEY (blocker, blocked)
);
CREATE INDEX IF NOT EXISTS idx_links_blocked ON links(blocked);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(id UNINDEXED, title, description);
`;

interface ItemRow {
  id: string;
  provider: string;
  kind: string;
  title: string;
  state: string;
  labels: string;
  assignees: string;
  author: string | null;
  parent: string | null;
  url: string;
  description: string;
  updated_at: string;
  time_spent: number;
  time_estimate: number;
}

export class Cache {
  private db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(SCHEMA);
    // Migrations for caches created before these columns existed.
    for (const col of [
      "time_spent INTEGER NOT NULL DEFAULT 0",
      "time_estimate INTEGER NOT NULL DEFAULT 0",
    ]) {
      try {
        this.db.exec(`ALTER TABLE items ADD COLUMN ${col}`);
      } catch {
        // column already exists
      }
    }
  }

  /** Atomically replace the whole snapshot (sync writes the complete state). */
  replaceAll(items: WorkItem[], provider: string): void {
    const insertItem = this.db.prepare(
      `INSERT INTO items (id, provider, kind, title, state, labels, assignees, author, parent, url, description, updated_at, time_spent, time_estimate, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertLink = this.db.prepare(
      "INSERT OR IGNORE INTO links (blocker, blocked) VALUES (?, ?)",
    );
    const insertFts = this.db.prepare(
      "INSERT INTO items_fts (id, title, description) VALUES (?, ?, ?)",
    );
    const tx = this.db.transaction(() => {
      this.db.exec("DELETE FROM items; DELETE FROM links; DELETE FROM items_fts;");
      for (const item of items) {
        insertItem.run(
          item.id,
          provider,
          item.kind,
          item.title,
          item.state,
          JSON.stringify(item.labels),
          JSON.stringify(item.assignees),
          item.author ? JSON.stringify(item.author) : null,
          item.parent,
          item.url,
          item.description,
          item.updatedAt,
          item.timeSpentSeconds,
          item.timeEstimateSeconds,
          item.raw === undefined ? null : JSON.stringify(item.raw),
        );
        for (const blocker of item.blockedBy) insertLink.run(blocker, item.id);
        insertFts.run(item.id, item.title, item.description);
      }
    });
    tx();
  }

  private rowToItem(row: ItemRow): WorkItem {
    return {
      id: row.id,
      kind: row.kind as WorkItem["kind"],
      title: row.title,
      state: row.state as WorkItem["state"],
      labels: JSON.parse(row.labels) as string[],
      assignees: JSON.parse(row.assignees) as User[],
      author: row.author ? (JSON.parse(row.author) as User) : null,
      parent: row.parent,
      blockedBy: this.blockersOf(row.id),
      url: row.url,
      description: row.description,
      updatedAt: row.updated_at,
      timeSpentSeconds: row.time_spent,
      timeEstimateSeconds: row.time_estimate,
    };
  }

  private blockersOf(id: ItemId): ItemId[] {
    return this.db
      .query<{ blocker: string }, [string]>(
        "SELECT blocker FROM links WHERE blocked = ? ORDER BY blocker",
      )
      .all(id)
      .map((r) => r.blocker);
  }

  getItem(id: ItemId): WorkItem | null {
    const row = this.db.query<ItemRow, [string]>("SELECT * FROM items WHERE id = ?").get(id);
    return row ? this.rowToItem(row) : null;
  }

  getRaw(id: ItemId): unknown {
    const row = this.db
      .query<{ raw: string | null }, [string]>("SELECT raw FROM items WHERE id = ?")
      .get(id);
    return row?.raw ? JSON.parse(row.raw) : null;
  }

  allItems(): WorkItem[] {
    return this.db
      .query<ItemRow, []>("SELECT * FROM items ORDER BY CAST(id AS INTEGER), id")
      .all()
      .map((row) => this.rowToItem(row));
  }

  childrenOf(parent: ItemId): WorkItem[] {
    return this.db
      .query<ItemRow, [string]>(
        "SELECT * FROM items WHERE parent = ? ORDER BY CAST(id AS INTEGER), id",
      )
      .all(parent)
      .map((row) => this.rowToItem(row));
  }

  count(): number {
    const row = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM items").get();
    return row?.n ?? 0;
  }

  /** Full-text match over title+description; returns matching item ids. */
  searchText(text: string): Set<ItemId> {
    const query = text
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replaceAll('"', '""')}"`)
      .join(" ");
    if (!query) return new Set();
    const rows = this.db
      .query<{ id: string }, [string]>("SELECT id FROM items_fts WHERE items_fts MATCH ?")
      .all(query);
    return new Set(rows.map((r) => r.id));
  }

  metaGet(key: string): string | null {
    const row = this.db
      .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get(key);
    return row?.value ?? null;
  }

  metaSet(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  markSynced(nowMs: number): void {
    this.metaSet("last_sync_at", String(nowMs));
  }

  lastSyncAt(): number | null {
    const v = this.metaGet("last_sync_at");
    return v === null ? null : Number(v);
  }

  isStale(nowMs: number, staleMs: number): boolean {
    const last = this.lastSyncAt();
    return last === null || nowMs - last > staleMs;
  }

  close(): void {
    this.db.close();
  }
}

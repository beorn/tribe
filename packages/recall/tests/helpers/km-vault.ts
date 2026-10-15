/**
 * A km vault store for recall tests: the `nodes` table plus the external-content `nodes_fts` index, as km declares
 * them (km/packages/km-storage/src/db/schema.ts), in the default journal mode so a read-only open needs no sidecars.
 */
import { assertSingleStatement } from "@bearly/sqlite"
import { Database } from "bun:sqlite"
import { join } from "node:path"

export interface VaultNode {
  id: string
  fsPath: string
  title: string
  content: string
}

/** Write a vault store holding `nodes` at `<dir>/state.db` and return its path. */
export function makeKmVault(dir: string, nodes: VaultNode[]): string {
  const path = join(dir, "state.db")
  const db = new Database(path)
  try {
    for (const sql of [
      "CREATE TABLE nodes (rowid INTEGER PRIMARY KEY, id TEXT, parent_id TEXT, fs_path TEXT, name TEXT, title TEXT, content TEXT)",
      "CREATE VIRTUAL TABLE nodes_fts USING fts5(id, name, title, content, content='nodes', content_rowid='rowid', prefix='2,3,4', tokenize='unicode61 tokenchars ''@#+~''')",
      "CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN INSERT INTO nodes_fts(rowid, id, name, title, content) VALUES (new.rowid, new.id, new.name, new.title, new.content); END",
    ]) {
      db.exec(assertSingleStatement(sql))
    }
    const insert = db.prepare("INSERT INTO nodes (id, fs_path, name, title, content) VALUES (?, ?, ?, ?, ?)")
    for (const node of nodes) {
      insert.run(node.id, node.fsPath, node.id.split("/").at(-1) ?? node.id, node.title, node.content)
    }
  } finally {
    db.close()
  }
  return path
}

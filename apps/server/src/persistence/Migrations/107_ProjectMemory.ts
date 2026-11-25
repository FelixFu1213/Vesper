import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One row per project: its structured memory entries and their rendered plain-text projection.
  // A project with no row has no memory, and clearing every entry deletes the row.
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_memory (
      project_id TEXT PRIMARY KEY,
      format TEXT NOT NULL DEFAULT 'entries-v1',
      entries_json TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});

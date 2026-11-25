import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pi_native_thread_records (
      provider_thread_id TEXT NOT NULL,
      id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      turn_index INTEGER NOT NULL,
      role TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      message_json TEXT NOT NULL,
      system_version INTEGER,
      system_before_message_id TEXT,
      system_after_message_id TEXT,
      PRIMARY KEY (provider_thread_id, id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pi_native_thread_records_thread
      ON pi_native_thread_records (provider_thread_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pi_native_thread_records_sequence
      ON pi_native_thread_records (provider_thread_id, sequence)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pi_native_thread_records_turn
      ON pi_native_thread_records (provider_thread_id, turn_index)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pi_native_checkpoints (
      provider_thread_id TEXT PRIMARY KEY,
      through_message_id TEXT,
      mode TEXT NOT NULL,
      summary TEXT NOT NULL,
      leading_system_json TEXT,
      retained_messages_json TEXT NOT NULL,
      summarized_message_count INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      used_fallback INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pi_native_checkpoints_thread
      ON pi_native_checkpoints (provider_thread_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pi_native_thread_meta (
      provider_thread_id TEXT PRIMARY KEY,
      todos_json TEXT,
      context_text TEXT,
      activated_tool_names_json TEXT NOT NULL DEFAULT '[]',
      updated_at_ms INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pi_native_thread_meta_thread
      ON pi_native_thread_meta (provider_thread_id)
  `;
});

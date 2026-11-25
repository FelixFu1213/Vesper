import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, describe, it } from "@effect/vitest";
import { PROJECT_MEMORY_MAX_BYTES, ProjectId, type ProjectMemoryEntry } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectMemoryService from "./ProjectMemoryService.ts";

const projectId = ProjectId.make("project:memory");
const missingProjectId = ProjectId.make("project:missing");

const projectLayer = Layer.succeed(
  ProjectService.ProjectService,
  ProjectService.ProjectService.of({
    getById: (id: ProjectId) =>
      Effect.succeed(id === projectId ? Option.some({ id } as never) : Option.none()),
  } as unknown as ProjectService.ProjectService["Service"]),
);

const sqlLayer = NodeSqliteClient.layer({ filename: ":memory:" });
const memoryLayer = ProjectMemoryService.layer.pipe(
  Layer.provide(projectLayer),
  Layer.provide(sqlLayer),
);

const withMemory = <A, E>(
  effect: Effect.Effect<A, E, ProjectMemoryService.ProjectMemoryService | SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(Layer.merge(memoryLayer, sqlLayer)));

const entry = (id: string, title: string, content: string): ProjectMemoryEntry => ({
  id,
  title,
  content,
});

describe("ProjectMemoryService", () => {
  it.effect("reads an empty memory for a project that has none", () =>
    withMemory(
      Effect.gen(function* () {
        yield* runMigrations();
        const memory = yield* ProjectMemoryService.ProjectMemoryService;
        assert.deepStrictEqual(yield* memory.get(projectId), {
          projectId,
          content: "",
          entries: [],
          updatedAt: null,
        });
      }),
    ),
  );

  it.effect("trims entries, drops empty ones, and renders titles", () =>
    withMemory(
      Effect.gen(function* () {
        yield* runMigrations();
        const service = yield* ProjectMemoryService.ProjectMemoryService;
        const saved = yield* service.set(projectId, [
          entry(" one ", "  Conventions  ", "  Use tabs.  "),
          entry("two", "", "  No title here.  "),
          entry("dropped", "Empty", "   "),
        ]);

        assert.deepStrictEqual(saved.entries, [
          { id: "one", title: "Conventions", content: "Use tabs." },
          { id: "two", title: "", content: "No title here." },
        ]);
        assert.strictEqual(saved.content, "## Conventions\n\nUse tabs.\n\nNo title here.");
        assert.isString(saved.updatedAt);
        assert.deepStrictEqual(yield* service.get(projectId), saved);
      }),
    ),
  );

  it.effect("reads a content-only row as one untitled legacy entry", () =>
    withMemory(
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO project_memory (project_id, format, entries_json, content, updated_at)
          VALUES (${projectId}, 'content-v1', 'null', 'Legacy note.', '2026-01-01T00:00:00.000Z')
        `;
        const service = yield* ProjectMemoryService.ProjectMemoryService;
        const memory = yield* service.get(projectId);
        assert.deepStrictEqual(memory.entries, [
          { id: "legacy-project-memory", title: "", content: "Legacy note." },
        ]);
        assert.strictEqual(memory.content, "Legacy note.");
        assert.strictEqual(memory.updatedAt, "2026-01-01T00:00:00.000Z");
      }),
    ),
  );

  it.effect("clears the row when every entry is empty", () =>
    withMemory(
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const service = yield* ProjectMemoryService.ProjectMemoryService;
        yield* service.set(projectId, [entry("note", "", "Something.")]);

        const cleared = yield* service.set(projectId, [entry("note", "", "   ")]);
        assert.deepStrictEqual(cleared, {
          projectId,
          content: "",
          entries: [],
          updatedAt: null,
        });
        const rows = yield* sql`SELECT project_id FROM project_memory`;
        assert.strictEqual(rows.length, 0);
      }),
    ),
  );

  it.effect("refuses a project that does not exist", () =>
    withMemory(
      Effect.gen(function* () {
        yield* runMigrations();
        const service = yield* ProjectMemoryService.ProjectMemoryService;
        const error = yield* service
          .set(missingProjectId, [entry("note", "", "Text.")])
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "ProjectMemoryError");
        assert.strictEqual(error.message, "The project was not found.");
      }),
    ),
  );

  it.effect("refuses an entry without an id", () =>
    withMemory(
      Effect.gen(function* () {
        yield* runMigrations();
        const service = yield* ProjectMemoryService.ProjectMemoryService;
        const error = yield* service.set(projectId, [entry("   ", "", "Text.")]).pipe(Effect.flip);
        assert.strictEqual(error.message, "Every project memory entry needs an id.");
      }),
    ),
  );

  it.effect("refuses rendered memory over the byte ceiling", () =>
    withMemory(
      Effect.gen(function* () {
        yield* runMigrations();
        const service = yield* ProjectMemoryService.ProjectMemoryService;
        const error = yield* service
          .set(projectId, [entry("big", "", "x".repeat(PROJECT_MEMORY_MAX_BYTES + 1))])
          .pipe(Effect.flip);
        assert.strictEqual(
          error.message,
          `Project memory must stay under ${PROJECT_MEMORY_MAX_BYTES} bytes.`,
        );
      }),
    ),
  );

  it.effect("deletes idempotently", () =>
    withMemory(
      Effect.gen(function* () {
        yield* runMigrations();
        const service = yield* ProjectMemoryService.ProjectMemoryService;
        yield* service.set(projectId, [entry("note", "", "Text.")]);
        yield* service.delete(projectId);
        yield* service.delete(projectId);
        assert.strictEqual((yield* service.get(projectId)).content, "");
      }),
    ),
  );
});

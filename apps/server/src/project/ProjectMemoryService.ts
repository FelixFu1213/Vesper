import {
  PROJECT_MEMORY_MAX_BYTES,
  ProjectId,
  ProjectMemoryEntry,
  ProjectMemoryError,
  type ProjectMemory,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

const FORMAT = "entries-v1";
/** A row from a content-only writer reads back as one untitled entry. */
const LEGACY_ENTRY_ID = "legacy-project-memory";

const MemoryRow = Schema.Struct({
  projectId: ProjectId,
  format: Schema.String,
  entriesJson: Schema.String,
  content: Schema.String,
  updatedAt: Schema.String,
});

const decodeEntries = Schema.decodeUnknownOption(Schema.Array(ProjectMemoryEntry));

const emptyMemory = (projectId: ProjectId): ProjectMemory => ({
  projectId,
  content: "",
  entries: [],
  updatedAt: null,
});

const renderEntries = (entries: ReadonlyArray<ProjectMemoryEntry>): string =>
  entries
    .map((entry) => (entry.title === "" ? entry.content : `## ${entry.title}\n\n${entry.content}`))
    .join("\n\n");

const encodeEntries = (entries: ReadonlyArray<ProjectMemoryEntry>): string =>
  JSON.stringify(entries);

const failure = (projectId: ProjectId, message: string, cause?: unknown): ProjectMemoryError =>
  new ProjectMemoryError({
    projectId,
    message,
    ...(cause === undefined ? {} : { cause }),
  });

export class ProjectMemoryService extends Context.Service<
  ProjectMemoryService,
  {
    readonly get: (projectId: ProjectId) => Effect.Effect<ProjectMemory, ProjectMemoryError>;
    readonly set: (
      projectId: ProjectId,
      entries: ReadonlyArray<ProjectMemoryEntry>,
    ) => Effect.Effect<ProjectMemory, ProjectMemoryError>;
    /** Idempotent; a project with no memory has nothing to delete. */
    readonly delete: (projectId: ProjectId) => Effect.Effect<void, ProjectMemoryError>;
  }
>()("t3/project/ProjectMemoryService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;

  const get = Effect.fn("ProjectMemoryService.get")(function* (projectId: ProjectId) {
    const rows = yield* sql<typeof MemoryRow.Type>`
      SELECT project_id AS "projectId", format, entries_json AS "entriesJson",
        content, updated_at AS "updatedAt"
      FROM project_memory
      WHERE project_id = ${projectId}
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        failure(projectId, "Could not read this project's memory.", cause),
      ),
    );
    const row = rows[0];
    if (row === undefined) return emptyMemory(projectId);

    const decoded =
      row.format === FORMAT
        ? Option.getOrUndefined(decodeEntries(safeJson(row.entriesJson)))
        : undefined;
    const legacy =
      decoded === undefined || decoded.length === 0
        ? row.content.trim() === ""
          ? []
          : [{ id: LEGACY_ENTRY_ID, title: "", content: row.content.trim() }]
        : undefined;
    return {
      projectId,
      content: row.content,
      entries: decoded === undefined || decoded.length === 0 ? (legacy ?? []) : decoded,
      updatedAt: row.updatedAt,
    } satisfies ProjectMemory;
  });

  const set = Effect.fn("ProjectMemoryService.set")(function* (
    projectId: ProjectId,
    rawEntries: ReadonlyArray<ProjectMemoryEntry>,
  ) {
    const existing = yield* projects
      .get(projectId)
      .pipe(
        Effect.mapError((cause) => failure(projectId, "Could not verify this project.", cause)),
      );
    if (Option.isNone(existing)) {
      return yield* failure(projectId, "The project was not found.");
    }

    const entries: ProjectMemoryEntry[] = [];
    for (const raw of rawEntries) {
      const id = raw.id.trim();
      const title = raw.title.trim();
      const content = raw.content.trim();
      if (content === "") continue;
      if (id === "") {
        return yield* failure(projectId, "Every project memory entry needs an id.");
      }
      entries.push({ id, title, content });
    }

    if (entries.length === 0) {
      yield* sql`DELETE FROM project_memory WHERE project_id = ${projectId}`.pipe(
        Effect.mapError((cause) =>
          failure(projectId, "Could not clear this project's memory.", cause),
        ),
      );
      return emptyMemory(projectId);
    }

    const content = renderEntries(entries);
    if (Buffer.byteLength(content, "utf8") > PROJECT_MEMORY_MAX_BYTES) {
      return yield* failure(
        projectId,
        `Project memory must stay under ${PROJECT_MEMORY_MAX_BYTES} bytes.`,
      );
    }

    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO project_memory (project_id, format, entries_json, content, updated_at)
      VALUES (${projectId}, ${FORMAT}, ${encodeEntries(entries)}, ${content}, ${updatedAt})
      ON CONFLICT (project_id) DO UPDATE SET
        format = excluded.format,
        entries_json = excluded.entries_json,
        content = excluded.content,
        updated_at = excluded.updated_at
    `.pipe(
      Effect.mapError((cause) =>
        failure(projectId, "Could not save this project's memory.", cause),
      ),
    );
    return { projectId, content, entries, updatedAt } satisfies ProjectMemory;
  });

  const remove = Effect.fn("ProjectMemoryService.delete")(function* (projectId: ProjectId) {
    yield* sql`DELETE FROM project_memory WHERE project_id = ${projectId}`.pipe(
      Effect.mapError((cause) =>
        failure(projectId, "Could not delete this project's memory.", cause),
      ),
    );
  });

  return ProjectMemoryService.of({ get, set, delete: remove });
});

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export const layer = Layer.effect(ProjectMemoryService, make);

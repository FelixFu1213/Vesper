import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { assert, describe, it } from "@effect/vitest";

import type { PersistedTranscriptRecord } from "./sessionStore.ts";
import {
  orderSystemRows,
  serializeSystemMessage,
  SystemTranscriptJournal,
} from "./systemTranscriptJournal.ts";

const record = (
  id: string,
  role: PersistedTranscriptRecord["role"],
  message: AgentMessage,
  options?: {
    readonly sequence?: number;
    readonly beforeMessageId?: string;
    readonly afterMessageId?: string;
  },
): PersistedTranscriptRecord => ({
  id,
  providerThreadId: "thread",
  sequence: options?.sequence ?? 0,
  turnIndex: role === "system" ? -1 : 0,
  role,
  timestampMs: message.timestamp,
  messageJson: JSON.stringify(message),
  system:
    role === "system"
      ? {
          version: 1,
          beforeMessageId: options?.beforeMessageId ?? null,
          afterMessageId: options?.afterMessageId ?? null,
        }
      : null,
});

const user = (text: string, timestamp = 1): AgentMessage => ({
  role: "user",
  content: text,
  timestamp,
});

const system = (text: string, timestamp = 1): SystemMessage => ({
  role: "system",
  content: text,
  timestamp,
});

describe("orderSystemRows", () => {
  it("moves a declaration back before the user row that arrived first", () => {
    const rows = orderSystemRows([
      record("u1", "user", user("first", 1), { sequence: 0 }),
      record("s1", "system", system("delta", 2), {
        sequence: 1,
        beforeMessageId: "u1",
      }),
    ]);
    assert.deepStrictEqual(
      rows.map((row) => row.id),
      ["s1", "u1"],
    );
  });

  it("drops a duplicate declaration and keeps the remaining order", () => {
    const declaration = system("same", 2);
    const rows = orderSystemRows([
      record("u1", "user", user("first", 1), { sequence: 0 }),
      record("s1", "system", declaration, { sequence: 1, afterMessageId: "u1" }),
      record("s2", "system", declaration, { sequence: 2, afterMessageId: "u1" }),
      record("u2", "user", user("second", 3), { sequence: 3 }),
    ]);
    assert.deepStrictEqual(
      rows.map((row) => row.id),
      ["u1", "s1", "u2"],
    );
  });
});

describe("SystemTranscriptJournal", () => {
  it("declares neighbours and never persists a folded request body", () => {
    const leading = system("base prompt", 1);
    const delta = system("", 2);
    delta.sections = { context: "new context" };
    const messages: AgentMessage[] = [leading, user("first", 3), delta];
    const ids = new Map<AgentMessage, string>([[messages[1] as AgentMessage, "u1"]]);
    const journal = new SystemTranscriptJournal();
    let nextId = 0;
    const declarations = journal.declare(
      messages,
      (message) => ids.get(message),
      () => `s${++nextId}`,
    );
    assert.lengthOf(declarations, 2);
    assert.deepStrictEqual(
      declarations.map((declaration) => ({
        id: declaration.id,
        before: declaration.beforeMessageId,
        after: declaration.afterMessageId,
      })),
      [
        { id: "s1", before: "u1", after: null },
        { id: "s2", before: null, after: "u1" },
      ],
    );
    const serialized = serializeSystemMessage(delta);
    assert.include(serialized, "new context");
    assert.notInclude(serialized, "base prompt");
    for (const declaration of declarations) {
      journal.markPersisted(declaration.message, declaration.id);
    }
    assert.isTrue(journal.isPersisted(leading));
    assert.deepStrictEqual(
      journal.declare(
        messages,
        (message) => ids.get(message),
        () => "s2",
      ),
      [],
    );
  });
});

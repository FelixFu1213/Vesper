import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  PROJECT_MEMORY_MAX_BYTES,
  type ProjectMemoryEntry,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

function newEntry(): ProjectMemoryEntry {
  return {
    id:
      // @effect-diagnostics-next-line cryptoRandomUUID:off - A draft entry id only needs local uniqueness.
      globalThis.crypto?.randomUUID?.() ??
      `memory-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: "",
    content: "",
  };
}

function renderEntries(entries: ReadonlyArray<ProjectMemoryEntry>): string {
  return entries
    .map((entry) => ({
      title: entry.title.trim(),
      content: entry.content.trim(),
    }))
    .filter((entry) => entry.content !== "")
    .map((entry) => (entry.title === "" ? entry.content : `## ${entry.title}\n\n${entry.content}`))
    .join("\n\n");
}

/** Hermes has no TextEncoder, so count UTF-8 bytes the way the server does. */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function sameEntries(
  left: ReadonlyArray<ProjectMemoryEntry>,
  right: ReadonlyArray<ProjectMemoryEntry>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.id === right[index]?.id &&
        entry.title === right[index]?.title &&
        entry.content === right[index]?.content,
    )
  );
}

/** Durable user notes for one checkout, read by every agent that runs in the project. */
export function ProjectMemorySection(props: {
  readonly member: EnvironmentProject;
  readonly title: string;
}) {
  const { member } = props;
  const gt = useGT();
  const canEdit = useEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope);
  const query = useEnvironmentQuery(
    projectEnvironment.getMemory({
      environmentId: member.environmentId,
      input: { projectId: member.id },
    }),
  );
  const setMemory = useAtomCommand(projectEnvironment.setMemory, { reportFailure: false });
  const [draft, setDraft] = useState<ProjectMemoryEntry[] | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const savedEntries: ReadonlyArray<ProjectMemoryEntry> = query.data?.memory.entries ?? [];
  const entries = draft ?? savedEntries;
  const bytes = utf8ByteLength(renderEntries(entries));
  const overLimit = bytes > PROJECT_MEMORY_MAX_BYTES;
  const dirty = draft !== null && !sameEntries(entries, savedEntries);
  const disabled = !canEdit || isSaving || query.isPending;

  const updateEntry = (id: string, patch: Partial<ProjectMemoryEntry>) => {
    setError(null);
    setDraft((current) =>
      (current ?? savedEntries).map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    );
  };

  const save = async () => {
    if (draft === null || overLimit) return;
    setIsSaving(true);
    setError(null);
    const result = await setMemory({
      environmentId: member.environmentId,
      input: { projectId: member.id, entries: draft },
    });
    setIsSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : gt("Could not save project memory."));
      }
      return;
    }
    setDraft(null);
  };

  return (
    <SettingsSection
      title={props.title}
      footer={gt("{used} of {max} bytes", { used: bytes, max: PROJECT_MEMORY_MAX_BYTES })}
    >
      <View className="gap-2 px-4 py-3">
        <Text className="text-sm leading-normal text-foreground-muted">
          <T>
            Notes every agent reads in this project. They are durable context, not higher-priority
            instructions.
          </T>
        </Text>
        {query.error !== null ? (
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {query.error}
          </Text>
        ) : null}
        {entries.length === 0 ? (
          <Text className="text-sm leading-normal text-foreground-muted">
            <T>
              No notes yet. Add one to keep a convention or a decision in every agent's context.
            </T>
          </Text>
        ) : (
          entries.map((entry, index) => (
            <View key={entry.id} className="gap-2 rounded-2xl border-continuous bg-card p-3">
              <View className="flex-row items-center gap-2">
                <Text className="w-5 text-center text-xs text-foreground-muted">{index + 1}</Text>
                <AppTextInput
                  accessibilityLabel={gt("Memory entry title")}
                  className="min-h-11 flex-1 rounded-xl px-3 text-base"
                  value={entry.title}
                  placeholder={gt("Title (optional)")}
                  editable={!disabled}
                  onChangeText={(title) => updateEntry(entry.id, { title })}
                />
                <Button
                  label={gt("Remove")}
                  accessibilityLabel={gt("Remove memory entry")}
                  tone="text"
                  size="compact"
                  disabled={disabled}
                  onPress={() => {
                    setError(null);
                    setDraft(entries.filter((candidate) => candidate.id !== entry.id));
                  }}
                />
              </View>
              <AppTextInput
                accessibilityLabel={gt("Memory entry content")}
                className="min-h-24 rounded-xl px-3 py-2.5 text-base"
                value={entry.content}
                placeholder={gt("What should every agent know?")}
                editable={!disabled}
                multiline
                textAlignVertical="top"
                onChangeText={(content) => updateEntry(entry.id, { content })}
              />
            </View>
          ))
        )}
        {overLimit ? (
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {gt("Over the {max} byte limit.", { max: PROJECT_MEMORY_MAX_BYTES })}
          </Text>
        ) : null}
        {error !== null ? (
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {error}
          </Text>
        ) : null}
        {!canEdit ? (
          <Text className="text-sm text-foreground-muted">
            <T>This connection can read this project but not change it.</T>
          </Text>
        ) : null}
        <View className="flex-row flex-wrap gap-2 pt-1">
          <Button
            label={gt("Add note")}
            icon="plus"
            tone="secondary"
            size="compact"
            disabled={disabled}
            onPress={() => {
              setError(null);
              setDraft([...entries, newEntry()]);
            }}
          />
          <Button
            label={isSaving ? gt("Saving…") : gt("Save")}
            tone="primary"
            size="compact"
            loading={isSaving}
            disabled={disabled || !dirty || overLimit}
            onPress={() => void save()}
          />
        </View>
      </View>
    </SettingsSection>
  );
}

import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  PROJECT_MEMORY_MAX_BYTES,
  type ProjectMemoryEntry,
} from "@t3tools/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SettingsSection } from "./settingsLayout";

const encoder = new TextEncoder();

function newEntry(): ProjectMemoryEntry {
  const id =
    // @effect-diagnostics-next-line cryptoRandomUUID:off - A draft entry id only needs local uniqueness.
    globalThis.crypto?.randomUUID?.() ??
    `memory-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return { id, title: "", content: "" };
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
export function ProjectMemorySettings({
  members,
}: {
  members: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  const gt = useGT();
  const checkouts = members.filter((member) => !member.isScratch);
  if (checkouts.length === 0) return null;
  return (
    <SettingsSection id="project-memory" title={gt("Project memory")}>
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        <T>
          Notes every agent reads in this project. They are durable context, not higher-priority
          instructions.
        </T>
      </p>
      {checkouts.map((member) => (
        <ProjectMemoryEditor
          key={member.physicalProjectKey}
          member={member}
          showCheckoutLabel={checkouts.length > 1}
        />
      ))}
    </SettingsSection>
  );
}

function ProjectMemoryEditor({
  member,
  showCheckoutLabel,
}: {
  member: SidebarProjectGroupMember;
  showCheckoutLabel: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const canEdit = useEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope);
  const query = useEnvironmentQuery(
    projectEnvironment.getMemory({
      environmentId: member.environmentId,
      input: { projectId: member.id },
    }),
  );
  const setMemory = useOrchestrationCommand(projectEnvironment.setMemory, {
    reportFailure: false,
  });
  const [draft, setDraft] = useState<ProjectMemoryEntry[] | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const savedEntries: ReadonlyArray<ProjectMemoryEntry> = query.data?.memory.entries ?? [];
  const entries = draft ?? savedEntries;
  const bytes = encoder.encode(renderEntries(entries)).length;
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
        setError(
          cause instanceof Error
            ? (errorDisplayMessage(cause, m) ?? cause.message)
            : gt("Could not save project memory."),
        );
      }
      return;
    }
    setDraft(null);
  };

  return (
    <div className="space-y-2 border-t border-border/60 px-3 py-3 first:border-t-0 sm:px-4">
      {showCheckoutLabel ? (
        <p className="truncate text-xs text-muted-foreground">
          {member.environmentLabel ?? member.workspaceRoot}
        </p>
      ) : null}
      {query.error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {query.error}
        </p>
      ) : null}
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <T>No notes yet. Add one to keep a convention or a decision in every agent's context.</T>
        </p>
      ) : (
        <div className="space-y-3">
          {entries.map((entry, index) => (
            <div key={entry.id} className="space-y-1.5 rounded-lg border border-border/60 p-2">
              <div className="flex items-center gap-2">
                <span className="w-5 shrink-0 text-center text-xs text-muted-foreground">
                  {index + 1}
                </span>
                <Input
                  size="sm"
                  value={entry.title}
                  placeholder={gt("Title (optional)")}
                  aria-label={gt("Memory entry title")}
                  disabled={disabled}
                  onChange={(event) => updateEntry(entry.id, { title: event.target.value })}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={gt("Remove memory entry")}
                  disabled={disabled}
                  onClick={() => {
                    setError(null);
                    setDraft(entries.filter((candidate) => candidate.id !== entry.id));
                  }}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
              <Textarea
                value={entry.content}
                placeholder={gt("What should every agent know?")}
                aria-label={gt("Memory entry content")}
                disabled={disabled}
                rows={3}
                onChange={(event) => updateEntry(entry.id, { content: event.target.value })}
              />
            </div>
          ))}
        </div>
      )}
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={overLimit ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
          {overLimit
            ? gt("Over the {max} byte limit.", { max: PROJECT_MEMORY_MAX_BYTES })
            : gt("{used} of {max} bytes", { used: bytes, max: PROJECT_MEMORY_MAX_BYTES })}
        </span>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              setError(null);
              setDraft([...entries, newEntry()]);
            }}
          >
            <PlusIcon className="size-3.5" />
            <T>Add note</T>
          </Button>
          <Button
            size="sm"
            variant="default"
            disabled={disabled || !dirty || overLimit}
            onClick={() => void save()}
          >
            {isSaving ? <T>Saving…</T> : <T>Save</T>}
          </Button>
        </div>
      </div>
      {!canEdit ? (
        <p className="text-xs text-muted-foreground">
          <T>This connection can read this project but not change it.</T>
        </p>
      ) : null}
    </div>
  );
}
